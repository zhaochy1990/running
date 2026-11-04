// 签到月历布局 + 本轮奖励常量（纯函数，node 直接跑 checkinCalendar.check.mts）。
//
// 布局规则 = devops#851 resolution 原型变体 A：周日起始、前后月补位灰格、
// 已签格带 +N 快照；「本月已签 N 天」与周历布局都在客户端算（#885，
// 数据源 GET .../status 的 month.checked 由后端保证只含当前自然月）。
// 日期一律上海 YYYY-MM-DD 字符串运算（时区纪律 HARD，复用 utils/date）。

import { pad2, shanghaiDowOfYmd, shanghaiYmdToEpoch } from './date';

/** 一轮 7 天的奖励表 —— 与 Go storage.cycleRewards 逐字对齐（devops#847）。 */
export const CYCLE_REWARDS = [1, 1, 1, 1, 2, 2, 3] as const;

/** 里程碑圆内累计分值 1/2/3/4/6/8/11（签到成就卡）。 */
export const CYCLE_CUMULATIVE = [1, 2, 3, 4, 6, 8, 11] as const;

export type MonthCellState = 'checked' | 'today' | 'future' | 'missed' | 'other';

export interface MonthCell {
  /** 当月日为 YYYY-MM-DD；前后月补位为 ''。 */
  date: string;
  /** 展示标签 MM.DD。 */
  label: string;
  state: MonthCellState;
  /** 已签格的得分快照（+N），其余 0。 */
  pts: number;
}

export interface MonthBoard {
  /** 整月周历按 7 列切行（含前后月补位）。 */
  rows: MonthCell[][];
  /** 今天所在行行号（收起态默认显示这一行）。 */
  weekIndex: number;
  /** 本月已签天数（客户端计数）。 */
  checkedCount: number;
}

/** 上海 YYYY-MM 所在月的最后一天（1-31）。 */
function daysInMonth(year: number, month1based: number): number {
  return new Date(Date.UTC(year, month1based, 0)).getUTCDate();
}

/**
 * 由「今天」+ 当月已签映射生成整月周历。
 * @param todayYmd 服务器上海日历日（status.today.date）
 * @param checkedPoints YYYY-MM-DD → 当日得分快照（status.month.checked 展开）
 */
export function buildMonthBoard(todayYmd: string, checkedPoints: Record<string, number>): MonthBoard {
  const year = Number(todayYmd.slice(0, 4));
  const month = Number(todayYmd.slice(5, 7));
  const todayDay = Number(todayYmd.slice(8, 10));

  const cells: MonthCell[] = [];

  // 前月补位：本月 1 号是周几就补前月最后几天（周日起始）。
  const lead = shanghaiDowOfYmd(`${todayYmd.slice(0, 7)}-01`);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevLast = daysInMonth(month === 1 ? year - 1 : year, prevMonth);
  for (let i = lead - 1; i >= 0; i--) {
    cells.push({ date: '', label: `${pad2(prevMonth)}.${pad2(prevLast - i)}`, state: 'other', pts: 0 });
  }

  const monthPrefix = todayYmd.slice(0, 8); // YYYY-MM-
  const last = daysInMonth(year, month);
  for (let d = 1; d <= last; d++) {
    const ymd = `${monthPrefix}${pad2(d)}`;
    const pts = checkedPoints[ymd] || 0;
    let state: MonthCellState;
    if (pts > 0) {
      state = 'checked';
    } else if (d === todayDay) {
      state = 'today';
    } else if (d > todayDay) {
      state = 'future';
    } else {
      state = 'missed';
    }
    cells.push({ date: ymd, label: `${pad2(month)}.${pad2(d)}`, state, pts });
  }

  // 后月补位到整行。
  const nextMonth = month === 12 ? 1 : month + 1;
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ date: '', label: `${pad2(nextMonth)}.${pad2(nextDay)}`, state: 'other', pts: 0 });
    nextDay++;
  }

  const rows: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7));
  }

  return {
    rows,
    weekIndex: Math.floor((lead + todayDay - 1) / 7),
    checkedCount: cells.filter((c) => c.pts > 0).length,
  };
}

/** 本轮已得积分（status.cycle 里已签格快照求和，客户端算）。 */
export function cycleEarnedPoints(
  cycle: Array<{ points: number; status: 'checked' | 'today' | 'upcoming' }>,
): number {
  return cycle.reduce((sum, cell) => (cell.status === 'checked' ? sum + cell.points : sum), 0);
}
