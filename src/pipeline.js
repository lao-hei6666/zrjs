'use strict';
/**
 * 流水线编排：采集 → 规则过滤 → 大众点评核验 → 清洗去重 → 导出 xlsx。
 *
 * 过滤规则（全部满足才保留）：
 *  1) 名称不与 cs.txt 已有场所重复，且本次采集内部不重复；
 *  2) 分类必须落在 fl.txt 的 12 个分类内（基于 cs.txt 样本学习的规则判定）；
 *  3) 高德封面右下角“照片N” > 5；
 *  4) 非倒闭/关门/歇业，且结束营业时间晚于 23:00；
 *  5) 大众点评能搜到同一场所（名称/地址/地标反查三档判定），休息中也算正常营业。
 */
const { createCache } = require('./cache');
const { loadReference } = require('./data/reference');
const { createClassifier } = require('./data/classifier');
const { createDeduper } = require('./clean/dedupe');
const { createPacer, sleep } = require('./pace');
const {
  createBrowser, waitForLogin, isAmapLoggedIn, isDianpingLoggedIn,
  ensureAmapNewVersion, waitForCaptchaClear, hasCaptcha, resetAmapPunish, disposeBrowser
} = require('./amap/browser');
const { createAmapCollector } = require('./amap/collector');
const { getPoiDetail, fetchTypeTag, PLACE_URL } = require('./amap/detail');
const { verifyOnDianping } = require('./dianping/verify');
const { exportXlsx } = require('./export/xlsx');
const { writeRejectReport } = require('./report');
const { normalizeName } = require('./clean/normalize');
const {
  closesAfter, detectOpenState, isOperatingNormally, parseBusinessHours
} = require('./clean/businessHours');

const AMAP_HOME = 'https://ditu.amap.com/';

/** 选出本次要采集的分类（必须属于 fl.txt） */
function resolveCategories(cfg, ref, logger) {
  const list = [];
  for (const cat of cfg.categories) {
    const official = ref.categoryByCode.get(String(cat.code).toLowerCase());
    if (!official) {
      logger.warn(`分类 ${cat.code}（${cat.name}）不在 fl.txt 中，忽略`);
      continue;
    }
    if (cfg.onlyCategories) {
      const hit = cfg.onlyCategories.some((q) => {
        const lq = String(q).toLowerCase();
        return lq === String(official.code).toLowerCase() || q === official.name;
      });
      if (!hit) continue;
    }
    list.push({
      code: official.code,
      name: official.name,
      amapQuery: cat.amapQuery || official.name
    });
  }
  return list;
}

