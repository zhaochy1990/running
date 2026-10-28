// 展示格式化工具 —— 配速 / 时间 / 距离 / 负荷。

import { epochToShanghaiYmd } from './date';

/** 米 → 公里字符串（保留 2 位小数）。null/非法 → '—'。 */
export function fmtKm(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters) || meters <= 0) return '—';
  return (meters / 1000).toFixed(2);
}

/** 秒 → `H:MM:SS`（小时不足两位补零，如 00:51:21）。null/非法 → '—'。 */
export function fmtHms(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 99) return `${h}:${mm}:${ss}`;
  const hh = String(h).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 负荷值字符串（保留 1 位小数）。null/非法 → '—'。 */
export function fmtDose(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(1);
}

/** 配速 `M:SS/km`。null/非法 → '—'。 */
export function fmtPace(secondsPerKm: number | null | undefined): string {
  if (secondsPerKm == null || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '—';
  const s = Math.round(secondsPerKm);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}/km`;
}

/** 配速拆成对齐用的两段（按 `'` 对齐）：分钟 + `'SS"`。null/非法 → ['—', '']。 */
export function fmtPaceQuoteParts(secondsPerKm: number | null | undefined): [string, string] {
  if (secondsPerKm == null || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return ['—', ''];
  const s = Math.round(secondsPerKm);
  return [`${Math.floor(s / 60)}`, `'${String(s % 60).padStart(2, '0')}"`];
}

/** 配速 `M'SS"`（如 4'30"）。null/非法 → '—'。 */
export function fmtPaceQuote(secondsPerKm: number | null | undefined): string {
  return fmtPaceQuoteParts(secondsPerKm).join('');
}

/** 自然时长：1 小时内 `M:SS`，超过则 `H:MM:SS`。null/非法 → '—'。 */
export function fmtDurationShort(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

// 上海时区偏移（UTC+8，无 DST）：日期部分走 utils/date.ts 的 canonical 转换，
// 时刻部分用同一偏移 + getUTC* 取墙钟（禁止本地时区 getHours 等假设）。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** ISO 时间串（如 `2026-10-27T20:36:25Z`）→ 上海墙钟 `MM-DD HH:mm`（如 `10-28 04:36`）。null/非法 → '—'。 */
export function fmtShanghaiMdHm(iso: string | null | undefined): string {
  if (!iso) return '—';
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) return '—';
  const md = epochToShanghaiYmd(epoch).slice(5);
  const d = new Date(epoch + SHANGHAI_OFFSET_MS);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${md} ${hm}`;
}
