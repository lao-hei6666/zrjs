'use strict';
/**
 * 高德详情抽取：打开新版 POI 详情页 https://www.amap.com/place/<poiid>，
 * 读取 **封面右下角“照片N”** 里的照片数量、营业状态与营业时间、评分、人均、标签、电话、地址。
 *
 * 说明（重要）：不能使用详情页“相册 共 N 张”的数字 —— 未登录时该处只显示 3 张，
 * 因此照片数量一律以封面右下角“照片N”为准。
 *
 * 同时用 https://www.amap.com/detail/get/detail?id=<poiid> 补充分类文本(tag)、坐标、电话等。
 */
const { sleep } = require('../pace');
const { hasCaptcha, waitForCaptchaClear } = require('./browser');

const PLACE_URL = (id) => `https://www.amap.com/place/${id}`;
const DETAIL_API = (id) => `https://www.amap.com/detail/get/detail?id=${id}`;
const CARD_SELECTOR = '[class*="openTimeText"], [class*="photoBadge"], [class*="scoreNumber"]';

function parsePhotoCount(text) {
  if (!text) return null;
  const m = String(text).match(/照片\s*([\d,]+(?:\.\d+)?)\s*(万)?/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  return m[2] ? Math.round(num * 10000) : Math.round(num);
}

/** 从详情页 DOM 抽取字段（多选择器兜底 + 文本正则兜底） */
async function readPlacePage(page) {
  return page.evaluate(() => {
    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    };
    const pickByClass = (part) => txt(`[class*="${part}"]`);

    const body = document.body.innerText || '';
    const card = document.querySelector('[class*="pageContent_card"], [class*="poiContentWrapper"]');
    const lines = (card ? card.innerText : body).split('\n').map((s) => s.trim()).filter(Boolean);

    // 照片数：封面右下角“照片N”
    let photoText = pickByClass('photoBadge');
    if (!photoText) {
      const m = body.match(/照片\s*[\d,]+\s*万?/);
      photoText = m ? m[0] : '';
    }

    // 营业状态 + 营业时间（同一行或相邻行）
    let stateText = pickByClass('openTimeWrapper') || pickByClass('openTimeText');
    let state = '';
    let hours = '';
    const stateMatch = (stateText || body).match(/(营业中|休息中|休息|已关闭|暂停营业|歇业|即将开业)/);
    if (stateMatch) state = stateMatch[1];
    const hoursSource = pickByClass('openTimeText') || stateText || body;
    const hoursMatch = (hoursSource || '').match(/(次日)?\s*(\d{1,2}:\d{2})\s*[-~—－]\s*(次日)?\s*(\d{1,2}:\d{2})/);
    if (hoursMatch) hours = `${hoursMatch[1] ? '次日' : ''}${hoursMatch[2]}-${hoursMatch[3] ? '次日' : ''}${hoursMatch[4]}`;

    // 评分 / 人均
    const rating = (pickByClass('scoreNumber') || (body.match(/([0-5]\.\d)\s*(超棒|很棒|很好|不错)/) || [])[1] || '');
    const priceText = pickByClass('priceText') || ((body.match(/[¥￥]\s*\d+\s*\/\s*人/) || [])[0] || '');
    const price = (priceText.match(/(\d+(?:\.\d+)?)/) || [])[1] || '';

    // 标签区：位于“人均”行与“营业状态”行之间
    const priceIdx = lines.findIndex((l) => /[¥￥]\s*\d+\s*\/?\s*人?/.test(l));
    const stateIdx = lines.findIndex((l) => /^(营业中|休息中|休息|已关闭|暂停营业|歇业|即将开业)/.test(l));
    let tagLines = [];
    if (priceIdx >= 0) {
      const end = stateIdx > priceIdx ? stateIdx : Math.min(lines.length, priceIdx + 20);
      tagLines = lines.slice(priceIdx + 1, end);
    }

    // 电话：严格匹配座机（010-12345678）/400 电话/手机号（1[3-9] 开头 11 位），
    // 避免把页面底部的备案号（如 11010502056787）当成电话。
    const phoneRe = /(?<!\d)(?:0\d{2,3}[-\s]?\d{7,8}|400\d{7}|1[3-9]\d{9})(?:\s*[；;、]\s*(?:0\d{2,3}[-\s]?\d{7,8}|400\d{7}|1[3-9]\d{9}))*/g;
    let tel = '';
    const phoneBox = pickByClass('phone') || pickByClass('telephone') || pickByClass('tel-') || '';
    if (phoneBox) tel = (phoneBox.match(phoneRe) || []).join('；');
    if (!tel) tel = (body.match(phoneRe) || []).slice(0, 3).join('；');

    // 地址
    const addr = (body.match(/北京市[\u4e00-\u9fa5A-Za-z0-9（）()\-—·\s]{4,60}?(?:号|层|栋|楼|座|区|室|b1|B1)[^\n]{0,20}/) || [])[0]
      || lines.find((l) => /^北京市/.test(l)) || '';

    // 名称
    const name = (body.match(/\n?照片\s*[\d,]+\s*万?\s*›?\s*\n?([^\n]{2,40})/) || [])[1]
      || lines.find((l) => l.length >= 2 && l.length <= 40 && !/^照片|^[\d\s.$¥￥]+$|^\d\.\d/.test(l) && !/^(营业中|休息中)|人$/.test(l))
      || '';

    return {
      url: location.href,
      name: String(name || '').trim(),
      photoText,
      state,
      hours,
      rating,
      price,
      tags: tagLines,
      tel: String(tel || '').trim().slice(0, 60),
      address: String(addr || '').trim(),
      bodyText: body.slice(0, 3000)
    };
  });
}

