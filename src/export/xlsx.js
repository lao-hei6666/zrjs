'use strict';
/**
 * 导出 xlsx：严格按“场所录入表单字段 + 照片数量”共 21 列输出，一行一个场所。
 * 最后一张附加表「采集明细」记录高德 ID、高德分类、大众点评核验结果等追溯信息，便于人工复核。
 */
const path = require('path');
const ExcelJS = require('exceljs');
const { ensureDir } = require('../config');
const { extractDistrict } = require('../clean/normalize');

const COLUMNS = [
  '城市', '区县', '场所名称', '详细地址', '场所类型', '纬度', '经度', '联系电话', '微信号',
  '营业时间', '封面图', '人均消费', '评分', '描述', '设施标签', '特色标签', '来源', '来源 ID',
  '是否推荐', '排序权重', '照片数量'
];

const TEXT_COLUMNS = ['纬度', '经度', '联系电话', '微信号', '营业时间', '来源 ID', '照片数量', '人均消费', '评分'];

const WIDTHS = {
  城市: 10, 区县: 10, 场所名称: 36, 详细地址: 46, 场所类型: 14, 纬度: 12, 经度: 12,
  联系电话: 24, 微信号: 14, 营业时间: 18, 封面图: 16, 人均消费: 10, 评分: 8, 描述: 40,
  设施标签: 26, 特色标签: 26, 来源: 10, '来源 ID': 14, 是否推荐: 10, 排序权重: 10, 照片数量: 10
};

function splitTags(tags, facilityKeywords) {
  const facility = [];
  const feature = [];
  const keys = (facilityKeywords || []).map((k) => k.toLowerCase());
  for (const t of tags || []) {
    const low = String(t).toLowerCase();
    if (keys.some((k) => low.includes(k))) facility.push(t);
    else feature.push(t);
  }
  return { facility, feature };
}

/**
 * 是否推荐：评分**严格高于**阈值（默认 4.1）即推荐。
 * 评分缺失、空串或非数字一律判为不推荐（不臆造评分）。
 * @param {string|number} rating 高德评分（通常是字符串）
 * @param {object} cfg 配置（阈值取 cfg.rules.recommendRatingAbove）
 */
function isRecommended(rating, cfg) {
  const raw = rating === null || rating === undefined ? '' : String(rating).trim();
  if (!raw) return false;
  const value = Number(raw);
  if (!Number.isFinite(value)) return false;
  const threshold = Number(cfg && cfg.rules ? cfg.rules.recommendRatingAbove : 4.1);
  return Number.isFinite(threshold) && value > threshold;
}

/** 把采集记录映射为表格一行（21 列） */
function toRow(record, cfg) {
  const { facility, feature } = splitTags(record.tags, cfg.rules.facilityKeywords);
  const address = record.address || '';
  // 评分：高德未给出评分时用兜底值（默认 4.0）。「评分」列与「是否推荐」共用这一个值，
  // 保证两列永远自洽 —— 不会出现“评分 4.0 却推荐”或“评分空白却推荐”这类矛盾。
  const rating = record.rating || (cfg.rules.defaults && cfg.rules.defaults.rating) || '';
  return {
    城市: record.cityName || cfg.rules.amap.cityName || '北京市',
    区县: extractDistrict(address) || record.districtName || '',
    场所名称: record.name || '',
    详细地址: address,
    场所类型: record.categoryName || '',
    纬度: record.lat || '',
    经度: record.lng || '',
    联系电话: record.tel || '',
    微信号: '',
    营业时间: record.hours || '',
    封面图: '',
    人均消费: record.price || '',
    评分: rating,
    描述: record.description || '',
    设施标签: facility.join('、'),
    特色标签: feature.join('、'),
    来源: cfg.rules.source || 'amap',
    '来源 ID': record.id || '',
    是否推荐: isRecommended(rating, cfg) ? '推荐' : '不推荐',
    排序权重: cfg.rules.defaults.sortWeight ?? 0,
    照片数量: record.photoCount === null || record.photoCount === undefined ? '' : record.photoCount
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function exportXlsx(records, cfg, logger, options = {}) {
  const outDir = ensureDir(cfg.rules.output.dir);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'csjb-amap-collector';
  wb.created = new Date();

  const ws = wb.addWorksheet(cfg.rules.output.sheetName || '场所列表');
  ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: WIDTHS[c] || 14 }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.height = 22;
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E90FF' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const rec of records) {
    const row = toRow(rec, cfg);
    ws.addRow(row);
  }
  // 文本列避免被 Excel 自动转成数字/日期（如 010-xxx 电话、40.032125 经纬度）
  for (const name of TEXT_COLUMNS) {
    const col = ws.getColumn(name);
    if (col) col.numFmt = '@';
  }
  for (let i = 2; i <= ws.rowCount; i += 1) {
    ws.getRow(i).alignment = { vertical: 'top', wrapText: false };
  }

  // 明细表：追溯信息
  const detail = wb.addWorksheet('采集明细');
  detail.columns = [
    { header: '场所名称', key: 'name', width: 36 },
    { header: '高德 POI ID', key: 'id', width: 14 },
    { header: '高德分类文本', key: 'typeText', width: 32 },
    { header: '归类结果', key: 'categoryName', width: 14 },
    { header: '照片数量', key: 'photoCount', width: 10 },
    { header: '营业状态', key: 'state', width: 10 },
    { header: '营业时间', key: 'hours', width: 18 },
    { header: '大众点评名称', key: 'dpName', width: 34 },
    { header: '大众点评地址', key: 'dpAddress', width: 40 },
    { header: '大众点评链接', key: 'dpHref', width: 40 },
    { header: '同店判定方式', key: 'dpMethod', width: 14 },
    { header: '核验说明', key: 'dpReason', width: 46 },
    { header: '告警', key: 'warnings', width: 30 }
  ];
  detail.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  detail.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A84FF' } };
  });
  detail.views = [{ state: 'frozen', ySplit: 1 }];
  for (const rec of records) {
    const dp = rec.dianping || {};
    detail.addRow({
      name: rec.name,
      id: rec.id,
      typeText: rec.typeText || '',
      categoryName: rec.categoryName || '',
      photoCount: rec.photoCount,
      state: rec.state || '',
      hours: rec.hours || '',
      dpName: dp.shop ? dp.shop.name : '',
      dpAddress: dp.shop ? dp.shop.address : '',
      dpHref: dp.shop ? dp.shop.href : '',
      dpMethod: dp.method || '',
      dpReason: dp.reason || '',
      warnings: (rec.warnings || []).join('；')
    });
  }

  const file = path.join(outDir, `${cfg.rules.output.filePrefix}_${stamp()}.xlsx`);
  await wb.xlsx.writeFile(file);
  if (logger) logger.ok(`已导出表格：${file}（${records.length} 行 × ${COLUMNS.length} 列）`);
  return file;
}

module.exports = { exportXlsx, toRow, isRecommended, COLUMNS };
