'use strict';
/** 被过滤/被拒绝条目的可复核报告（json + csv） */
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./config');

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeRejectReport(rejects, cfg, logger) {
  const dir = ensureDir(cfg.paths.reportDir);
  const ts = stamp();
  const jsonFile = path.join(dir, `rejected_${ts}.json`);
  const csvFile = path.join(dir, `rejected_${ts}.csv`);
  fs.writeFileSync(jsonFile, JSON.stringify(rejects, null, 1), 'utf8');

  const header = ['阶段', '分类', '场所名称', '地址', '照片数量', '营业时间', '营业状态', '过滤原因', '高德ID', '链接'];
  const lines = [header.join(',')];
  for (const r of rejects) {
    lines.push([
      r.stage, r.category, r.name, r.address, r.photoCount, r.hours, r.state, r.reason, r.id, r.url
    ].map(csvEscape).join(','));
  }
  fs.writeFileSync(csvFile, `\uFEFF${lines.join('\n')}`, 'utf8');
  if (logger) logger.info(`已输出被过滤条目报告：${csvFile}（共 ${rejects.length} 条）`);
  return { jsonFile, csvFile };
}

module.exports = { writeRejectReport };
