'use strict';
/**
 * 浏览器：持久化登录态的可见 Chrome。
 * 关键点：
 *  - headless 必须为 false（需要人工登录 / 过验证码）
 *  - 使用 launchPersistentContext + 独立 userDataDir，登录态长期保留
 *  - 削弱自动化特征，降低风控概率
 *  - 提供“等待登录”“等待人工处理验证码”机制
 */
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { chromium } = require('playwright');
const { ensureDir } = require('../config');
const { sleep } = require('../pace');
const { findBrowser, processNames } = require('../browserPath');

const STEALTH_INIT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  // eslint-disable-next-line no-proto
  window.chrome = window.chrome || { runtime: {} };
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(window.navigator.permissions, params);
  }
};

const CDP_PORT = 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/** 解析 browserChannel：'auto' 时按本机实际安装的浏览器选择（本机为 Edge） */
function resolveChannel(requested) {
  if (requested && requested !== 'auto') return requested;
  const found = findBrowser();
  return found ? found.channel : 'chrome';
}

/** 查占用指定 profile 的浏览器进程 PID（mainOnly=true 时排除渲染/GPU 等 --type= 子进程） */
function queryProfilePids(profileWin, mainOnly) {
  const esc = String(profileWin).replace(/'/g, "''");
  const names = processNames().map((n) => `Name='${n}'`).join(' OR ');
  const ps = `Get-CimInstance Win32_Process -Filter "${names}" | ` +
    `Where-Object { $_.CommandLine -like '*${esc}*'${mainOnly ? " -and $_.CommandLine -notlike '*--type=*'" : ''} } | ` +
    'Select-Object -ExpandProperty ProcessId';
  try {
    const text = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    return [...new Set(text.split(/\s+/).filter(Boolean))];
  } catch (e) {
    return [];
  }
}

/**
 * 释放浏览器 profile：关闭所有占用该 profile 的浏览器窗口。
 *
 * 为什么必须做：Chromium 系浏览器同一个 user-data-dir 同一时刻只能被一个实例持有。
 * 「每次启动都新建窗口」因此必须实现为「先释放旧窗口 → 再新建窗口」；
 * 登录态保存在 profile 中，关闭窗口不会丢失。
 *
 * 只会关闭命令行里带该 profile 路径的进程，不会影响用户自己其它 profile 的浏览器窗口。
 * @returns {Promise<boolean>} profile 是否已释放干净
 */
async function closeProfileBrowsers(profileDir, { logger, force = true, waitMs = 8000 } = {}) {
  const profileWin = String(profileDir).replace(/\//g, '\\');
  const before = queryProfilePids(profileWin, false);
  if (!before.length) {
    if (logger) logger.info('未发现占用 profile 的旧窗口，无需释放');
    return false;
  }

  const mains = queryProfilePids(profileWin, true);
  const targets = mains.length ? mains : before;
  if (logger) logger.info(`检测到占用 profile 的旧窗口（PID ${targets.join(', ')}），先关闭它以便新建窗口…`);

  // 不带 /F 的 taskkill 等价于「点窗口关闭按钮」，让浏览器有机会把登录态写盘
  for (const pid of targets) {
    try { execFileSync('taskkill', ['/PID', pid], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  }
  let deadline = Date.now() + waitMs;
  while (Date.now() < deadline && queryProfilePids(profileWin, false).length) await sleep(700);

  let left = queryProfilePids(profileWin, false);
  if (left.length && force) {
    for (const pid of left) {
      try { execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    deadline = Date.now() + 5000;
    while (Date.now() < deadline && queryProfilePids(profileWin, false).length) await sleep(700);
    left = queryProfilePids(profileWin, false);
  }
  if (logger) {
    if (left.length) logger.warn(`仍有 ${left.length} 个进程占用 profile，窗口启动可能失败`);
    else logger.ok('旧窗口已关闭，profile 已释放（登录态保留在 profile 中）');
  }
  return left.length === 0;
}

/** 普通模式新窗口的初始页（pipeline 随后会自行 goto 到目标页） */
const HOME_URL = 'https://ditu.amap.com/';

/** 等待 CDP 调试端口就绪 */
async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP_URL}/json/version`);
      if (res && res.ok) return true;
    } catch (e) { /* 端口还没起来 */ }
    await sleep(500);
  }
  return false;
}

/**
 * 以「普通方式」新建一个浏览器窗口：不带任何 Playwright 自动化标记
 * （没有 --no-sandbox / --enable-automation），只开放 CDP 调试端口，随后由 connectOverCDP 接管。
 *
 * 这是本项目的关键经验：高德使用阿里 baxia 风控，会识别 Playwright 直接启动的浏览器并持续弹滑块；
 * 以普通方式启动的窗口没有自动化痕迹，滑块可以正常通过。
 */
function spawnPlainBrowser({ exe, profileDir, port, urls = [] }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-default-browser-check',
    '--no-first-run',
    '--start-maximized',
    ...urls
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/**
 * 默认启动方式：每次以普通模式新建一个窗口，再通过 CDP 接管。
 * @returns {Promise<object|null>} 失败返回 null，由调用方回退到 Playwright 直接启动
 */
async function launchViaCdp(cfg, logger) {
  const picked = findBrowser();
  if (!picked) {
    logger.warn('未探测到本机 Microsoft Edge / Google Chrome，无法使用普通模式窗口');
    return null;
  }

  // 同一 user-data-dir 只能被一个浏览器实例持有：先释放旧窗口，再新建
  if (cfg.rules.amap.closeProfileBeforeLaunch !== false) {
    await closeProfileBrowsers(cfg.paths.profileDir, { logger });
  }

  logger.info(`正在以普通模式新建浏览器窗口（${picked.name}，不带自动化标记）…`);
  spawnPlainBrowser({
    exe: picked.exe,
    profileDir: cfg.paths.profileDir,
    port: CDP_PORT,
    urls: [HOME_URL]
  });

  if (!(await waitForCdp(30000))) {
    logger.warn('等待浏览器调试端口超时，改用 Playwright 直接启动');
    return null;
  }

  const browserConn = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  const ctx = browserConn.contexts()[0] || (await browserConn.newContext());
  // 接管的是普通窗口：不注入任何脚本，结束时只断开连接、不关闭窗口
  ctx.__csjbExternal = true;
  logger.info(`已接管新建的浏览器窗口（普通模式，CDP ${CDP_URL}）`);
  return ctx;
}

/**
 * 启动浏览器（默认每次新建一个窗口）：
 *  1) 若开启 reuseExistingBrowser 且有窗口开放 CDP 调试端口，则直接接管（默认关闭）；
 *  2) 否则先释放占用 profile 的旧窗口，再用持久化 profile 新建一个可见窗口（登录态长期保留）；
 *  3) 浏览器优先使用本机安装的 Edge（本机无 Chrome），channel 由 browserPath.js 自动探测。
 */
async function createBrowser(cfg, logger) {
  ensureDir(cfg.paths.profileDir);

  // 1) 复用已有窗口（默认关闭：需求是每次启动该程序都新建一个窗口开始工作）
  if (cfg.rules.amap.reuseExistingBrowser === true) {
    try {
      const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 1500 });
      const ctx = browser.contexts()[0];
      if (ctx) {
        // 复用你自己启动的 Chrome：不再注入任何脚本，保持“纯净浏览器”状态，降低风控强度；
        // 打上标记，结束时只断开连接、不关闭浏览器窗口。
        ctx.__csjbExternal = true;
        logger.info(`已连接到正在运行的浏览器窗口（复用登录态，CDP ${CDP_URL}）`);
        return ctx;
      }
      await browser.close();
    } catch (e) { /* 没有可复用的窗口，继续启动新的 */ }
  }

  // 2) 默认：以普通模式新建窗口并接管（反爬最优，窗口本身没有自动化标记）
  const launchMode = cfg.rules.amap.launchMode || 'cdp';
  if (launchMode === 'cdp') {
    try {
      const cdpCtx = await launchViaCdp(cfg, logger);
      if (cdpCtx) return cdpCtx;
    } catch (e) {
      logger.warn(`普通模式新建窗口失败（${String(e.message || e).split('\n')[0]}），回退到 Playwright 直接启动`);
    }
  }

  // 3) 兜底：Playwright 直接启动持久化上下文。
  //    走 cdp 分支时已释放过 profile，这里幂等再确认一次：同一 user-data-dir 只能被一个实例持有。
  if (cfg.rules.amap.closeProfileBeforeLaunch !== false) {
    await closeProfileBrowsers(cfg.paths.profileDir, { logger });
  }

  // 尽量少留自动化痕迹：去掉 Playwright 默认注入的 --no-sandbox / --enable-automation，
  // 这两者会让页面顶部出现“不受支持的命令行标记”警告，并明显提高反爬判定强度（滑块验证会一直失败）。
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--no-first-run',
    '--start-maximized'
  ];
  if (cfg.rules.amap.remoteDebug) args.push(`--remote-debugging-port=${CDP_PORT}`);

  const options = {
    headless: cfg.headless,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    ignoreDefaultArgs: ['--no-sandbox', '--enable-automation'],
    args
  };
  let ctx;
  const channel = resolveChannel(cfg.rules.amap.browserChannel);
  const picked = findBrowser();
  try {
    ctx = await chromium.launchPersistentContext(cfg.paths.profileDir, { ...options, channel });
    logger.info(`已新建浏览器窗口（${picked ? picked.name : 'Playwright 内置 Chromium'}，channel=${channel}，headless=${cfg.headless}）`);
  } catch (e) {
    const msg = String(e.message || '');
    const locked = /Target page, context or browser has been closed|ProcessSingleton|user data directory is already in use/i.test(msg);
    if (locked) {
      throw new Error(
        `浏览器 profile 正被占用（${cfg.paths.profileDir}）。` +
        '通常是上一次运行/登录用的浏览器窗口还开着：请关闭它（登录状态已保存在 profile 中，不会丢失），' +
        '或先执行 `node tools/close-browser.js` 自动优雅关闭后再重试。'
      );
    }
    logger.warn(`channel=${channel} 启动失败（${msg.split('\n')[0]}），回退到 Playwright 自带 Chromium`);
    try {
      ctx = await chromium.launchPersistentContext(cfg.paths.profileDir, options);
    } catch (e2) {
      throw new Error(
        `浏览器启动失败：${String(e2.message).split('\n')[0]}\n` +
        '可尝试：1) node tools/close-browser.js 关闭占用 profile 的旧窗口；' +
        '2) 确认本机已安装 Microsoft Edge 或 Google Chrome；' +
        '3) npx playwright install chromium 安装内置浏览器。'
      );
    }
  }
  await ctx.addInitScript(STEALTH_INIT);
  return ctx;
}

async function cookieNames(page, url) {
  try {
    const cookies = await page.context().cookies(url);
    return cookies.map((c) => c.name);
  } catch (e) {
    return [];
  }
}

/**
 * 判断高德是否已登录。
 * 登录后会写入 passport_login 之类的通行证 cookie（比页面文案可靠得多）。
 */
async function isAmapLoggedIn(page) {
  const names = await cookieNames(page, 'https://ditu.amap.com');
  if (names.includes('passport_login') || names.includes('lswucn') || names.includes('mooc_userinfo')) return true;
  try {
    return await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const hasLoginEntry = /请登录|登录\/注册|立即登录/.test(txt);
      const hasUserEntry = /退出登录|我的收藏|我的订单/.test(txt);
      return hasUserEntry && !hasLoginEntry;
    });
  } catch (e) {
    return false;
  }
}

/** 判断大众点评是否已登录（dper / ctu 为登录态 cookie） */
async function isDianpingLoggedIn(page) {
  const names = await cookieNames(page, 'https://www.dianping.com');
  if (names.includes('dper') || names.includes('ctu')) return true;
  try {
    return await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const notLogged = /请登录\/注册|你好，请登录|登录\/注册/.test(txt);
      const logged = /退出登录|我的点评|我的收藏/.test(txt);
      return logged && !notLogged;
    });
  } catch (e) {
    return false;
  }
}

/** 输出当前 cookie 名（登录排查用） */
async function loginDebugInfo(page, url) {
  return { cookies: await cookieNames(page, url) };
}

/**
 * 清除高德风控惩罚令牌（x5secdata / x5sectag）。
 * 一旦被判定异常，这两个 cookie 会让后续请求持续跳验证码；清掉后重新评估。
 */
async function resetAmapPunish(ctx, logger) {
  let cleared = 0;
  for (const name of ['x5secdata', 'x5sectag', 'x5sectag']) {
    try {
      await ctx.clearCookies({ name });
      cleared += 1;
    } catch (e) { /* 旧版本 Playwright 不支持带过滤的 clearCookies */ }
  }
  if (cleared && logger) logger.info('已清除高德风控惩罚令牌（x5secdata/x5sectag），重新评估本次会话');
  return cleared > 0;
}

/** 页面是否出现验证码/滑块（含高德风控 punish 弹窗：主文档 .baxia-dialog + iframe 内的滑块） */
async function hasCaptcha(page) {
  // 1) 主文档信号
  try {
    const main = await page.evaluate(() => {
      const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
      const dialog = document.querySelector('.baxia-dialog, .baxia-dialog-auto, [class*=baxia-dialog]');
      if (vis(dialog)) return true;
      const sel = ['[class*=captcha]', '[id*=captcha]', '[class*=verify]', '[id*=verify]', '.nc-container', '#nc_1_wrapper'];
      for (const s of sel) {
        if (vis(document.querySelector(s))) return true;
      }
      return /拖动滑块|滑块验证|安全验证|请按住滑块|点击验证|我们马上回来/.test(document.body.innerText || '');
    });
    if (main) return true;
  } catch (e) { /* ignore */ }

  // 2) iframe 信号（高德风控把滑块放在 _____tmd_____/punish 的 iframe 里）
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url() || '';
    if (/\/punish|action=captcha|x5step/i.test(url)) return true;
    try {
      const t = await frame.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 300));
      if (/请按住滑块|拖动到最右边|滑动下方滑块|验证失败/.test(t)) return true;
    } catch (e) { /* cross-origin ignore */ }
  }
  return false;
}

/**
 * 等待登录：轮询检测，最长等待 timeoutMinutes（默认 15 分钟）。
 * @returns {Promise<boolean>}
 */
async function waitForLogin(page, { site, check, logger, timeoutMinutes = 15 }) {
  logger.wait(`等待【${site}】登录：请在已打开的浏览器窗口中完成登录，登录后自动继续…`);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let warned = false;
  while (Date.now() < deadline) {
    if (await hasCaptcha(page)) {
      logger.wait(`【${site}】检测到验证码/滑块，请手动完成后继续…`);
      await sleep(5000);
      continue;
    }
    if (await check(page)) {
      logger.ok(`【${site}】登录状态已确认`);
      return true;
    }
    if (!warned && Date.now() > deadline - (timeoutMinutes - 1) * 60 * 1000) {
      warned = true;
      logger.warn(`【${site}】仍未检测到登录，将继续等待（最长 ${timeoutMinutes} 分钟）`);
    }
    await sleep(3000);
  }
  logger.warn(`【${site}】等待登录超时，继续执行（可能因未登录导致照片数等信息不准确）`);
  return false;
}

/** 等待人工处理验证码（页面恢复后自动继续） */
async function waitForCaptchaClear(page, { site, logger, timeoutMinutes = 10 }) {
  if (!(await hasCaptcha(page))) return true;
  logger.wait(`【${site}】出现验证码/滑块，请在浏览器中手动完成，完成后脚本自动继续…`);
  logger.warn('若滑块一直提示“验证失败”，说明当前浏览器被识别为自动化环境：请关闭浏览器后运行 `npm run browser`'
    + '（用普通方式启动本机 Chrome）再重试，脚本会自动接管该窗口。');
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(4000);
    if (!(await hasCaptcha(page))) {
      logger.ok(`【${site}】验证码已通过，继续执行`);
      return true;
    }
  }
  logger.error(`【${site}】验证码长时间未通过，跳过当前条目`);
  return false;
}

/** 确保高德处于“新版”界面（旧版没有照片数/营业时间） */
async function ensureAmapNewVersion(page, logger, pace) {
  try {
    const needsToggle = await page.evaluate(() => {
      const el = document.querySelector('div.new-version-handle, .new-version-handle');
      return !!(el && (el.offsetWidth || el.offsetHeight));
    });
    if (needsToggle && pace) await pace.pace('切换到高德新版界面');
    const handled = await page.evaluate(() => {
      const el = document.querySelector('div.new-version-handle, .new-version-handle');
      if (el && (el.offsetWidth || el.offsetHeight)) { el.click(); return true; }
      return false;
    });
    if (handled) {
      logger.info('检测到高德旧版界面，已切换到新版');
      await sleep(4000);
    }
  } catch (e) { /* ignore */ }
}

/**
 * 结束时的浏览器处理：
 *  - 连接的是你自己启动的 Chrome（外部窗口）→ 只断开，不关闭窗口；
 *  - 由 Playwright 启动的浏览器 → 正常关闭（登录态已落盘）。
 */
async function disposeBrowser(ctx, logger) {
  if (!ctx) return;
  if (ctx.__csjbExternal) {
    if (logger) logger.info('已断开与浏览器窗口的连接（窗口保持打开，登录态已保存）');
    return;
  }
  try {
    await ctx.close();
  } catch (e) { /* ignore */ }
}

module.exports = {
  createBrowser,
  closeProfileBrowsers,
  disposeBrowser,
  isAmapLoggedIn,
  isDianpingLoggedIn,
  hasCaptcha,
  waitForLogin,
  waitForCaptchaClear,
  ensureAmapNewVersion,
  loginDebugInfo,
  resetAmapPunish,
  STEALTH_INIT,
  CDP_URL
};
