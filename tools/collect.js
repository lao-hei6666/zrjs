#!/usr/bin/env node
'use strict';
/**
 * 命令行入口：
 *   node tools/collect.js [选项]
 *
 * 选项：
 *   --limit N                采集数量上限（通过全部规则的场所数量），默认不限制
 *   --categories KTV,TQG     只采集指定分类（可填 code 或中文名，逗号分隔），默认全部 12 个分类
 *   --delay 2000             每个浏览器操作的间隔毫秒数，默认 2000
 *   --min-photos 5           高德封面照片数下限（需大于该值），默认 5
 *   --closing-after 23:00    结束营业时间必须晚于该时间，默认 23:00
 *   --max-pages 10           每个关键词最多翻页数，默认 10
 *   --out D:/Code/csjb       结果目录
 *   --skip-verify            跳过大众点评核验（提速，但不再校验点评是否存在）
 *   --resume                 复用本地缓存（断点续采：已采集过的详情/核验直接读缓存）
 *   --headless               无头模式（无法人工登录，仅调试用）
 *   --json                   以 JSON 输出最终结果摘要（供网页端调用）
 */
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/logger');
const { runPipeline } = require('../src/pipeline');

function parseArgs(argv) {
  const out = { categories: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    switch (a) {
      case '--limit': out.limit = Number(next()); i += 1; break;
      case '--categories': out.categories = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean); i += 1; break;
      case '--delay': out.delayMs = Number(next()); i += 1; break;
      case '--min-photos': out.minPhotoCount = Number(next()); i += 1; break;
      case '--closing-after': out.closingTimeAfter = next(); i += 1; break;
      case '--max-pages': out.maxPagesPerKeyword = Number(next()); i += 1; break;
      case '--out': out.outputDir = next(); i += 1; break;
      case '--skip-verify': out.skipVerify = true; break;
      case '--resume': out.resume = true; break;
      case '--headless': out.headless = true; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (a && a.startsWith('--')) console.warn(`未知参数：${a}`);
    }
  }
  return out;
}

function help() {
  console.log(`高德地图北京休闲娱乐场所批量采集工具

用法：
  node tools/collect.js --limit 20 [--categories KTV,TQG] [--resume]

说明：
  * 需要人工登录：脚本会打开可见浏览器，等待你登录高德地图与大众点评后自动继续；
  * 每个浏览器操作间隔默认 2 秒（--delay 可调）；
  * 照片数量取高德详情页封面右下角“照片N”（未登录时相册只显示 3 张，不作为依据）；
  * 结果输出到 D:/Code/csjb 下的 场所采集_时间戳.xlsx（21 列，最后一列为照片数量）。

选项：
  --limit N              采集数量上限
  --categories A,B       只采集指定分类（code 或中文名）
  --delay 2000           操作间隔毫秒
  --min-photos 5         照片数下限（大于该值）
  --closing-after 23:00  结束营业时间下限
  --max-pages 10         每个关键词最多翻页数
  --out DIR              结果目录，默认 D:/Code/csjb
  --skip-verify          跳过大众点评核验
  --resume               复用本地缓存（断点续采）
  --headless             无头模式（调试用）
  --json                 输出 JSON 摘要
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }

  const cfg = loadConfig(args);
  const logger = new Logger({ logDir: cfg.paths.logDir, silent: !!args.json });

  if (!Number.isFinite(cfg.limit) && args.categories.length === 0) {
    logger.warn('未指定 --limit，将按全部分类持续采集（可随时 Ctrl+C 中断）；建议先用小数量试跑');
  }

  try {
    const result = await runPipeline(cfg, logger);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        file: result.file,
        scanned: result.scanned,
        passed: result.records.length,
        rejected: result.rejects.length,
        seconds: result.seconds,
        report: result.report
      })}\n`);
    }
  } catch (e) {
    logger.error(`采集失败：${e.message}`);
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    process.exitCode = 1;
  } finally {
    await logger.close();
  }
  // 接管「普通模式」窗口时，Playwright 的 CDP 连接会让事件循环一直保持活跃，
  // CLI 必须显式退出，否则采集跑完后进程不会返回终端。
  // （Edge 窗口是独立启动的进程，不会因此被关闭，仍然保持打开。）
  process.exit(process.exitCode || 0);
}

main();
