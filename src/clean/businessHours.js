'use strict';
/**
 * 营业时间解析与“结束营业时间晚于 23:00”判定。
 * 支持写法：11:00-24:00 / 12:00-次日05:00 / 10:00-01:00 / 24小时营业 / 全天营业 /
 *          10:00-14:00 17:00-22:00 / 周一至周日 10:00-22:00 / 11:00 开始营业（大众点评）
 */

const CLOSED_PATTERNS = ['已关闭', '已停业', '商家停业', '暂停营业', '歇业', '已歇业', '倒闭', '关门', '停业', '已搬迁', '即将开业', '暂未开业', '未开业', '筹备中'];
const OPEN_PATTERNS = ['营业中', '正在营业'];
const REST_PATTERNS = ['休息中', '休息', '已打烊', '打烊'];

/** "23:00" -> 1380 */
function timeToMinutes(token) {
  if (!token) return null;
  const m = String(token).match(/(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

function minutesToText(min) {
  if (min === null || min === undefined) return '';
  const total = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const TIME_RE = /(\d{1,2}\s*[:：]\s*\d{1,2}(?:\s*[:：]\s*\d{1,2})?)/g;

/**
 * 解析营业时间文本。
 * @returns {{
 *   raw: string, is24h: boolean, ranges: Array<{start:number,end:number,crossDay:boolean}>,
 *   firstStart: number|null, lastEnd: number|null, normalized: string, ok: boolean
 * }}
 */
function parseBusinessHours(text) {
  const raw = String(text || '').trim();
  const result = { raw, is24h: false, ranges: [], firstStart: null, lastEnd: null, normalized: '', ok: false };
  if (!raw) return result;

  if (/24\s*小时|全天营业|全天|24h|24H/.test(raw)) {
    result.is24h = true;
    result.firstStart = 0;
    result.lastEnd = 1440;
    result.ranges = [{ start: 0, end: 1440, crossDay: false }];
    result.normalized = '24:00';
    result.ok = true;
    return result;
  }

  const tokens = raw.match(TIME_RE) || [];
  const mins = tokens.map(timeToMinutes).filter((v) => v !== null);
  if (mins.length < 2) {
    if (mins.length === 1) {
      result.firstStart = mins[0];
      result.lastEnd = null;
      result.normalized = minutesToText(mins[0]);
    }
    return result;
  }

  for (let i = 0; i + 1 < mins.length; i += 2) {
    const start = mins[i];
    let end = mins[i + 1];
    let crossDay = false;
    if (end === 0 && start > 0) {
      // 24:00 常被写成 00:00
      end = 1440;
    } else if (end < start) {
      end += 1440;
      crossDay = true;
    } else if (end === start) {
      end = start + 1440;
      crossDay = true;
    }
    result.ranges.push({ start, end, crossDay });
  }
  if (!result.ranges.length) return result;

  result.firstStart = Math.min(...result.ranges.map((r) => r.start));
  result.lastEnd = Math.max(...result.ranges.map((r) => r.end));
  result.normalized = result.ranges
    .map((r) => `${minutesToText(r.start)}-${r.crossDay ? '次日' : ''}${minutesToText(r.end)}`)
    .join(',');
  result.ok = true;
  return result;
}

/** 结束营业时间是否晚于阈值（默认 23:00 / 1380 分钟） */
function closesAfter(text, threshold = '23:00') {
  const parsed = parseBusinessHours(text);
  if (parsed.is24h) return true;
  const limit = timeToMinutes(threshold);
  if (!parsed.ok || parsed.lastEnd === null) return false;
  return parsed.lastEnd > limit;
}

/** 营业状态判定：closed | resting | open | unknown */
function detectOpenState(text) {
  const s = String(text || '');
  if (!s) return 'unknown';
  if (CLOSED_PATTERNS.some((p) => s.includes(p))) return 'closed';
  if (OPEN_PATTERNS.some((p) => s.includes(p))) return 'open';
  if (REST_PATTERNS.some((p) => s.includes(p))) return 'resting';
  return 'unknown';
}

/** 是否可视为“正常营业”（休息中也算，用户明确要求） */
function isOperatingNormally(text) {
  const state = detectOpenState(text);
  return state !== 'closed';
}

/** 从一段包含营业时间的文本里抽出时间片段：“休息中 11:00-24:00” -> “11:00-24:00” */
function extractHoursText(text) {
  const s = String(text || '').trim();
  if (/24\s*小时|全天营业/.test(s)) return '24小时营业';
  const m = s.match(/\d{1,2}\s*[:：]\s*\d{1,2}[^]{0,20}(?:\d{1,2}\s*[:：]\s*\d{1,2})?/);
  return m ? m[0].trim() : '';
}

module.exports = {
  CLOSED_PATTERNS,
  timeToMinutes,
  minutesToText,
  parseBusinessHours,
  closesAfter,
  detectOpenState,
  isOperatingNormally,
  extractHoursText
};