async function fetchDetailApi(page, id) {
  try {
    const res = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        return { status: r.status, text: await r.text() };
      } catch (e) { return { status: 0, text: '' }; }
    }, DETAIL_API(id));
    if (res.status !== 200) return null;
    const json = JSON.parse(res.text);
    if (!json || !json.data || !json.data.base) return null;
    const base = json.data.base;
    return {
      name: base.name || '',
      address: base.address || '',
      tel: base.telephone || '',
      tag: base.tag || base.new_keytype || '',
      classify: base.classify || '',
      cityName: base.city_name || '',
      adcode: String(base.code || ''),
      lat: String(base.y || ''),
      lng: String(base.x || ''),
      cover: (json.data.pic_cover && json.data.pic_cover.url) || '',
      stdTag: base.std_t_tag_0_v || ''
    };
  } catch (e) {
    return null;
  }
}

/**
 * 抽取单个 POI 的详情。
 * @param {{page: import('playwright').Page, poi: object, cfg: object, logger: object, pace: object}} args
 */
async function getPoiDetail({ page, poi, cfg, logger, pace, useCache = true }) {
  const result = {
    id: poi.id,
    name: poi.name,
    address: poi.address,
    lat: poi.lat,
    lng: poi.lng,
    rating: poi.rating,
    price: poi.price,
    reviewTotal: poi.reviewTotal,
    adcode: poi.adcode,
    cityName: poi.cityName,
    cover: poi.cover,
    typeText: poi.typeText || '',
    photoCount: null,
    state: '',
    hours: '',
    tags: [],
    tel: '',
    source: 'amap',
    warnings: []
  };

  let pageData = null;
  let captchaHandled = false;
  const bases = ['https://www.amap.com', 'https://ditu.amap.com'];
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    await pace.pace(`打开高德详情页${i > 0 ? '（备用域名重试）' : ''}：${poi.name}`);
    try {
      await page.goto(`${base}/place/${poi.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      result.warnings.push(`详情页打开失败：${e.message.split('\n')[0]}`);
      continue;
    }
    await sleep(1500);

    // 反爬滑块：等待人工拖动完成，随后自动重新加载页面
    if (await hasCaptcha(page)) {
      logger.wait(`高德地图出现验证码（滑块/安全校验），请在浏览器窗口中手动拖动完成验证…`);
      const cleared = await waitForCaptchaClear(page, { site: '高德地图', logger, timeoutMinutes: 10 });
      result.warnings.push(cleared ? '详情页遇到验证码，已人工通过' : '详情页验证码未通过');
      captchaHandled = true;
      if (!cleared) continue;
      await pace.pace(`验证通过后重新加载详情页：${poi.name}`);
      await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(2500);
    }

    await page.waitForSelector(CARD_SELECTOR, { timeout: 12000 }).catch(() => {});
    await sleep(1200);
    pageData = await readPlacePage(page);

    // 页面可能仍在渲染，再等一轮
    if (!pageData.photoText && !pageData.hours && !pageData.state) {
      await sleep(2500);
      pageData = await readPlacePage(page);
    }
    if (pageData.photoText || pageData.hours || pageData.state) break;
    if (await hasCaptcha(page)) {
      result.warnings.push('详情页仍被验证码拦截，未读取成功');
      break;
    }
    result.warnings.push('详情页未读到照片数/营业时间，尝试换域名重试');
  }
  if (captchaHandled) result.captcha = true;

  // 接口补充（分类文本/坐标/电话/封面）
  await pace.pace(`读取高德详情接口：${poi.name}`);
  const apiData = await fetchDetailApi(page, poi.id);
  if (apiData) {
    result.typeText = apiData.tag || apiData.classify || result.typeText;
    if (!result.address) result.address = apiData.address;
    if (!result.tel) result.tel = apiData.tel;
    if (!result.cover) result.cover = apiData.cover;
    if (!result.lat && apiData.lat) result.lat = apiData.lat;
    if (!result.lng && apiData.lng) result.lng = apiData.lng;
    if (apiData.name) result.apiName = apiData.name;
    if (apiData.address) result.apiAddress = apiData.address;
    if (apiData.adcode) result.adcode = result.adcode || apiData.adcode;
  } else {
    result.warnings.push('详情接口未取到数据（可能被风控），改用页面数据');
  }

  if (pageData) {
    result.photoCount = parsePhotoCount(pageData.photoText);
    result.state = pageData.state || '';
    result.hours = pageData.hours || '';
    if (pageData.rating) result.rating = pageData.rating;
    if (pageData.price) result.price = pageData.price;
    if (pageData.tel) result.tel = pageData.tel;
    if (pageData.address) result.address = pageData.address;
    if (pageData.name) result.pageName = pageData.name;
    result.tags = (pageData.tags || []).filter((t) => t && t.length >= 2 && t.length <= 14);
    if (!result.photoCount) result.warnings.push('未能读到封面“照片N”，照片数量记为未知');
    if (!result.hours) result.warnings.push('未能读到营业时间');
  }

  return result;
}

/** 只取高德分类文本（tag）—— 用于“名称无法判定分类”时的兜底判定 */
async function fetchTypeTag({ page, id, pace, logger }) {
  if (pace) await pace.pace(`读取高德分类信息：${id}`);
  const api = await fetchDetailApi(page, id);
  if (!api) {
    if (logger) logger.warn(`未能取到 ${id} 的分类信息（可能被风控）`);
    return '';
  }
  return api.tag || api.classify || '';
}

module.exports = { getPoiDetail, parsePhotoCount, readPlacePage, fetchTypeTag, PLACE_URL, DETAIL_API };
