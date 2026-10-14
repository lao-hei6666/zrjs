#!/usr/bin/env node
'use strict';
/**
 * 登录助手：打开可见浏览器并停在需要登录的页面上，轮询登录状态。
 *  - 登录态保存在 .browser-profile（下次无需重复登录）；
 *  - 状态写入 data/logs/login-status.json，便于外部/脚本判断；
 *  - 两个站点都登录后仍会保持浏览器窗口打开，方便直接开始采集（采集会复用该窗口）。
 *
 * 用法：npm run login   （或 node tools/login.js）
 *       Ctrl+C 结束；结束前请确认已登录完成。
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, ensureDir } = require('../src/config');
const { Logger } = require('../src/logger');
const { createBrowser, disposeBrowser, isAmapLoggedIn, isDianpingLoggedIn, hasCaptcha, CDP_URL } = require('../src/amap/browser');
const { createPacer, sleep } = require('../src/pace');

const HOLD_MINUTES = Number(process.env.CSJB_LOGIN_HOLD_MINUTES || 60);

(async () => {
  const cfg = loadConfig({ headless: false });
  const logger = new Logger({ logDir: cfg.paths.logDir });
  const statusFile = path.join(ensureDir(cfg.paths.logDir), 'login-status.json');
  let lastLine = '';
  const writeStatus = (amap, dianping, note) => {
    try {
      fs.writeFileSync(statusFile, JSON.stringify({
        amap, dianping, note: note || '', cdp: CDP_URL, updatedAt: new Date().toISOString()
      }, null, 1), 'utf8');
    } catch (e) { /* ignore */ }
  };

  const pace = createPacer(cfg.rules.delayMs, logger, cfg.rules.paceMode || 'strict');
  const ctx = await createBrowser(cfg, logger);
  const amapPage = ctx.pages()[0] || (await ctx.newPage());
  await pace.pace('打开高德地图首页');
  await amapPage.goto('https://ditu.amap.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);

  const dpPage = await ctx.newPage();
  await pace.pace('打开大众点评首页');
  await dpPage.goto(cfg.rules.dianping.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await pace.pace('切换到大众点评标签页');
  await dpPage.bringToFront().catch(() => {});
  await sleep(2500);

  logger.wait('请在浏览器窗口中登录【大众点评】（如需，也请确认【高德地图】保持登录）。登录完成后脚本会自动识别。');
  logger.info(`登录态保存在：${path.join(cfg.paths.profileDir)}（无需重复登录）`);

  const deadline = Date.now() + HOLD_MINUTES * 60 * 1000;
  let bothLogged = false;
  while (Date.now() < deadline) {
    const amapCaptcha = await hasCaptcha(amapPage);
    const dpCaptcha = await hasCaptcha(dpPage);
    const amap = await isAmapLoggedIn(amapPage);
    const dianping = await isDianpingLoggedIn(dpPage);
    const line = `高德=${amap ? '已登录✅' : '未登录❌'}  大众点评=${dianping ? '已登录✅' : '未登录❌'}` +
      `${amapCaptcha || dpCaptcha ? '  （检测到验证码，请手动完成）' : ''}`;
    if (line !== lastLine) {
      logger.info(line);
      lastLine = line;
    }
    writeStatus(amap, dianping, line);
    if (amap && dianping && !bothLogged) {
      bothLogged = true;
      logger.ok('两个站点均已登录，登录态已保存。现在可以点击「开始采集」或运行 npm run collect 了。');
    }
    await sleep(10000);
  }
  logger.info('登录助手退出（浏览器窗口保持打开，登录态已保存）。');
  await disposeBrowser(ctx, logger);
  await logger.close();
  // CDP 连接会阻止事件循环退出，显式结束进程（浏览器窗口保持打开）
  process.exit(0);
})().catch((e) => {
  console.error('登录助手失败：', e.message);
  process.exit(1);
});