async function runPipeline(cfg, logger, options = {}) {
  const startedAt = Date.now();
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  logger.stage('初始化：解析 fl.txt 分类字典与 cs.txt 已有场所');
  const ref = loadReference(cfg.paths);
  logger.info(`参考数据：分类 ${ref.stats.categoryCount} 个，已有场所 ${ref.stats.placeCount} 条（标注样本 ${ref.stats.sampleCount} 条）`);

  const cache = createCache(cfg);
  const classifier = createClassifier({
    categories: cfg.categories,
    amapCategoryHints: cfg.amapCategoryHints,
    conflictGroups: cfg.conflictGroups,
    validCategories: ref.categories
  });
  const deduper = createDeduper(ref);
  const categories = resolveCategories(cfg, ref, logger);
  if (!categories.length) throw new Error('没有可采集的分类，请检查 --categories 参数或 config/categories.json');
  logger.info(`本次采集分类（${categories.length}）：${categories.map((c) => `${c.name}(${c.amapQuery})`).join('、')}`);

  const limitText = Number.isFinite(cfg.limit) ? `${cfg.limit} 个` : '不限制';
  logger.info(`采集数量上限：${limitText}；操作间隔：${cfg.rules.delayMs}ms；照片数下限：>${cfg.rules.minPhotoCount}；结束营业时间：>${cfg.rules.closingTimeAfter}；大众点评核验：${cfg.skipVerify ? '关闭' : '开启'}`);

  const ctx = await createBrowser(cfg, logger);
  await resetAmapPunish(ctx, logger);
  const pace = createPacer(cfg.rules.delayMs, logger, cfg.rules.paceMode || 'strict');
  const amapPage = ctx.pages()[0] || (await ctx.newPage());
  const dpPage = await ctx.newPage();

  let stopping = false;
  const onSignal = async () => {
    stopping = true;
    logger.warn('收到中断信号，正在收尾…');
  };
  process.once('SIGINT', onSignal);

  try {
    // ---------- 登录 ----------
    logger.stage('打开高德地图，准备登录');
    await pace.pace('打开高德地图首页');
    await amapPage.goto(AMAP_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);
    await ensureAmapNewVersion(amapPage, logger, pace);
    await amapPage.goto(cfg.rules.amap.entryUrl.replace('{kw}', encodeURIComponent(categories[0].amapQuery)), {
      waitUntil: 'domcontentloaded', timeout: 60000
    }).catch(() => {});
    await sleep(2000);
    await waitForLogin(amapPage, { site: '高德地图', check: isAmapLoggedIn, logger, timeoutMinutes: 15 });

    logger.stage('打开大众点评，准备登录');
    await pace.pace('打开大众点评');
    await dpPage.goto(cfg.rules.dianping.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);
    if (cfg.skipVerify) {
      logger.warn('已关闭大众点评核验（--skip-verify），跳过点评登录等待');
    } else {
      const dpLogged = await waitForLogin(dpPage, { site: '大众点评', check: isDianpingLoggedIn, logger, timeoutMinutes: 15 });
      if (!dpLogged) {
        logger.error('大众点评未登录，无法完成同店核验。请登录后重试，或使用 --skip-verify 跳过核验。');
        throw new Error('大众点评未登录：请在弹出的浏览器窗口中登录后重试');
      }
    }

    // ---------- 采集 ----------
    const collector = createAmapCollector({ page: amapPage, cfg, logger, pace, cache });
    const records = [];
    const rejects = [];
    const processedIds = new Set();
    const maxScan = Number.isFinite(cfg.limit)
      ? Math.max(cfg.limit * 15, 60)
      : Number(cfg.rules.maxScan || 100000);

    const reject = (poi, stage, reason, extra = {}) => {
      rejects.push({
        stage,
        category: extra.category || '',
        name: poi.name,
        address: poi.address || extra.address || '',
        photoCount: extra.photoCount,
        hours: extra.hours || '',
        state: extra.state || '',
        reason,
        id: poi.id,
        url: poi.id ? PLACE_URL(poi.id) : ''
      });
      logger.reject(`过滤【${poi.name}】${reason}`);
      logger.progress();
    };

    const pools = categories.map((cat) => ({ cat, items: null, index: 0, done: false }));
    let scanned = 0;

    while (records.length < cfg.limit && scanned < maxScan && !stopping && !shouldStop()) {
      let progressed = false;

      for (const pool of pools) {
        if (records.length >= cfg.limit || scanned >= maxScan || stopping || shouldStop()) break;
        if (pool.done) continue;

        if (!pool.items) {
          logger.stage(`搜索分类「${pool.cat.name}」（高德关键词：${pool.cat.amapQuery}）`);
          try {
            pool.items = await collector.search(pool.cat.amapQuery);
            logger.ok(`关键词「${pool.cat.amapQuery}」共获得候选 ${pool.items.length} 条`);
          } catch (e) {
            logger.error(`关键词「${pool.cat.amapQuery}」搜索失败：${e.message.split('\n')[0]}`);
            pool.items = [];
          }
          if (!pool.items.length) { pool.done = true; continue; }
        }

        if (pool.index >= pool.items.length) { pool.done = true; continue; }

        const poi = pool.items[pool.index];
        pool.index += 1;
        progressed = true;
        scanned += 1;
        logger.setPrefix(`${records.length + 1}/…`);
        logger.info(`扫描第 ${scanned} 条：${poi.name}（${poi.address || '地址未知'}）`);
        logger.progress({ scanned, saved: records.length });

        try {
          if (!poi.id || processedIds.has(poi.id)) continue;
          processedIds.add(poi.id);

          // 规则1：与 cs.txt 去重 / 本次内部去重
          if (deduper.isExisting(poi.name)) {
            reject(poi, '去重', '与 cs.txt 已有场所重名', { category: pool.cat.name });
            continue;
          }
          if (deduper.isDuplicateInRun(poi.name)) {
            reject(poi, '去重', '本次采集中已存在同名场所', { category: pool.cat.name });
            continue;
          }

          // 规则2：分类判定（先用名称判定，判不出再取高德分类文本兜底）
          let typeText = poi.typeText || '';
          let cls = classifier.classify(poi.name, typeText);
          if (!cls) {
            const tag = await fetchTypeTag({ page: amapPage, id: poi.id, pace, logger }).catch(() => '');
            if (tag) {
              typeText = tag;
              cls = classifier.classify(poi.name, tag);
              if (cls) logger.info(`按高德分类文本兜底归类：${poi.name} → ${cls.name}（${tag}）`);
            }
          }
          if (!cls) {
            reject(poi, '分类', '无法判定分类（不在 fl.txt 的分类范围内）', { category: pool.cat.name });
            continue;
          }
          if (cfg.onlyCategories) {
            const wanted = cfg.onlyCategories.some((q) => String(q).toLowerCase() === String(cls.code).toLowerCase() || q === cls.name);
            if (!wanted) {
              reject(poi, '分类', `归类为「${cls.name}」，不在本次采集范围内`, { category: pool.cat.name });
              continue;
            }
          }
          poi.typeText = typeText;

          // 详情（照片数 / 营业时间 / 电话 / 标签）；详情页之间额外降温，降低触发反爬概率
          if (cfg.rules.poiCooldownMs) await sleep(Number(cfg.rules.poiCooldownMs));
          let detail = cache.read('amap-detail', poi.id, cfg.resume);
          // 缓存不完整（没读到照片数/营业时间）时不复用，重新采集
          if (detail && (detail.photoCount === null || detail.photoCount === undefined) && !detail.hours) {
            logger.warn(`本地缓存详情不完整（未读到照片数/营业时间），重新采集：${poi.name}`);
            detail = null;
          }
          if (detail) {
            logger.info(`使用本地缓存详情：${poi.name}`);
          } else {
            detail = await getPoiDetail({ page: amapPage, poi, cfg, logger, pace });
            cache.write('amap-detail', poi.id, detail);
          }
          detail.categoryCode = cls.code;
          detail.categoryName = cls.name;
          detail.typeText = detail.typeText || poi.typeText || '';

          for (const w of detail.warnings || []) logger.warn(`${poi.name}：${w}`);

          // 规则3：照片数量 > 5（取封面右下角“照片N”）
          if (detail.photoCount === null || detail.photoCount === undefined) {
            reject(poi, '照片数', '未能读取到高德封面“照片N”，无法确认照片数量', { category: pool.cat.name, ...detail });
            continue;
          }
          if (detail.photoCount <= cfg.rules.minPhotoCount) {
            reject(poi, '照片数', `封面照片数 ${detail.photoCount} 未超过 ${cfg.rules.minPhotoCount}`, { category: pool.cat.name, ...detail });
            continue;
          }

          // 规则4：营业状态与营业时间
          if (!isOperatingNormally(detail.state)) {
            reject(poi, '营业状态', `高德显示「${detail.state}」，非正常营业`, { category: pool.cat.name, ...detail });
            continue;
          }
          if (!closesAfter(detail.hours, cfg.rules.closingTimeAfter)) {
            reject(poi, '营业时间', `结束营业时间不晚于 ${cfg.rules.closingTimeAfter}（高德营业时间：${detail.hours || '未知'}）`, { category: pool.cat.name, ...detail });
            continue;
          }

          // 规则5：大众点评核验
          if (!cfg.skipVerify) {
            await waitForCaptchaClear(dpPage, { site: '大众点评', logger });
            let verdict = cache.read('dianping', normalizeName(poi.name), cfg.resume);
            if (verdict) {
              logger.info(`使用本地缓存核验结果：${poi.name}（${verdict.ok ? '通过' : '未通过'}）`);
            } else {
              verdict = await verifyOnDianping({ page: dpPage, poi: { ...poi, address: detail.address || poi.address }, cfg, logger, pace });
              // 只缓存“通过”的核验结果：未通过可能因临时风控/选择器问题造成，缓存会导致误杀
              if (verdict.ok) cache.write('dianping', normalizeName(poi.name), verdict);
            }
            detail.dianping = verdict;
            logger.progress({ verified: logger.stats.verified + (verdict.ok ? 1 : 0) });
            if (!verdict.ok) {
              reject(poi, '大众点评', verdict.reason, { category: pool.cat.name, ...detail });
              continue;
            }
            if (verdict.shop) logger.ok(`大众点评核验通过：${poi.name} ↔ ${verdict.shop.name}（${verdict.method}）`);
          }

          detail.name = detail.name || poi.name;
          detail.cityName = detail.cityName || '北京市';
          records.push(detail);
          deduper.add(detail.name, detail.id);
          logger.ok(`✅ 通过（第 ${records.length} 个）：${detail.name}｜照片 ${detail.photoCount}｜营业 ${detail.hours}｜${detail.categoryName}`);
          logger.progress({ saved: records.length, passed: records.length, verified: logger.stats.verified });
        } catch (e) {
          logger.error(`处理「${poi.name}」出错：${e.message.split('\n')[0]}`);
          reject(poi, '异常', `处理异常：${e.message.split('\n')[0]}`, { category: pool.cat.name });
        }
      }

      if (!progressed) break;
    }

    // ---------- 导出 ----------
    logger.stage('导出结果');
    let file = '';
    if (records.length) {
      file = await exportXlsx(records, cfg, logger);
    } else {
      logger.warn('本次没有符合全部条件的场所，未生成 xlsx');
    }
    const report = writeRejectReport(rejects, cfg, logger);

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    logger.stage('完成');
    logger.ok(`采集结束：扫描 ${scanned} 条，通过 ${records.length} 条，过滤 ${rejects.length} 条，用时 ${seconds}s`);
    if (file) logger.ok(`结果文件：${file}`);
    logger.info(`被过滤明细：${report.csvFile}`);

    return { file, records, rejects, report, scanned, seconds };
  } finally {
    process.removeListener('SIGINT', onSignal);
    await disposeBrowser(ctx, logger);
  }
}

module.exports = { runPipeline, resolveCategories };
