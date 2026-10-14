'use strict';
/**
 * 统一配置加载：读取 config/rules.json 与 config/categories.json，
 * 并支持命令行 / 网页传入的覆盖项。
 * 注意：cs.txt、fl.txt 为只读输入文件，本工具不会修改它们。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function deepMerge(base, extra) {
  if (!extra) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const defaultRules = readJson(path.join(ROOT, 'config', 'rules.json'));
const defaultCategories = readJson(path.join(ROOT, 'config', 'categories.json'));

/**
 * @param {object} [overrides] 形如 { delayMs, limit, outputDir, skipVerify, categories: ['KTV'], resume, headless }
 */
function loadConfig(overrides = {}) {
  const rules = deepMerge(defaultRules, overrides.rules || {});
  if (overrides.delayMs !== undefined) rules.delayMs = overrides.delayMs;
  if (overrides.minPhotoCount !== undefined) rules.minPhotoCount = overrides.minPhotoCount;
  if (overrides.closingTimeAfter !== undefined) rules.closingTimeAfter = overrides.closingTimeAfter;
  if (overrides.maxPagesPerKeyword !== undefined) rules.maxPagesPerKeyword = overrides.maxPagesPerKeyword;
  if (overrides.outputDir) rules.output.dir = overrides.outputDir;

  const cfg = {
    root: ROOT,
    rules,
    categories: defaultCategories.categories,
    amapCategoryHints: defaultCategories.amapCategoryHints || [],
    conflictGroups: defaultCategories.conflictGroups || [],
    limit: Number.isFinite(overrides.limit) ? overrides.limit : Infinity,
    onlyCategories: overrides.categories && overrides.categories.length ? overrides.categories.map((c) => String(c).trim()) : null,
    skipVerify: !!overrides.skipVerify,
    resume: !!overrides.resume,
    headless: overrides.headless !== undefined ? !!overrides.headless : !!rules.amap.headless,
    debug: !!overrides.debug,
    paths: {
      csTxt: path.join(ROOT, 'cs.txt'),
      flTxt: path.join(ROOT, 'fl.txt'),
      cacheDir: path.join(ROOT, 'data', 'cache'),
      logDir: path.join(ROOT, 'data', 'logs'),
      reportDir: path.join(ROOT, 'data', 'reports'),
      profileDir: path.resolve(ROOT, rules.amap.userDataDir)
    }
  };
  if (cfg.limit === 0) cfg.limit = Infinity;
  return cfg;
}

/** 按 code 或中文名查分类定义（大小写不敏感，兼容 fl.txt 的 KTV / cs.txt 的 ktv） */
function findCategory(categories, codeOrName) {
  if (!codeOrName) return null;
  const q = String(codeOrName).trim().toLowerCase();
  return (
    categories.find((c) => String(c.code).toLowerCase() === q) ||
    categories.find((c) => String(c.name).toLowerCase() === q) ||
    null
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { ROOT, loadConfig, findCategory, ensureDir, readJson };
