// 展示格式化工具 —— 配速 / 时间 / 距离 / 负荷。

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
