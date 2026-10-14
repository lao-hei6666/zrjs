#!/usr/bin/env node
'use strict';
/**
 * 演示网页服务：
 *   GET  /                  控制台页面（数字输入框 + 开始采集按钮 + 实时日志）
 *   POST /api/start {limit} 按输入的数字作为采集数量上限启动采集
 *   POST /api/stop          请求停止当前采集
 *   GET  /api/status        当前状态与统计
 *   GET  /api/stream        SSE 实时日志与进度
 *   POST /api/open-folder   在资源管理器中打开结果目录
 *
 * 启动：npm run web   （默认 http://127.0.0.1:5178）
 */
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');

const { loadConfig } = require('../src/config');
const { Logger } = require('../src/logger');
const { runPipeline } = require('../src/pipeline');
const { hasCaptcha } = require('../src/amap/browser');

const PORT = Number(process.env.CSJB_PORT || 5178);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  running: false,
  stopRequested: false,
  startedAt: null,
  finishedAt: null,
  limit: null,
  stats: { scanned: 0, passed: 0, rejected: 0, verified: 0, saved: 0, stage: 'idle' },
  result: null,
  error: null,
  logCount: 0,
  progress: 0
};
const logs = [];
const clients = new Set();

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch (e) { /* ignore */ }
  }
}

function publicState() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    limit: state.limit,
    stats: state.stats,
    result: state.result,
    error: state.error,
    progress: state.progress,
    logCount: state.logCount
  };
}

app.get('/api/status', (req, res) => res.json(publicState()));

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  for (const ev of logs.slice(-300)) res.write(`event: log\ndata: ${JSON.stringify(ev)}\n\n`);
  clients.add(res);
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/api/start', async (req, res) => {
  if (state.running) return res.status(409).json({ ok: false, error: '已有采集任务在运行，请先等待或停止' });
  const limit = Number(req.body && req.body.limit);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
    return res.status(400).json({ ok: false, error: '请输入一个正整数作为采集数量上限' });
  }

  const cfg = loadConfig({
    limit,
    delayMs: req.body.delayMs ? Number(req.body.delayMs) : undefined,
    skipVerify: !!req.body.skipVerify,
    resume: !!req.body.resume,
    categories: Array.isArray(req.body.categories) ? req.body.categories : undefined
  });
  const logger = new Logger({ logDir: cfg.paths.logDir, silent: true });

  state.running = true;
  state.stopRequested = false;
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.limit = limit;
  state.result = null;
  state.error = null;
  state.progress = 0;
  state.stats = { scanned: 0, passed: 0, rejected: 0, verified: 0, saved: 0, stage: '准备中' };
  logs.length = 0;

  logger.on('log', (ev) => {
    logs.push(ev);
    if (logs.length > 2000) logs.shift();
    state.logCount = logs.length;
    state.stats = ev.stats ? { ...ev.stats } : state.stats;
    if (Number.isFinite(state.limit) && state.limit > 0) {
      state.progress = Math.min(100, Math.round((state.stats.passed / state.limit) * 100));
    }
    broadcast('log', ev);
  });

  broadcast('state', publicState());
  res.json({ ok: true, limit, message: `开始采集，数量上限 ${limit}` });

  runPipeline(cfg, logger, { shouldStop: () => state.stopRequested })
    .then((r) => {
      state.result = {
        file: r.file,
        passed: r.records.length,
        scanned: r.scanned,
        rejected: r.rejects.length,
        seconds: r.seconds,
        report: r.report
      };
    })
    .catch((e) => { state.error = String(e.message || e); })
    .finally(() => {
      state.running = false;
      state.finishedAt = Date.now();
      state.progress = state.result ? 100 : state.progress;
      broadcast('done', Object.assign(publicState(), {}));
      logger.close();
    });
});

app.post('/api/stop', (req, res) => {
  if (!state.running) return res.json({ ok: false, error: '当前没有运行中的任务' });
  state.stopRequested = true;
  broadcast('log', {
    time: new Date().toTimeString().slice(0, 8),
    level: 'WARN',
    message: '已请求停止，将在当前条目结束后收尾导出…',
    meta: null,
    stats: state.stats
  });
  res.json({ ok: true });
});

app.post('/api/open-folder', (req, res) => {
  const dir = loadConfig().rules.output.dir;
  execFile('explorer.exe', [dir.replace(/\//g, '\\')], () => {});
  res.json({ ok: true, dir });
});

app.get('/api/version', async (req, res) => {
  res.json({ ok: true });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`采集控制台已启动：http://127.0.0.1:${PORT}`);
  console.log('点击页面上的“开始采集”即会打开浏览器窗口（需要人工登录高德/大众点评）。');
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
