'use strict';
/** 营业时间解析与 23:00 阈值回归用例（node test/businessHours.test.js） */
const assert = require('assert');
const { parseBusinessHours, closesAfter, detectOpenState, isOperatingNormally, timeToMinutes } = require('../src/clean/businessHours');

const cases = [
  // [文本, 期望结束分钟, 期望是否晚于23点]
  ['12:00-05:00', 1740, true],
  ['10:00-01:00', 1500, true],
  ['11:00-24:00', 1440, true],
  ['11:00-23:00', 1380, false],
  ['10:00-22:00', 1320, false],
  ['20:00-02:00', 1560, true],
  ['休息中 11:00-24:00', 1440, true],
  ['营业中 18:00-次日02:00', 1560, true],
  ['24小时营业', 1440, true],
  ['全天营业', 1440, true],
  ['10:00-14:00 17:00-22:00', 1320, false],
  ['10:00-14:00 19:00-01:30', 1530, true],
  ['11:00 开始营业', null, false],
  ['00:00-00:00', 1440, true],
  ['周一至周日 10:00—23:30', 1410, true],
  ['', null, false]
];

let pass = 0;
for (const [text, expectEnd, expectLate] of cases) {
  const parsed = parseBusinessHours(text);
  const late = closesAfter(text, '23:00');
  try {
    if (expectEnd !== null) assert.strictEqual(parsed.lastEnd, expectEnd, `lastEnd of "${text}"`);
    assert.strictEqual(late, expectLate, `closesAfter("${text}")`);
    pass += 1;
  } catch (e) {
    console.error(`FAIL  "${text}" -> parsed=${JSON.stringify(parsed)} late=${late} (期望 lastEnd=${expectEnd}, late=${expectLate})`);
    process.exitCode = 1;
  }
}

// 状态判定
const stateCases = [
  ['休息中 11:00-24:00', 'resting', true],
  ['营业中', 'open', true],
  ['商家已关闭', 'closed', false],
  ['暂停营业', 'closed', false],
  ['歇业', 'closed', false],
  ['即将开业', 'closed', false],
  ['', 'unknown', true]
];
for (const [text, expectState, expectNormal] of stateCases) {
  try {
    assert.strictEqual(detectOpenState(text), expectState, `detectOpenState("${text}")`);
    assert.strictEqual(isOperatingNormally(text), expectNormal, `isOperatingNormally("${text}")`);
    pass += 1;
  } catch (e) {
    console.error(`FAIL  state "${text}" -> ${detectOpenState(text)} / ${isOperatingNormally(text)}（期望 ${expectState}/${expectNormal}）`);
    process.exitCode = 1;
  }
}

assert.strictEqual(timeToMinutes('23:00'), 1380);
console.log(`businessHours: ${pass} 组用例通过${process.exitCode ? '（存在失败）' : ''}`);
