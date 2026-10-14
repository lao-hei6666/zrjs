'use strict';
/**
 * 大众点评核验：在高德拿到待选场所后，去大众点评按名称搜索，通过三档判定确认为同一场所：
 *   ① 店名比对（归一化后包含即命中）
 *   ② 地址比对（门牌号 + 道路名 + 二元组相似度）
 *   ③ 地标反查（点评地址里的建筑名 → 高德反查该建筑 → 比对门牌号；
 *      例如点评“红莲南路中国文化大厦B1层” ↔ 高德“北京市西城区红莲南路57号1幢-1层”）
 * 营业状态：「休息中」算正常营业；只有歇业 / 关闭 / 暂停营业 / 查不到才算不通过。
 *
 * 说明：大众点评搜索结果卡片只带“商圈”，没有完整街道地址，因此需要打开店铺页读 .addressText。
 */
const { sleep } = require('../pace');
const {
  nameLooseMatch, stripBrackets, addressSimilarity,
  extractBuildings, extractRoadNumber, branchCompatible
} = require('../clean/normalize');

/** 名称命中：品牌包含 + 分店兼容（避免连锁不同分店被误判为同店） */
function sameShopName(amapName, dpName) {
  if (!nameLooseMatch(amapName, dpName)) return false;
  return branchCompatible(amapName, dpName);
}

const CLOSED_RE = /暂停营业|已关闭|商家已关闭|歇业|已停业|停止营业|关店|永久关闭/;
const RESULT_SELECTOR = '#shop-all-list, .shop-list, #shop-list, .shopAllList, [class*=shopList], [class*=shop-list], [class*=searchResult]';
const SEARCH_URL = (query) => `https://www.dianping.com/search/keyword/2/0_${encodeURIComponent(query)}`;

/** 生成搜索用关键词：全名 -> 品牌名（去掉分店后缀） */
function candidateQueries(name) {
  const list = [];
  const full = String(name || '').trim();
  if (full) list.push(full);
  const brand = stripBrackets(full).replace(/[（(].*?[）)]/g, '').trim();
  const brandCore = brand.split(/[·・\s]/).filter(Boolean)[0] || brand;
  if (brand && brand.length >= 2) list.push(brand);
  if (brandCore && brandCore.length >= 2 && brandCore !== brand) list.push(brandCore);
  return [...new Set(list)].slice(0, 3);
}

/** 是否已在大众点评搜索结果页 */
async function onResultPage(page) {
  if (/\/search\/keyword\//.test(page.url())) return true;
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel.split(',')[0]);
      return !!(el && el.querySelector('a[href*="/shop/"]'));
    }, RESULT_SELECTOR);
  } catch (e) {
    return false;
  }
}

/** 解析搜索结果卡片（限定在结果容器内，避免把首页推荐位当结果） */
async function parseShopCards(page) {
  return page.evaluate((containerSel) => {
    let scope = null;
    for (const s of containerSel.split(',').map((x) => x.trim())) {
      const el = document.querySelector(s);
      if (el && el.querySelector('a[href*="/shop/"]')) { scope = el; break; }
    }
    if (!scope) return [];
    const cards = [...scope.querySelectorAll('li')].filter((li) => li.querySelector('a[href*="/shop/"]'));
    const out = [];
    const seen = new Set();
    for (const li of cards) {
      const a = li.querySelector('a[href*="/shop/"]');
      const rawHref = String(a.getAttribute('href') || '').split('?')[0];
      if (!rawHref) continue;
      const href = rawHref.startsWith('http') ? rawHref : `https://www.dianping.com${rawHref}`;
      if (seen.has(href)) continue;
      seen.add(href);
      const nameEl = li.querySelector('.tit a h4, .tit a, [class*=shopName], [class*=shop-name], h4');
      // 统一用 textContent：隐藏元素上 innerText 可能为 undefined，会导致解析整体抛错
      const text = String(li.textContent || '').replace(/\s+/g, ' ').trim();
      const tags = [...li.querySelectorAll('.tag-addr .tag, .tag-addr span')]
        .map((e) => String(e.textContent || '').trim())
        .filter(Boolean);
      out.push({
        href,
        shopId: href.split('/shop/')[1] || '',
        name: String(nameEl ? nameEl.textContent : '').trim().replace(/\s+/g, ' ').slice(0, 60),
        category: tags[0] || '',
        area: tags[1] || '',
        text: text.slice(0, 300),
        // 注意：浏览器上下文里访问不到 Node 侧变量，这里必须是内联正则
        closed: /暂停营业|已关闭|商家已关闭|歇业|已停业|停止营业|关店|永久关闭/.test(text),
        stars: (text.match(/([0-5]\.\d)/) || [])[1] || '',
        reviewCount: (text.match(/(\d+)\s*条(?:评价|点评)/) || [])[1] || ''
      });
    }
    return out.slice(0, 40);
  }, RESULT_SELECTOR);
}

