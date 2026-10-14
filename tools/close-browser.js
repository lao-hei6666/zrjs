#!/usr/bin/env node
'use strict';
/**
 * 优雅关闭占用采集 profile 的浏览器窗口（登录态保存在 profile 里，关闭不会丢失）。
 *
 * 实现复用 src/amap/browser.js 的 closeProfileBrowsers：
 * 只关闭「命令行里带本 profile 路径」的 Edge / Chrome 进程，不影响其它 profile 的浏览器窗口。
 *
 * 用法：
 *   node tools/close-browser.js            # 优雅关闭，必要时自动强杀兜底
 *   node tools/close-browser.js --force    # 兼容旧用法（现在默认即带兜底）
 */
const { loadConfig } = require('../src/config');
const { closeProfileBrowsers } = require('../src/amap/browser');

const logger = {
  info: (m) => console.log(m),
  ok: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m)
};

(async () => {
  const cfg = loadConfig();
  console.log(`profile: ${cfg.paths.profileDir.replace(/\//g, '\\')}`);
  const released = await closeProfileBrowsers(cfg.paths.profileDir, { logger, force: true });
  if (!released) console.log('未发现占用该 profile 的浏览器窗口（或已释放干净）。');
  process.exit(0);
})().catch((e) => {
  console.error(`关闭失败：${e.message}`);
  process.exit(1);
});
