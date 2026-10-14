'use strict';
/**
 * 登录状态检查（含原始信号输出，便于校准检测逻辑）。
 * 用法：node tools/check-login.js
 */
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/logger');
const { createBrowser, disposeBrowser, isAmapLoggedIn, isDianpingLoggedIn, hasCaptcha } = require('../src/amap/browser');
const { sleep } = require('../src/pace');

function cookieNames(cookies) {
  return cookies.map((c) => c.name).join(', ');
}

(async () => {
  const cfg = loadConfig({ headless: false });
  const logger = new Logger({ logDir: cfg.paths.logDir });
  const ctx = await createBrowser(cfg, logger);
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    // ---------- 高德 ----------
    await page.goto('https://ditu.amap.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const amapSignals = await page.evaluate(async () => {
      let checklogin = '';
      try {
        const r = await fetch('/service/checklogin', { credentials: 'include' });
        checklogin = await r.text();
      } catch (e) { checklogin = `ERR:${e.message}`; }
      const txt = document.body.innerText || '';
      return {
        checklogin,
        hasLoginEntry: /请登录|登录\/注册|立即登录/.test(txt),
        bodyHead: txt.slice(0, 200).replace(/\s+/g, ' ')
      };
    });
    const amapCookies = (await ctx.cookies('https://ditu.amap.com')).map((c) => c.name);
    logger.info(`高德 登录判定=${(await isAmapLoggedIn(page)) ? '已登录' : '未登录'}｜验证码=${await hasCaptcha(page)}`);
    logger.info(`高德 /service/checklogin 返回：${amapSignals.checklogin.slice(0, 200)}`);
    logger.info(`高德 页面是否含登录入口：${amapSignals.hasLoginEntry}`);
    logger.info(`高德 页面文本：${amapSignals.bodyHead.slice(0, 120)}`);
    logger.info(`高德 cookie（${amapCookies.length}）：${amapCookies.join(', ')}`);

    // ---------- 大众点评 ----------
    const dp = await ctx.newPage();
    await dp.goto(cfg.rules.dianping.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const dpSignals = await dp.evaluate(() => {
      const txt = document.body.innerText || '';
      return {
        hasLoginEntry: /请登录\/注册|你好，请登录/.test(txt),
        hasLogout: /退出登录|我的点评|个人中心/.test(txt),
        bodyHead: txt.slice(0, 200).replace(/\s+/g, ' ')
      };
    });
    const dpCookies = (await ctx.cookies('https://www.dianping.com')).map((c) => c.name);
    logger.info(`点评 登录判定=${(await isDianpingLoggedIn(dp)) ? '已登录' : '未登录'}｜验证码=${await hasCaptcha(dp)}`);
    logger.info(`点评 是否含登录入口=${dpSignals.hasLoginEntry}｜是否含个人中心/退出=${dpSignals.hasLogout}`);
    logger.info(`点评 页面文本：${dpSignals.bodyHead.slice(0, 120)}`);
    logger.info(`点评 cookie（${dpCookies.length}）：${dpCookies.join(', ')}`);
  } finally {
    await sleep(1000);
    await disposeBrowser(ctx, logger);
    await logger.close();
  }
  // CDP 连接会阻止事件循环退出，显式结束进程（浏览器窗口保持打开）
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
