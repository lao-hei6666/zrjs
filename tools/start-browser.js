#!/usr/bin/env node
'use strict';
/**
 * 以「普通方式」启动本机 Chromium 系浏览器（Edge 优先，本机无 Chrome 时用 Edge），
 * 不带 Playwright 的自动化标记，只开放调试端口供采集脚本接管。
 *
 * 为什么必须这样做：高德使用阿里 baxia 风控，会识别 Playwright 直接启动的浏览器
 * （带 --no-sandbox / --enable-automation 等自动化标记），导致滑块验证码无法通过。
 * 用普通方式启动的窗口没有自动化痕迹，滑块可正常通过。
 *
 * 本机没有 Google Chrome，因此这里改为优先使用 Microsoft Edge（同为 Chromium 内核）。
 *
 * 用法：node tools/start-browser.js     （或 npm run browser）
 *       启动后在窗口里登录高德 / 大众点评；登录态保存在 .browser-profile，下次无需重复登录。
 */
const { spawn } = require('child_process');
const { loadConfig } = require('../src/config');
const { findBrowser } = require('../src/browserPath');
const { closeProfileBrowsers } = require('../src/amap/browser');

const cfg = loadConfig();
const port = Number(process.env.CSJB_CDP_PORT || 9333);
const browser = findBrowser();

if (!browser) {
  console.error('未找到本机 Microsoft Edge 或 Google Chrome，请先安装其中之一。');
  process.exit(1);
}

const logger = {
  info: (m) => console.log(m),
  ok: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m)
};

(async () => {
  // 同一 profile 只能被一个浏览器实例持有：先释放旧窗口，再新建窗口
  await closeProfileBrowsers(cfg.paths.profileDir, { logger, force: true });

  const args = [
    `--user-data-dir=${cfg.paths.profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-default-browser-check',
    '--no-first-run',
    '--start-maximized',
    'https://ditu.amap.com/',
    cfg.rules.dianping.entryUrl
  ];

  const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  console.log(`已新建浏览器窗口（普通模式，无自动化标记）：${browser.name}`);
  console.log(`  可执行文件: ${browser.exe}`);
  console.log(`  profile: ${cfg.paths.profileDir}`);
  console.log(`  调试端口: ${port}`);
  console.log('请在窗口内登录高德地图与大众点评；登录完成后即可运行：');
  console.log('  npm run collect -- --limit 5 --categories KTV,TQG');
  console.log('  npm run web      （打开网页控制台，在页面上输入数量后点击“开始采集”）');
})().catch((e) => {
  console.error(`启动失败：${e.message}`);
  process.exit(1);
});
