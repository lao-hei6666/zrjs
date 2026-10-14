'use strict';
/**
 * 去重：与 cs.txt 已有场所名比对（归一化 + 宽松键两档），以及本次采集结果内部去重。
 */
const { normalizeName, nameKey } = require('./normalize');

function createDeduper(reference) {
  const existingNames = new Set(reference.existingNames || []);
  const existingKeys = new Set(reference.existingNameKeys || []);
  const seenNames = new Set();
  const seenKeys = new Set();
  const seenIds = new Set();

  return {
    /** 是否与 cs.txt 已有场所重名 */
    isExisting(name) {
      if (!name) return true;
      const n = normalizeName(name);
      if (existingNames.has(n)) return true;
      const k = nameKey(name);
      return k.length >= 3 && existingKeys.has(k) && existingNames.has(n);
    },
    /** 是否与本次已采集的场所重名 */
    isDuplicateInRun(name) {
      if (!name) return true;
      return seenNames.has(normalizeName(name)) || (nameKey(name).length >= 3 && seenKeys.has(nameKey(name)));
    },
    /** 记录一条已通过的场所 */
    add(name, id) {
      seenNames.add(normalizeName(name));
      seenKeys.add(nameKey(name));
      if (id) seenIds.add(String(id));
    },
    hasId(id) { return seenIds.has(String(id)); },
    get size() { return seenNames.size; }
  };
}

module.exports = { createDeduper };
