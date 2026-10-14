'use strict';
/**
 * 参考数据层：
 *  - fl.txt：分类字典（12 条），只读解析
 *  - cs.txt：已有场所列表，只读解析
 *
 * 重要坑点：cs.txt 不是合法 JSON！它是 7 个 JSON 文档（分页 page 1..7，limit=100，total=662）
 * 首尾直接拼接而成，直接 JSON.parse 会报 `Extra data`。因此这里用「字符串感知的括号配平」切分成多个文档再逐个解析。
 */
const fs = require('fs');
const { normalizeName, nameKey } = require('../clean/normalize');

/** 把“多个连续 JSON 文档拼接”的文本切成单个文档（正确处理字符串内的花括号与转义） */
function splitJsonDocs(raw) {
  const docs = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        docs.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return docs;
}

function parseLooseJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const parts = splitJsonDocs(raw);
  const objects = [];
  for (const p of parts) {
    try {
      objects.push(JSON.parse(p));
    } catch (e) {
      // 单个文档解析失败不应影响整体：记录并跳过
      objects.push({ __parseError: e.message });
    }
  }
  return { raw, objects };
}

function loadCategories(flTxt) {
  const { objects } = parseLooseJsonFile(flTxt);
  const list = [];
  for (const obj of objects) {
    const data = obj && obj.data;
    if (Array.isArray(data)) list.push(...data);
  }
  return list
    .filter((c) => c && c.code && c.name)
    .map((c) => ({ id: c.id, code: String(c.code), name: String(c.name), isShow: c.is_show }));
}

function loadExistingPlaces(csTxt) {
  const { objects } = parseLooseJsonFile(csTxt);
  const list = [];
  for (const obj of objects) {
    const data = obj && obj.data;
    if (data && Array.isArray(data.list)) list.push(...data.list);
    else if (Array.isArray(data)) list.push(...data);
  }
  return list;
}

/**
 * 加载全部参考数据。
 * @returns {{
 *   categories: Array<{code:string,name:string}>,
 *   categoryByCode: Map<string, object>,
 *   places: Array<object>,
 *   existingNames: Set<string>,
 *   existingNameKeys: Set<string>,
 *   samples: Array<{name:string, code:string}>,
 *   stats: object
 * }}
 */
function loadReference(paths) {
  const categories = loadCategories(paths.flTxt);
  const places = loadExistingPlaces(paths.csTxt);

  const existingNames = new Set();
  const existingNameKeys = new Set();
  const samples = [];
  const byCode = new Map();

  for (const p of places) {
    if (!p || !p.name) continue;
    existingNames.add(normalizeName(p.name));
    existingNameKeys.add(nameKey(p.name));
    if (p.type_code) {
      const code = String(p.type_code);
      samples.push({ name: String(p.name), code });
      byCode.set(code.toLowerCase(), (byCode.get(code.toLowerCase()) || 0) + 1);
    }
  }

  const categoryByCode = new Map();
  for (const c of categories) categoryByCode.set(c.code.toLowerCase(), c);

  return {
    categories,
    categoryByCode,
    places,
    existingNames,
    existingNameKeys,
    samples,
    stats: {
      categoryCount: categories.length,
      placeCount: places.length,
      sampleCount: samples.length,
      sampleByCode: Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1]))
    }
  };
}

module.exports = { loadReference, splitJsonDocs, loadCategories, loadExistingPlaces };