/** 打开店铺页，读取店名 / 完整地址 / 营业状态与时间 */
async function openShopPage(page, href, { pace, logger }) {
  await pace.pace(`打开大众点评店铺页：${href.split('/shop/')[1] || href}`);
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    return { href, error: e.message.split('\n')[0] };
  }
  await page.waitForSelector('.shopName, .addressText, .biz-txt', { timeout: 12000 }).catch(() => {});
  await sleep(1500);
  const info = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.innerText || '').trim() : '';
    };
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    const hours = (body.match(/\d{1,2}:\d{2}\s*[-~—]\s*(次日)?\d{1,2}:\d{2}/) || [])[0] || (/全天营业|24小时/.test(body) ? '24小时营业' : '');
    return {
      url: location.href,
      name: q('.shopName') || q('[class*=shopName]'),
      address: q('.addressText') || q('[class*=addressText]'),
      status: q('.biz-txt') || q('[class*=biz-txt]'),
      hours,
      bodyHead: body.slice(0, 300)
    };
  });
  const closed = CLOSED_RE.test(`${info.status} ${info.bodyHead}`);
  if (logger) logger.info(`店铺页：${info.name}｜${info.address}｜${info.status} ${info.hours}${closed ? '（判定为已关闭）' : ''}`);
  return { href, ...info, closed };
}

/** 地标反查：把点评地址里的建筑名拿去高德搜索，比对门牌号是否一致 */
async function landmarkMatch(page, amapAddress, dianpingText, pace) {
  const buildings = extractBuildings(dianpingText);
  if (!buildings.length) return { hit: false, reason: '点评地址中未识别到建筑名' };
  const amapRoads = extractRoadNumber(amapAddress) || [];
  if (!amapRoads.length) return { hit: false, reason: '高德地址中未识别到门牌号' };
  for (const building of buildings.slice(0, 3)) {
    if (pace) await pace.pace(`高德地标反查：${building}`);
    const url = `https://ditu.amap.com/service/poiInfo?query_type=TQUERY&pagesize=5&pagenum=1&qii=true&cluster_state=5` +
      `&utd_sceneid=1000&div=PC1000&city=110000&keywords=${encodeURIComponent(building)}`;
    const res = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        return { status: r.status, text: await r.text() };
      } catch (e) { return { status: 0, text: '' }; }
    }, url);
    if (res.status !== 200) continue;
    const list = res.text;

    // 方式一：门牌号直接出现在反查结果文本中
    for (const road of amapRoads) {
      const roadName = road.road ? road.road.replace(/[路街巷道]$/, '') : '';
      const pattern = new RegExp(`${roadName ? `${roadName}[^"]{0,8}` : ''}${road.number}\\s*号`);
      if (pattern.test(list)) {
        return { hit: true, building, road: `${roadName}${road.number}号` };
      }
    }

    // 方式二：把反查到的建筑地址与高德 POI 地址做相似度比较（可容忍道路名一字之差）
    try {
      const json = JSON.parse(res.text);
      const items = (json && json.data && json.data.poi_list) || [];
      for (const item of items.slice(0, 3)) {
        const addr = `${item.name || ''} ${item.address || ''}`;
        if (addressSimilarity(amapAddress, addr) >= 0.45 || addressSimilarity(amapAddress, item.address || '') >= 0.45) {
          return { hit: true, building, road: item.address || '' };
        }
      }
    } catch (e) { /* ignore */ }
  }
  return { hit: false, reason: `地标反查未命中（候选建筑：${buildings.slice(0, 3).join('、')}）` };
}

