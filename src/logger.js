'use strict';
/**
 * 分级日志：控制台彩色输出 + 落盘 + 事件广播（供网页 SSE 实时展示）。
 * 级别：INFO / WAIT（等待人工操作，网页高亮） / STAGE（阶段切换） / OK / REJECT（被过滤） / WARN / ERROR / PROGRESS
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { ensureDir } = require('./config');

const COLOR = {
  INFO: '\x1b[90m',
  STAGE: '\x1b[36m',
  OK: '\x1b[32m',
  WAIT: '\x1b[46m\x1b[30m',
  REJECT: '\x1b[33m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  PROGRESS: '\x1b[35m'
};
const RESET = '\x1b[0m';

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class Logger extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(50);
    this.silent = !!options.silent;
    this.linePrefix = options.linePrefix || '';
    this.stats = {
      scanned: 0,
      passed: 0,
      rejected: 0,
      verified: 0,
      duplicates: 0,
      saved: 0,
      stage: 'idle'
    };
    this.logFile = null;
    if (options.logDir) {
      try {
        ensureDir(options.logDir);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        this.logFile = path.join(options.logDir, `collect-${stamp}.log`);
        this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
      } catch (e) {
        this.stream = null;
      }
    }
  }

  _write(level, message, meta) {
    const time = ts();
    const text = `${time} [${level}] ${this.linePrefix}${message}`;
    if (!this.silent) {
      const color = COLOR[level] || '';
      // eslint-disable-next-line no-console
      console.log(`${color}${text}${color ? RESET : ''}${meta ? ' ' + JSON.stringify(meta) : ''}`);
    }
    if (this.stream) this.stream.write(`${new Date().toISOString()} [${level}] ${this.linePrefix}${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`);
    this.emit('log', { time, level, message, meta: meta || null, stats: Object.assign({}, this.stats) });
  }

  info(msg, meta) { this._write('INFO', msg, meta); }
  stage(msg, meta) { this.stats.stage = msg; this._write('STAGE', msg, meta); }
  ok(msg, meta) { this._write('OK', msg, meta); }
  wait(msg, meta) { this._write('WAIT', msg, meta); }
  reject(msg, meta) { this.stats.rejected += 1; this._write('REJECT', msg, meta); }
  warn(msg, meta) { this._write('WARN', msg, meta); }
  error(msg, meta) { this._write('ERROR', msg, meta); }

  progress(patch = {}) {
    Object.assign(this.stats, patch);
    this._write('PROGRESS', `已扫描 ${this.stats.scanned} / 已通过 ${this.stats.passed} / 已过滤 ${this.stats.rejected} / 已核验 ${this.stats.verified}`, null);
  }

  setPrefix(prefix) { this.linePrefix = prefix ? `[${prefix}] ` : ''; }

  close() {
    if (!this.stream) return Promise.resolve();
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

module.exports = { Logger };
