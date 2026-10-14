'use strict';
/**
 * 名称 / 地址归一化与相似度工具。
 * 目的：1) 与 cs.txt 已有场所名去重；2) 跨平台（高德 vs 大众点评）同店判定。
 */

const BEIJING_DISTRICTS = [
  '东城区', '西城区', '朝阳区', '海淀区', '丰台区', '石景山区', '门头沟区', '房山区',
  '通州区', '顺义区', '昌平区', '大兴区', '怀柔区', '平谷区', '密云区', '延庆区'
];

/** 全角转半角 */
function toHalfWidth(input) {
  if (!input) return '';
  return String(input).replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
}

/** 去括号内容（分店后缀等），支持 ()（）[]【】 */
function stripBrackets(input) {
  return String(input || '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ')
    .replace(/\s+/g, ' ');
}

/** 保留中文/字母/数字，其余（空格、标点、·、&）全部去掉，用于名称比对 */
function compact(input) {
  return toHalfWidth(input).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/**
 * 名称归一化：去除分店后缀与修饰标点。
 * "唱吧麦颂KTV(三里屯店)" -> "唱吧麦颂ktv"
 */
function normalizeName(name) {
  if (!name) return '';
  let s = stripBrackets(name);
  s = s.replace(/(北京)?(总店|分店|旗舰店|直营店)$/g, '');
  return compact(s);
}

/** 更激进的店名键：再去掉结尾的“店/馆/城/汇”等高频字，用于宽松重复判断 */
function nameKey(name) {
  const base = normalizeName(name);
  return base.replace(/(店|馆|城|汇|店)$/g, '');
}

/** 地址归一化 */
function normalizeAddress(addr) {
  if (!addr) return '';
  let s = toHalfWidth(addr).toLowerCase();
  s = s.replace(/(中国)?(北京市|北京)/g, '');
  s = s.replace(/(近|距|旁边|对面|附近|东南|西北|东北|西南|方向|步行|米|公里|约|直线)/g, '');
  s = s.replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
  return s;
}

function extractCity(address, fallback = '北京市') {
  if (!address) return fallback;
  const m = String(address).match(/([\u4e00-\u9fa5]{2,6}(?:市|自治州|地区))/);
  return m ? m[1] : fallback;
}

function extractDistrict(address) {
  if (!address) return '';
  const hit = BEIJING_DISTRICTS.find((d) => String(address).includes(d));
  return hit || '';
}

/** 提取“道路名 + 门牌号”：红莲南路57号 -> { road: '红莲南路', number: '57' } */
function extractRoadNumber(address) {
  if (!address) return null;
  const s = toHalfWidth(address);
  const re = /([\u4e00-\u9fa5]{1,8}?(?:路|街|大街|道|巷|胡同|大道))?\s*(\d{1,5})\s*号/g;
  const hits = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    hits.push({ road: m[1] || '', number: m[2] });
  }
  return hits.length ? hits : null;
}

const BUILDING_SUFFIX = '(?:大厦|大楼|广场|中心|商城|商厦|购物中心|写字楼|商务楼|商务中心|生活广场|国际中心|国际|公寓|酒店|饭店|花园|园区|科技园|公馆|天地|商都|soho|SOHO)';

/** 提取建筑名（用于“地标反查”法），如 “红莲南路中国文化大厦B1层” -> ['中国文化大厦'] */
function extractBuildings(address) {
  if (!address) return [];
  const s = toHalfWidth(address);
  const re = new RegExp(`([\\u4e00-\\u9fa5A-Za-z0-9]{2,12}${BUILDING_SUFFIX})`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(s)) !== null) {
    let name = m[1];
    // 去掉前缀动词/方位词
    name = name.replace(/^(位于|位于北京市|北京市|北京|地址|在|到|北|南|东|西|中|内|外)+/, '');
    if (name.length >= 3) out.add(name);
  }
  return [...out];
}

/** 提取括号里的分店信息：宝乐迪量贩式KTV(万丰路店) -> 万丰路 */
function branchTokens(name) {
  const m = String(name || '').match(/[（(]([^）)]{1,30})[）)]/g) || [];
  return m
    .map((x) => x.replace(/[（()）]/g, ''))
    .map((x) => x.replace(/店$/, '').replace(/^(北京|北京市)/, ''))
    .join(' ');
}

/**
 * 分店是否兼容：用于避免“同一连锁不同分店”被误判为同店。
 * 一方没有分店信息时不否决；都有分店信息时要求相等/包含/共享地名片段。
 */
function branchCompatible(a, b) {
  const ba = branchTokens(a);
  const bb = branchTokens(b);
  if (!ba || !bb) return true;
  const na = compact(ba);
  const nb = compact(bb);
  if (!na || !nb) return true;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const setB = bigrams(nb);
  for (const g of bigrams(na)) if (g.length >= 2 && setB.has(g)) return true;
  return false;
}

/** 地址中提取“楼层/铺位”等更细的定位信息，用于加分 */
function extractFloor(address) {
  if (!address) return '';
  const m = String(address).match(/([a-zA-Z]?\d{1,2}\s*(?:层|楼|f|F))|([bB]\d{1,2})|(负[一二]层)/);
  return m ? compact(m[0]) : '';
}

function bigrams(str) {
  const s = str || '';
  const set = new Set();
  if (s.length <= 2) { if (s) set.add(s); return set; }
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

/**
 * 地址相似度（0~1）：字符二元组 Jaccard + 门牌号命中加权。
 * 用于跨平台同店判定的第二档判断。
 */
function addressSimilarity(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return 0;
  let score = jaccard(bigrams(na), bigrams(nb));

  const roadA = extractRoadNumber(a) || [];
  const roadB = extractRoadNumber(b) || [];
  for (const ra of roadA) {
    for (const rb of roadB) {
      if (!ra.number || ra.number !== rb.number) continue;
      const roadsCompatible = !ra.road || !rb.road || ra.road === rb.road || ra.road.includes(rb.road) || rb.road.includes(ra.road);
      // 只有“门牌号相同且道路名一致”才算强证据；
      // 门牌号相同但道路名不同（例如 樊阳路51号 vs 樊羊路51号院）不能当作同一地点
      score += roadsCompatible ? 0.45 : 0.05;
    }
  }
  const floorsA = extractFloor(a);
  const floorsB = extractFloor(b);
  if (floorsA && floorsA === floorsB) score += 0.1;

  // 同一建筑名直接强命中
  const bA = extractBuildings(a);
  const bB = extractBuildings(b);
  for (const x of bA) for (const y of bB) {
    if (x === y || x.includes(y) || y.includes(x)) score += 0.4;
  }
  return Math.min(1, Number(score.toFixed(3)));
}

/** 名称是否“疑似同店”：归一化后一方包含另一方 */
function nameLooseMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

module.exports = {
  BEIJING_DISTRICTS,
  toHalfWidth,
  stripBrackets,
  compact,
  normalizeName,
  nameKey,
  normalizeAddress,
  extractCity,
  extractDistrict,
  extractRoadNumber,
  extractBuildings,
  extractFloor,
  addressSimilarity,
  nameLooseMatch,
  branchTokens,
  branchCompatible,
  jaccard,
  bigrams
};
