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

// 按 dow（0=周日 … 6=周六）索引的中文星期标签。
const CN_WEEKDAYS_BY_DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 上海 YYYY-MM-DD → 中文星期（'周日' … '周六'）；非法输入返回 ''。 */
export function shanghaiWeekdayLabel(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  return CN_WEEKDAYS_BY_DOW[shanghaiDowOfYmd(ymd)];
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

/**
 * 后端返回的活动 `date` 是上海 ISO 时间串（如 `2026-08-28T08:30:00+08:00`），
 * 也兼容 `YYYY-MM-DD`。取其上海日期部分 `YYYY-MM-DD`，非法则返回空串。
 */
export function shanghaiDateFromIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const datePart = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : '';
}

/** 取上海 ISO 时间串的时刻部分 `HH:MM`（如 `08:30`），非法/缺失则返回空串。 */
export function shanghaiTimeFromIso(iso: string | null | undefined): string {
  if (!iso || iso.length < 16) return '';
  const time = iso.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(time) ? time : '';
}

/**
 * 生成推送日期选项 —— 从今天起往后（不再出现今天以前的日期）。
 * 今天/明天/后天用中文标签，其他显示「周X MM/DD」。
 * 默认选中（selected）训练对应的计划日；计划日早于今天（任务已过期）时退回今天。
 */
export interface PushDateOption {
  label: string;
  value: string; // YYYY-MM-DD
  /** 是否为默认选中项（计划日；过期时回退到今天） */
  selected?: boolean;
}

const PUSH_DATE_FORWARD_DAYS = 7; // 今天起共 8 个可选日（含今天）

export function buildPushDateOptions(plannedDate: string): PushDateOption[] {
  const today = shanghaiToday();
  const todayEpoch = shanghaiYmdToEpoch(today);
  const plannedEpoch = shanghaiYmdToEpoch(plannedDate);
  const out: PushDateOption[] = [];

  // 计划日落在今天（含）之后的可见范围内才提升为默认；否则回退今天。
  const plannedVisible =
    !Number.isNaN(plannedEpoch) && plannedEpoch >= todayEpoch;
  const defaultEpoch = plannedVisible && plannedEpoch <= todayEpoch + PUSH_DATE_FORWARD_DAYS * DAY_MS
    ? plannedEpoch
    : todayEpoch;

  for (let i = 0; i <= PUSH_DATE_FORWARD_DAYS; i++) {
    const date = epochToShanghaiYmd(todayEpoch + i * DAY_MS);

    let label: string;
    if (i === 0) {
      label = '今天';
    } else if (i === 1) {
      label = '明天';
    } else if (i === 2) {
      label = '后天';
    } else {
      const wd = shanghaiWeekdayLabel(date);
      const md = date.slice(5);
      label = `${wd} ${md}`;
    }

    if (date === plannedDate) {
      label = `${label}（计划日）`;
    }

    out.push({ label, value: date, selected: date === epochToShanghaiYmd(defaultEpoch) });
  }
  return out;
}
