'use strict';
/**
 * 高德采集：按分类关键词搜索 + 翻页收集候选场所。
 *
 * 取数策略（DOM + 接口双通道）：
 *  1) 浏览器真实打开高德搜索页（可见、登录态、每步间隔 2 秒）；
 *  2) 拦截页面自身的 poiInfo 接口响应，拿到候选场所的名称/地址/经纬度/评分/人均/POI ID；
 *  3) 用捕获到的接口地址按 pagenum 递增翻页（仍在登录态的页面内请求），避免依赖易变的列表 DOM；
 *  4) 若接口被风控（419）或页面提示“未能获取到搜索结果信息”，退回到 DOM 列表读取。
 *
 * 详情（照片数、营业时间）不在这里取，见 detail.js。
 */
const { sleep } = require('../pace');
const { hasCaptcha, waitForCaptchaClear } = require('./browser');

const POI_INFO_RE = /service\/poiInfo/;
const DEFAULT_PAGESIZE = 20;

function htmlToPrice(html) {
  if (!html) return '';
  const m = String(html).replace(/<[^>]+>/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

function normalizeRawPoi(raw) {
  const domain = Array.isArray(raw.domain_list) ? raw.domain_list : [];
  const pick = (name) => (domain.find((d) => d && d.name === name) || {}).value || '';
  const price = htmlToPrice(pick('price'));
  return {
    id: String(raw.id || ''),
    name: String(raw.name || raw.disp_name || '').trim(),
    address: String(raw.address || '').trim(),
    lat: String(raw.latitude || ''),
    lng: String(raw.longitude || ''),
    rating: String(raw.rating || ''),
    reviewTotal: String(raw.review_total || ''),
    adcode: String(raw.adcode || ''),
    cityName: String(raw.cityname || ''),
    typeText: '',
    price,
    cover: String(pick('pic_info') || '')
  };
}

/** 递归从任意 JSON 中提取 POI 列表（兼容接口结构变化） */
function extractPoiList(json, out = [], depth = 0) {
  if (!json || depth > 6) return out;
  if (Array.isArray(json)) {
    if (json.length && json.every((it) => it && typeof it === 'object' && (it.id || it.poiid) && (it.name || it.disp_name))) {
      for (const it of json) out.push(normalizeRawPoi(it));
      return out;
    }
    for (const it of json) extractPoiList(it, out, depth + 1);
    return out;
  }
  if (typeof json === 'object') {
    for (const v of Object.values(json)) extractPoiList(v, out, depth + 1);
  }
  return out;
}

function dedupeById(list) {
  const map = new Map();
  for (const p of list) {
    if (!p.id) continue;
    if (!map.has(p.id)) map.set(p.id, p);
  }
  return [...map.values()];
}

/** 从搜索结果 DOM 中兜底读取候选（接口不可用时） */
async function collectFromDom(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('li.poibox, ul.serp-list > li, [class*=poi-item], [class*=poiItem]')];
    return items.slice(0, 100).map((li) => {
      const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
      const nameEl = li.querySelector('[class*=poi-name], [class*=poiName], .poi-name, h3, .name');
      const addrEl = li.querySelector('[class*=addr], [class*=address], .addr');
      const priceMatch = t.match(/人均[:：]\s*[¥￥]?\s*(\d+)/);
      return {
        id: li.id || '',
        name: (nameEl ? nameEl.innerText : t.split(/\s{2,}|(?=\S*北京市)/)[0] || '').trim().slice(0, 60),
        address: (addrEl ? addrEl.innerText : '').trim(),
        lat: '', lng: '',
        rating: (t.match(/([0-5]\.\d)/) || [])[1] || '',
        reviewTotal: '', adcode: '', cityName: '北京市',
        typeText: '', price: priceMatch ? priceMatch[1] : '', cover: '', fromDom: true
      };
    }).filter((p) => p.name && p.name.length >= 2);
  });
}

function buildPoiInfoUrl(capturedUrl, keyword, pageNum, pageSize) {
  if (capturedUrl) {
    let url = capturedUrl;
    if (/pagenum=\d+/.test(url)) url = url.replace(/pagenum=\d+/, `pagenum=${pageNum}`);
    else url += `&pagenum=${pageNum}`;
    if (/pagesize=\d+/.test(url)) url = url.replace(/pagesize=\d+/, `pagesize=${pageSize}`);
    return url;
  }
  const kw = encodeURIComponent(keyword);
  return `https://ditu.amap.com/service/poiInfo?query_type=TQUERY&pagesize=${pageSize}&pagenum=${pageNum}` +
    `&qii=true&cluster_state=5&need_utd=true&utd_sceneid=1000&div=PC1000&addr_poi_merge=true&is_classify=true` +
    `&zoom=10&city=110000&keywords=${kw}`;
}

