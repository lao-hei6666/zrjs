'use strict';
/**
 * 全局操作节流：**每一个浏览器操作之前固定等待 delayMs（默认 2000ms）**。
 *
 * 对应需求：“在高德地图操作的每一个步骤需要间隔 2 秒，也就是每一个操作间隔 2 秒，
 * 比如刚进入页面，等 2 秒后输入完输入框，等 2 秒后点击搜索，等 2 秒后点击什么地方”。
 *
 * 约定：所有会“产生交互或发出请求”的操作（导航 goto / reload、点击 click、输入 type/fill、
 * 按键 press、页面内 fetch、翻页请求）都必须先调用 pace.pace('动作描述')；
 * 纯读取（innerText / querySelector / evaluate 取值）属于上一个操作的收尾，不额外等待。
 *
 * mode:
 *   strict（默认）—— 每个操作前固定 sleep(delayMs)，最保守，反爬最安全；
 *   gap          —— 只保证相邻两次操作开始时间间隔 >= delayMs（操作本身很慢时不再补等待）。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createPacer(delayMs = 2000, logger = null, mode = 'strict') {
  let lastAt = 0;
  let count = 0;

  return {
    async pace(label) {
      count += 1;
      if (mode === 'strict') {
        await sleep(delayMs);
      } else {
        const wait = Math.max(0, delayMs - (Date.now() - lastAt));
        if (wait > 0) await sleep(wait);
      }
      lastAt = Date.now();
      if (logger && label) {
        logger.info(`操作 #${count}（${mode === 'strict' ? '操作前等待' : '间隔'} ${delayMs}ms）：${label}`);
      }
      return { index: count };
    },
    get count() { return count; },
    delayMs,
    mode
  };
}

module.exports = { createPacer, sleep };
