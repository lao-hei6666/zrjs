'use strict';
/**
 * 分类判定回归自测：用 cs.txt 中 662 条已标注场所作为测试集，
 * 校验关键词规则（config/categories.json）的准确率。
 * 目标：整体准确率 >= 90%（阈值可用环境变量 CLASSIFIER_MIN_ACC 调整）。
 */
const { loadConfig } = require('../src/config');
const { loadReference } = require('../src/data/reference');
const { createClassifier } = require('../src/data/classifier');

const cfg = loadConfig();
const ref = loadReference(cfg.paths);
const classifier = createClassifier({
  categories: cfg.categories,
  amapCategoryHints: cfg.amapCategoryHints,
  conflictGroups: cfg.conflictGroups,
  validCategories: ref.categories
});

const confusion = new Map();
const failures = [];
let correct = 0;

for (const s of ref.samples) {
  const expect = String(s.code).toLowerCase();
  const got = classifier.classify(s.name);
  const gotCode = got ? String(got.code).toLowerCase() : '(无法判定)';
  const key = `${expect} -> ${gotCode}`;
  confusion.set(key, (confusion.get(key) || 0) + 1);
  if (gotCode === expect) correct += 1;
  else if (failures.length < 60) failures.push({ name: s.name, expect, got: gotCode });
}

const total = ref.samples.length;
const acc = total ? correct / total : 0;
const perCode = new Map();
for (const s of ref.samples) {
  const expect = String(s.code).toLowerCase();
  const stat = perCode.get(expect) || { total: 0, ok: 0 };
  stat.total += 1;
  const got = classifier.classify(s.name);
  if (got && String(got.code).toLowerCase() === expect) stat.ok += 1;
  perCode.set(expect, stat);
}

console.log('=== 分类判定回归（测试集 = cs.txt 662 条已标注场所）===');
for (const [code, stat] of [...perCode.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${code.padEnd(10)} ${String(stat.ok).padStart(3)}/${String(stat.total).padStart(3)}  ${(stat.ok / stat.total * 100).toFixed(1)}%`);
}
console.log(`  总体准确率: ${correct}/${total} = ${(acc * 100).toFixed(2)}%`);

const wrong = new Map();
for (const [key, count] of [...confusion.entries()].sort((a, b) => b[1] - a[1])) {
  if (!key.startsWith(key.split(' -> ')[0] + ' -> ' + key.split(' -> ')[0])) wrong.set(key, count);
}
console.log('--- 主要误判分布 ---');
for (const [key, count] of [...wrong.entries()].slice(0, 15)) {
  console.log(`  ${key} : ${count}`);
}
if (failures.length) {
  console.log('--- 误判样例（最多 60 条）---');
  for (const f of failures) console.log(`  [期望 ${f.expect} / 实际 ${f.got}] ${f.name}`);
}

const minAcc = Number(process.env.CLASSIFIER_MIN_ACC || 0.9);
if (acc < minAcc) {
  console.error(`\n分类准确率 ${(acc * 100).toFixed(2)}% 低于阈值 ${(minAcc * 100).toFixed(0)}%`);
  process.exitCode = 1;
} else {
  console.log(`\n分类准确率达标（>= ${(minAcc * 100).toFixed(0)}%）`);
}