function createAmapCollector({ page, cfg, logger, pace, cache }) {
  const pageSize = Number(cfg.rules.pageSize) || DEFAULT_PAGESIZE;
  const maxPages = Number(cfg.rules.maxPagesPerKeyword) || 10;

  /** 在页面内请求接口（带节流与会话 cookie），返回解析后的 JSON 文本 */
  async function fetchJsonInPage(url) {
    return page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include' });
        const text = await res.text();
        return { status: res.status, text };
      } catch (e) {
        return { status: 0, text: `ERR:${e.message}` };
      }
    }, url);
  }

  /**
   * 搜索一个关键词，收集全部候选场所（受 maxPagesPerKeyword 限制）。
   * @returns {Promise<Array>} 候选场所列表
   */
  async function search(keyword) {
    // 断点续采：同一个关键词的候选列表可直接复用，避免重复搜索触发反爬
    const cached = cache ? cache.read('amap-search', keyword, cfg.resume) : null;
    if (cached && Array.isArray(cached.items) && cached.items.length) {
      logger.info(`复用本地缓存的搜索结果：${keyword}（${cached.items.length} 条候选）`);
      return cached.items;
    }

    const captured = [];
    const capturedUrls = [];
    const onResponse = async (res) => {
      try {
        if (!POI_INFO_RE.test(res.url())) return;
        const text = await res.text();
        capturedUrls.push(res.url());
        try { captured.push(JSON.parse(text)); } catch (e) { /* ignore */ }
      } catch (e) { /* ignore */ }
    };
    page.on('response', onResponse);

    const entry = cfg.rules.amap.entryUrl.replace('{kw}', encodeURIComponent(keyword));
    await pace.pace(`打开高德搜索页：${keyword}`);
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4000);

    // 反爬滑块：等待人工拖动完成后自动重载
    if (await hasCaptcha(page)) {
      logger.wait('高德地图出现验证码（滑块/安全校验），请手动拖动完成验证，完成后脚本自动继续…');
      const cleared = await waitForCaptchaClear(page, { site: '高德地图', logger, timeoutMinutes: 10 });
      if (cleared) {
        await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(4000);
      }
    }

    let candidates = dedupeById(captured.flatMap((j) => extractPoiList(j)));

    // SSR 直链失败时改用搜索框真人操作
    if (!candidates.length) {
      const failed = await page.evaluate(() => /未能获取到搜索结果信息/.test(document.body.innerText || '')).catch(() => false);
      logger.warn(failed
        ? '高德 SSR 直链未返回结果（可能触发风控），改用搜索框输入关键词重试'
        : '未捕获到高德搜索接口响应，改用搜索框输入关键词重试');
      try {
        const box = page.locator('input[type=text]:visible').first();
        await pace.pace(`定位搜索框：${keyword}`);
        await box.click({ timeout: 8000 });
        await box.fill('');
        await box.type(keyword, { delay: 120 });
        await pace.pace(`提交搜索：${keyword}`);
        await page.keyboard.press('Enter');
        await sleep(5000);
      } catch (e) {
        logger.warn(`搜索框操作失败：${e.message.split('\n')[0]}`);
      }
      candidates = dedupeById(captured.flatMap((j) => extractPoiList(j)));
    }

    page.off('response', onResponse);

    // DOM 兜底
    if (!candidates.length) {
      const domList = await collectFromDom(page).catch(() => []);
      if (domList.length) {
        logger.info(`接口未取到候选，改为从列表 DOM 读取到 ${domList.length} 条`);
        candidates = domList;
      }
    }

    // 翻页
    if (candidates.length) {
      const template = capturedUrls[0] || '';
      const seen = new Set(candidates.map((c) => c.id));
      let blocked = 0;
      for (let p = 2; p <= maxPages; p += 1) {
        await pace.pace(`高德搜索结果第 ${p} 页：${keyword}`);
        const url = buildPoiInfoUrl(template, keyword, p, pageSize);
        const { status, text } = await fetchJsonInPage(url);
        if (status === 419 || /^x5sec|验证/.test(text.slice(0, 30))) {
          blocked += 1;
          logger.warn(`翻页被风控拦截（状态 ${status}），请留意浏览器窗口是否需要拖动滑块`);
          if (await hasCaptcha(page)) {
            await waitForCaptchaClear(page, { site: '高德地图', logger, timeoutMinutes: 10 });
          }
          await sleep(8000);
          const retry = await fetchJsonInPage(url);
          if (retry.status !== 200) {
            logger.warn(`第 ${p} 页重试仍失败，本关键词翻页结束`);
            break;
          }
          const items = extractPoiList(JSON.parse(retry.text));
          let added = 0;
          for (const it of items) if (!seen.has(it.id)) { seen.add(it.id); candidates.push(it); added += 1; }
          if (!added) break;
          continue;
        }
        if (status !== 200) {
          logger.warn(`第 ${p} 页请求失败（状态 ${status}），本关键词翻页结束`);
          break;
        }
        let json;
        try { json = JSON.parse(text); } catch (e) { break; }
        const items = extractPoiList(json);
        let added = 0;
        for (const it of items) if (!seen.has(it.id)) { seen.add(it.id); candidates.push(it); added += 1; }
        logger.info(`第 ${p} 页新增 ${added} 条（累计 ${candidates.length} 条）`);
        if (added === 0 || items.length < pageSize) break;
      }
      if (blocked) logger.warn(`本关键词共触发 ${blocked} 次风控拦截`);
    }

    if (cache && candidates.length) {
      cache.write('amap-search', keyword, { keyword, fetchedAt: new Date().toISOString(), items: candidates });
    }
    return candidates;
  }

  return { search, fetchJsonInPage, buildPoiInfoUrl };
}

module.exports = { createAmapCollector, extractPoiList, normalizeRawPoi, dedupeById, collectFromDom };
