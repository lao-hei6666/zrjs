'use strict';
/**
 * 导出冒烟测试：用模拟数据验证 21 列顺序、列类型（文本）与文件生成。
 * 运行：npm run test:export
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadConfig } = require('../src/config');
const { exportXlsx, COLUMNS, isRecommended } = require('../src/export/xlsx');

const EXPECTED = [
  '城市', '区县', '场所名称', '详细地址', '场所类型', '纬度', '经度', '联系电话', '微信号',
  '营业时间', '封面图', '人均消费', '评分', '描述', '设施标签', '特色标签', '来源', '来源 ID',
  '是否推荐', '排序权重', '照片数量'
];

const records = [
  {
    id: 'B0FFFZCDHD',
    name: '温莎KTV(北京国贸店)',
    address: '北京市朝阳区建国门外大街甲6号华熙国际中心C座B1层',
    lat: '39.907591',
    lng: '116.457723',
    rating: '4.8',
    price: '98',
    photoCount: 100,
    state: '营业中',
    hours: '10:00-06:00',
    tel: '010-85670777',
    tags: ['免费WIFI', '自助餐', '网红打卡地'],
    typeText: '体育休闲服务;娱乐场所;KTV',
    categoryCode: 'KTV',
    categoryName: 'KTV',
    warnings: [],
    dianping: { ok: true, method: 'name', reason: '同店确认', shop: { name: '温莎KTV(国贸店)', address: '建国门外大街甲6号', href: 'https://www.dianping.com/shop/x' } }
  },
  {
    // 高德未提供评分：评分列应按兜底值 4.0 记；4.0 不高于 4.1，故判为「不推荐」
    id: 'B0NOSCORE01',
    name: '无评分测试KTV(测试店)',
    address: '北京市西城区测试路1号',
    lat: '39.900000',
    lng: '116.400000',
    rating: '',
    price: '',
    photoCount: 30,
    state: '营业中',
    hours: '10:00-02:00',
    tel: '',
    tags: [],
    typeText: '体育休闲服务;娱乐场所;KTV',
    categoryCode: 'KTV',
    categoryName: 'KTV',
    warnings: [],
    dianping: null
  }
];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csjb-export-'));
  const cfg = loadConfig({ outputDir: tmp, delayMs: 0 });
  const file = await exportXlsx(records, cfg, null);
  if (!fs.existsSync(file)) throw new Error('未生成 xlsx 文件');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(cfg.rules.output.sheetName);
  const header = ws.getRow(1).values.slice(1).map(String);
  if (JSON.stringify(header) !== JSON.stringify(EXPECTED) || JSON.stringify(COLUMNS) !== JSON.stringify(EXPECTED)) {
    throw new Error(`表头不正确：\n实际: ${header.join(',')}\n期望: ${EXPECTED.join(',')}`);
  }
  const row2 = ws.getRow(2).values.slice(1);
  const last = row2[row2.length - 1];
  if (String(last) !== '100') throw new Error(`最后一列（照片数量）不正确：${last}`);
  if (String(row2[7]) !== '010-85670777') throw new Error('电话列内容不正确');
  if (String(row2[4]) !== 'KTV') throw new Error('场所类型列应写中文名');
  if (String(row2[1]) !== '朝阳区') throw new Error('区县列应从地址解析出朝阳区');
  // “自助餐”命中设施关键词“自助”，归入设施标签；其余归入特色标签
  if (String(row2[14]) !== '免费WIFI、自助餐') throw new Error('设施标签列不正确');
  if (String(row2[15]) !== '网红打卡地') throw new Error('特色标签列不正确');
  // 该记录评分 4.8 > 4.1，应判为「推荐」
  if (String(row2[18]) !== '推荐') throw new Error(`评分 4.8 应判为「推荐」，实际：${row2[18]}`);
  if (String(row2[12]) !== '4.8') throw new Error(`评分列不正确：${row2[12]}`);

  // 无评分记录：评分列按兜底值 4.0 记，且 4.0 不高于 4.1 → 不推荐（两列必须自洽）
  const row3 = ws.getRow(3).values.slice(1);
  if (String(row3[12]) !== '4.0') throw new Error(`无评分记录的评分列应为兜底值 4.0，实际：${row3[12]}`);
  if (String(row3[18]) !== '不推荐') throw new Error(`无评分记录应为「不推荐」，实际：${row3[18]}`);

  // 推荐阈值边界：严格大于 4.1；缺失 / 空串 / 非数字一律不推荐
  const cases = [
    [4.8, true], ['4.8', true], [4.11, true], [5, true], ['5.0', true],
    [4.1, false], ['4.1', false], [4.0, false], [0, false],
    ['', false], [null, false], [undefined, false], ['无', false]
  ];
  for (const [rating, expect] of cases) {
    const got = isRecommended(rating, cfg);
    if (got !== expect) {
      throw new Error(`推荐判定错误：评分 ${JSON.stringify(rating)} 期望 ${expect} 实际 ${got}`);
    }
  }

  const detail = wb.getWorksheet('采集明细');
  if (!detail || String(detail.getRow(2).getCell(1).value) !== '温莎KTV(北京国贸店)') throw new Error('采集明细表缺失或不正确');

  console.log(`export: 通过（文件已生成于 ${file}）`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error('export 测试失败：', e.message);
  process.exit(1);
});
