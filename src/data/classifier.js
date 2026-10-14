'use strict';
/**
 * 场所分类判定器。
 * 规则来源：cs.txt 中 662 条已标注场所（name -> type_code）提炼出的加权关键词，
 * 配置在 config/categories.json；判定结果必须落在 fl.txt 的分类范围内。
 *
 * 判定顺序：
 *   1) 名称关键词加权打分（含反证关键词扣分）
 *   2) 混合业态裁决（conflictGroups）：同组内多个分类同时命中时（如“XX 台球棋牌俱乐部”“网咖·台球厅”），
 *      按关键词在名称中出现的先后顺序决定归属 —— 这正是 cs.txt 已有样本体现出的规律
 *   3) 名称无法判定时，用高德自身的分类文本（category/type 字段）按 hints 兜底
 *   4) 仍无法判定 -> 返回 null（调用方按“无法归类”丢弃并记入日志）
 */
const { compact, stripBrackets, toHalfWidth } = require('../clean/normalize');

const ASCII_RE = /^[\x00-\x7f]+$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 关键词匹配：ASCII 关键词要求拉丁词边界（避免 SPARK 命中 spa、BARbecue 命中 bar）；
 * 中文关键词走压缩串（去标点空格）包含匹配，避免“足 道”这类空格写法漏判。
 * @returns {{matched:boolean, index:number}} index 为在压缩串中的位置，用于混合业态排序裁决
 */
function matchKeyword(name, kw) {
  const compactKw = compact(kw);
  if (!compactKw) return { matched: false, index: -1 };
  const compactName = compact(name);
  const compactNoBranch = compact(stripBrackets(name));
  const index = compactNoBranch.indexOf(compactKw) >= 0 ? compactNoBranch.indexOf(compactKw) : compactName.indexOf(compactKw);

  if (ASCII_RE.test(kw)) {
    const orig = toHalfWidth(name).toLowerCase();
    const origNoBranch = toHalfWidth(stripBrackets(name)).toLowerCase();
    const strict = new RegExp(`(?<![a-z0-9])${escapeRe(kw)}(?![a-z0-9])`);
    let hit = strict.test(orig) || strict.test(origNoBranch);
    // 长英文关键词（>=6 字符）允许出现在更长的英文串内部，如 “SoilRompTaproom”、“EGOLiveClub”
    if (!hit && kw.length >= 6) hit = orig.includes(kw) || origNoBranch.includes(kw);
    if (!hit) return { matched: false, index };
    return { matched: true, index: index >= 0 ? index : Number.MAX_SAFE_INTEGER };
  }
  if (index < 0) return { matched: false, index };
  return { matched: true, index };
}

function scoreByName(name, cat) {
  let score = 0;
  const hits = [];
  let firstIndex = Number.MAX_SAFE_INTEGER;
  for (const [kw, weight] of Object.entries(cat.keywords || {})) {
    const { matched, index } = matchKeyword(name, kw);
    if (!matched) continue;
    score += weight + Math.max(0, compact(kw).length - 1) * 0.3;
    hits.push(kw);
    if (index < firstIndex) firstIndex = index;
  }
  for (const nk of cat.negative || []) {
    const { matched } = matchKeyword(name, nk);
    if (matched) {
      score -= 8;
      hits.push(`-${nk}`);
    }
  }
  return { score, hits, firstIndex };
}

/**
 * @param {object} options
 * @param {Array} options.categories config/categories.json 的 categories（带 keywords/priority/amapQuery）
 * @param {Array} options.amapCategoryHints 高德分类文本兜底映射
 * @param {Array} options.validCategories fl.txt 中的有效分类（code/name），判定结果必须落在这里面
 * @param {Array} options.conflictGroups 混合业态裁决组
 */
function createClassifier({ categories, amapCategoryHints = [], validCategories = [], conflictGroups = [] }) {
  const valid = new Map();
  for (const c of validCategories) valid.set(String(c.code).toLowerCase(), c);

  const ruleList = categories.map((c) => {
    const official = valid.get(String(c.code).toLowerCase());
    return {
      code: official ? official.code : c.code,
      name: official ? official.name : c.name,
      priority: Number(c.priority || 0),
      keywords: c.keywords || {},
      negative: c.negative || []
    };
  });

  const groups = conflictGroups.map((g) => ({ codes: (g.codes || []).map((x) => String(x).toLowerCase()) }));

  function classifyByHint(extraText) {
    if (!extraText) return null;
    const t = compact(extraText);
    if (!t) return null;
    const hits = [];
    for (const hint of amapCategoryHints) {
      for (const m of hint.match || []) {
        const k = compact(m);
        if (k && t.includes(k)) hits.push({ code: hint.code, hitLen: k.length });
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => b.hitLen - a.hitLen);
    const official = valid.get(String(hits[0].code).toLowerCase());
    if (!official) return null;
    return { code: official.code, name: official.name, score: 0, hits: [], via: 'amap-category' };
  }

  /**
   * @param {string} name 场所名称
   * @param {string} [amapCategoryText] 高德分类文本，如 “休闲娱乐;娱乐场所;KTV”
   */
  function classify(name, amapCategoryText) {
    const results = [];
    for (const cat of ruleList) {
      const { score, hits, firstIndex } = scoreByName(name || '', cat);
      if (score > 0) {
        results.push({ code: cat.code, name: cat.name, score, hits, firstIndex, priority: cat.priority, via: 'name' });
      }
    }
    if (results.length) {
      // 混合业态裁决
      for (const g of groups) {
        const inGroup = results.filter((r) => g.codes.includes(String(r.code).toLowerCase()));
        if (inGroup.length > 1) {
          inGroup.sort((a, b) => (a.firstIndex - b.firstIndex) || (b.score - a.score) || (b.priority - a.priority));
          for (const r of inGroup.slice(1)) r.eliminated = true;
        }
      }
      const alive = results.filter((r) => !r.eliminated);
      alive.sort((a, b) => (b.score - a.score) || (b.priority - a.priority));
      return alive[0];
    }
    const hinted = classifyByHint(amapCategoryText);
    if (hinted) return hinted;
    return null;
  }

  return { classify, ruleList, validCodes: [...valid.keys()] };
}

module.exports = { createClassifier, scoreByName, matchKeyword };