async function searchShops(page, query, { logger, pace }) {
  const input = page.locator('#J-search-input, input[placeholder*="搜索商户名"]').first();
  await pace.pace(`大众点评搜索：${query}`);
  try {
    await input.click({ timeout: 10000 });
    await input.fill('');
    await input.type(query, { delay: 120 });
    await pace.pace(`大众点评提交搜索：${query}`);
    await page.keyboard.press('Enter');
    // 首页回车常只弹联想词，这里等待真正的结果页
    await page.waitForURL(/\/search\/keyword\//, { timeout: 8000 }).catch(() => {});
    await page.waitForSelector(RESULT_SELECTOR, { timeout: 8000 }).catch(() => {});
    await sleep(1500);
  } catch (e) {
    logger.warn(`大众点评搜索框操作失败（${e.message.split('\n')[0]}）`);
  }

  if (!(await onResultPage(page))) {
    await pace.pace(`大众点评直达搜索结果页：${query}`);
    await page.goto(SEARCH_URL(query), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector(RESULT_SELECTOR, { timeout: 10000 }).catch(() => {});
    await sleep(2500);
  }
  let cards = [];
  try {
    cards = await parseShopCards(page);
  } catch (e) {
    logger.warn(`解析大众点评结果失败：${String(e.message || e).split('\n')[0]}`);
  }
  if (!cards.length) {
    // 空结果兜底：直达搜索链接（搜索框流程有时只弹联想词，不会跳转到结果页）
    await pace.pace(`大众点评关键词直达（兜底）：${query}`);
    await page.goto(SEARCH_URL(query), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector(RESULT_SELECTOR, { timeout: 10000 }).catch(() => {});
    await sleep(2500);
    cards = await parseShopCards(page).catch(() => []);
    if (logger) {
      const diag = await page.evaluate((sel) => ({
        url: location.href,
        title: document.title,
        shopLinks: document.querySelectorAll('a[href*="/shop/"]').length,
        container: !!document.querySelector(sel.split(',')[0]),
        captcha: /拖动|滑块|安全验证/.test(document.body.innerText || '')
      }), RESULT_SELECTOR).catch(() => ({}));
      logger.warn(`大众点评“${query}”兜底直达后仍无结果：${JSON.stringify(diag)}`);
    }
  }
  return cards;
}

/**
 * 核验单个场所。
 * @returns {Promise<{ok:boolean, reason:string, method?:string, query?:string, shop?:object, state?:string, tried?:Array}>}
 */
async function verifyOnDianping({ page, poi, cfg, logger, pace, maxShops = 4 }) {
  const threshold = Number(cfg.rules.dianping.addressSimilarityThreshold || 0.34);
  const queries = candidateQueries(poi.name);
  const tried = [];

  for (const query of queries) {
    const cards = await searchShops(page, query, { logger, pace });
    tried.push({ query, count: cards.length });
    if (!cards.length) {
      logger.info(`大众点评搜索“${query}”无结果`);
      continue;
    }

    // 先按店名挑出最像的几个，再补前几位，逐个打开店铺页核对
    const nameHits = cards.filter((c) => sameShopName(poi.name, c.name));
    const ordered = [...nameHits, ...cards.filter((c) => !nameHits.includes(c))].slice(0, maxShops);
    logger.info(`大众点评“${query}”命中 ${cards.length} 条，其中店名相似 ${nameHits.length} 条，将核对 ${ordered.length} 个店铺页`);

    for (const card of ordered) {
      const shop = await openShopPage(page, card.href, { pace, logger });
      if (shop.error) continue;
      if (shop.closed) {
        logger.info(`跳过已关闭门店：${shop.name || card.name}`);
        continue;
      }
      const nameHit = sameShopName(poi.name, shop.name) || sameShopName(poi.name, card.name);
      const addrSim = addressSimilarity(poi.address || '', shop.address || '');
      const addrHit = addrSim >= threshold;

      if (nameHit || addrHit) {
        return {
          ok: true,
          method: nameHit && addrHit ? 'name+address' : (nameHit ? 'name' : 'address'),
          reason: `大众点评同店确认：${shop.name}（${shop.address}）｜地址相似度 ${addrSim}`,
          query,
          shop: { ...shop, ...card, href: card.href },
          state: `营业状态：${shop.status || '未知'}（休息中亦视为正常营业）`
        };
      }

      // 都不匹配时用地标反查（用户描述的“中国文化大厦”法）
      const landmark = await landmarkMatch(page, poi.address || '', `${shop.address} ${shop.name}`, pace);
      if (landmark.hit) {
        logger.ok(`通过地标反查确认同店：${shop.name}（${landmark.building} ↔ ${landmark.road}）`);
        return {
          ok: true,
          method: 'landmark',
          reason: `地标反查确认同店：点评“${shop.name}”地址中的「${landmark.building}」对应高德地址的「${landmark.road}」`,
          query,
          shop: { ...shop, ...card, href: card.href },
          state: '正常营业（休息中亦视为正常营业）'
        };
      }
      logger.info(`未匹配：点评「${shop.name}」(${shop.address})｜名称${nameHit ? '命中' : '不命中'}｜地址相似度 ${addrSim}｜${landmark.reason || ''}`);
    }
  }

  return {
    ok: false,
    reason: `大众点评未找到匹配场所（已尝试关键词：${tried.map((t) => `${t.query}(${t.count}条)`).join('、') || '无'}）`,
    tried
  };
}

module.exports = {
  verifyOnDianping, parseShopCards, candidateQueries, landmarkMatch, openShopPage, searchShops, CLOSED_RE
};
