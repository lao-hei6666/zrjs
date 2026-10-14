'use strict';
/**
 * 浏览器探测：给出「可执行文件 / Playwright channel / 进程名」三件套。
 *
 * 背景：本机没有安装 Google Chrome，实际可用的是 Microsoft Edge（同为 Chromium 内核）。
 * 因此探测顺序为 Edge 优先、Chrome 兜底；所有需要浏览器路径或进程名的地方
 * （采集主流程、tools/start-browser.js、tools/close-browser.js）都从这里取，
 * 避免像以前那样在各处硬编码 Chrome 路径。
 */
const fs = require('fs');
const path = require('path');

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

/** 数组顺序即优先级：本机只有 Edge，所以 Edge 放在最前 */
const BROWSERS = [
  {
    name: 'Edge',
    channel: 'msedge',
    processName: 'msedge.exe',
    candidates: [
      path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ]
  },
  {
    name: 'Chrome',
    channel: 'chrome',
    processName: 'chrome.exe',
    candidates: [
      path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]
  }
];

function findExecutable(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) { /* ignore */ }
  }
  return '';
}

/**
 * 找到本机第一个可用的 Chromium 系浏览器。
 * @returns {{name:string, channel:string, processName:string, exe:string}|null}
 */
function findBrowser() {
  for (const b of BROWSERS) {
    const exe = findExecutable(b.candidates);
    if (exe) return { name: b.name, channel: b.channel, processName: b.processName, exe };
  }
  return null;
}

/** 所有受支持的浏览器进程名（查找「占用 profile 的进程」时需一并扫描） */
function processNames() {
  return BROWSERS.map((b) => b.processName);
}

module.exports = { BROWSERS, findBrowser, findExecutable, processNames };
