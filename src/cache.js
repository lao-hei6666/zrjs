'use strict';
/**
 * 本地缓存（断点续采）：搜索结果 / 高德详情 / 大众点评核验结果落盘，
 * 避免重复请求触发反爬，也让中断后的再次运行可以续采。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir } = require('./config');

function safeFile(key) {
  const hash = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 10);
  const readable = String(key).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40);
  return `${readable}_${hash}`;
}

function createCache(cfg) {
  const dirOf = (kind) => path.join(cfg.paths.cacheDir, kind);

  return {
    read(kind, key, enabled) {
      if (!enabled) return null;
      try {
        const file = path.join(dirOf(kind), `${safeFile(key)}.json`);
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        return null;
      }
    },
    write(kind, key, data) {
      try {
        ensureDir(dirOf(kind));
        fs.writeFileSync(path.join(dirOf(kind), `${safeFile(key)}.json`), JSON.stringify(data, null, 1), 'utf8');
      } catch (e) { /* ignore */ }
    },
    clear(kind) {
      try {
        fs.rmSync(dirOf(kind), { recursive: true, force: true });
      } catch (e) { /* ignore */ }
    },
    safeFile
  };
}

module.exports = { createCache, safeFile };
