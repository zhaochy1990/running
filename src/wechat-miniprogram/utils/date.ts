// 上海时区日期工具 —— 小程序内的 canonical 日期处理（对应主仓库时区纪律）。
//
// 现状：小程序运行环境在较老基础库下不保证 `Intl.DateTimeFormat` 的 `timeZone`
// 选项可用，因此这里用「UTC 时间戳 + 8h 偏移」手动算上海墙钟时间，避免 `new Date()`
// 的方法（getFullYear / getMonth / getDate 等）把 00:00-07:59 上海窗口错分到前一天。
//
// 禁止模式（延续主仓库检查）：
//   new Date().getFullYear() / getMonth() / getDate() 表示「今天」 → 用 shanghaiToday()
//   activity.date.slice(0, 10)                                  → 用 shanghaiDate()

export interface ShanghaiWeekday {
  /** 0=周日 … 6=周六（与 JS Date#getUTCDay 一致） */
  dow: number;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8，无 DST
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** epoch（UTC ms）→ 上海 YYYY-MM-DD */
export function epochToShanghaiYmd(epochMs: number): string {
  const d = new Date(epochMs + SHANGHAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** epoch（UTC ms）→ 上海星期几（0=周日 … 6=周六） */
export function epochToShanghaiDow(epochMs: number): number {
  const d = new Date(epochMs + SHANGHAI_OFFSET_MS);
  return d.getUTCDay();
}

/** 上海 YYYY-MM-DD → epoch（UTC ms）。按上海 00:00 当作当天起点。 */
export function shanghaiYmdToEpoch(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - SHANGHAI_OFFSET_MS;
}

/** 今天（上海）YYYY-MM-DD。禁止用 `new Date().getFullYear()` 之类本地时间假设。 */
export function shanghaiToday(): string {
  return epochToShanghaiYmd(Date.now());
}

function shanghaiDowOfYmd(ymd: string): number {
  return epochToShanghaiDow(shanghaiYmdToEpoch(ymd));
}

/** 给定上海 YYYY-MM-DD，返回该周周一（ISO 周起点）的 YYYY-MM-DD。 */
export function shanghaiWeekStart(ymd: string): string {
  const dow = shanghaiDowOfYmd(ymd); // 0=Sun … 6=Sat
  const daysBack = (dow + 6) % 7; // Mon=0, Tue=1, …, Sun=6
  return epochToShanghaiYmd(shanghaiYmdToEpoch(ymd) - daysBack * DAY_MS);
}

/** 周目录名（后端 weekName 格式）：`YYYY-MM-DD_MM-DD`，起始为周一。 */
export function weekFolderName(weekStartYmd: string): string {
  const endYmd = epochToShanghaiYmd(shanghaiYmdToEpoch(weekStartYmd) + 6 * DAY_MS);
  return `${weekStartYmd}_${endYmd.slice(5)}`;
}

/** 展开以 anchorYmd 所在周为基准的周一到周日 7 天。 */
export function buildWeekDays(anchorYmd: string): Array<{
  date: string;
  label: string;
  dayNumber: number;
  isToday: boolean;
}> {
  const monday = shanghaiWeekStart(anchorYmd);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const base = shanghaiYmdToEpoch(monday);
  const out: Array<{
    date: string;
    label: string;
    dayNumber: number;
    isToday: boolean;
  }> = [];
  for (let i = 0; i < 7; i++) {
    const date = epochToShanghaiYmd(base + i * DAY_MS);
    out.push({
      date,
      label: labels[i],
      dayNumber: Number(date.slice(8)),
      isToday: date === anchorYmd,
    });
  }
  return out;
}

/** 「(2026年7月)」样式的周副标题，基于周一的年月。 */
export function weekSubtitle(weekStartYmd: string): string {
  const year = weekStartYmd.slice(0, 4);
  const month = Number(weekStartYmd.slice(5, 7));
  return `(${year}年${month}月)`;
}
