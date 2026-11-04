/**
 * checkinCalendar 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/checkinCalendar.check.mts`。
 *
 * 两个重点：
 * 1. **契约**：CYCLE_REWARDS 必须和后端 Go `storage.cycleRewards` 逐字一致，
 *    改错一个数成就卡/规则脚注就和实际到账分对不上 —— 这里把字面量钉死。
 * 2. **月历布局**（#851 原型变体 A）：周日起始、前后月补位、已签/今天/未来/错过
 *    四态、今天所在周行号、「本月已签 N 天」客户端计数。
 */
import { CYCLE_CUMULATIVE, CYCLE_REWARDS, buildMonthBoard, cycleEarnedPoints } from './checkinCalendar.ts';
import { shanghaiShiftDays } from './date.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// —— 奖励表契约：与 Go cycleRewards / 累计里程碑逐字对齐 ——
eq([...CYCLE_REWARDS], [1, 1, 1, 1, 2, 2, 3], 'cycle rewards must match Go cycleRewards');
eq([...CYCLE_CUMULATIVE], [1, 2, 3, 4, 6, 8, 11], 'cumulative milestone scores');

// —— 本轮已得：只累计已签格快照 ——
eq(
  cycleEarnedPoints([
    { points: 1, status: 'checked' },
    { points: 1, status: 'checked' },
    { points: 1, status: 'today' },
    { points: 2, status: 'upcoming' },
  ]),
  2,
  'cycle earned sums checked cells only',
);
eq(cycleEarnedPoints([]), 0, 'empty cycle earns 0');

// —— 2026-11：1 号恰是周日（lead=0）、30 天 → 末尾补 5 格 12.01-12.05 ——
{
  const board = buildMonthBoard('2026-11-04', {});
  eq(board.rows.length, 5, '2026-11 has 35 cells = 5 rows');
  eq(board.weekIndex, 0, '2026-11-04 sits in week row 0');
  eq(board.checkedCount, 0, 'no checked days');
  eq(board.rows[0][3].label, '11.04', 'today label MM.DD');
  eq(board.rows[0][3].state, 'today', 'today state');
  eq(board.rows[4][6].label, '12.05', 'trailing next-month filler 12.05');
  eq(board.rows[4][6].state, 'other', 'filler state');
  eq(board.rows[0][0].date, '2026-11-01', 'no leading filler when the 1st is Sunday');
}

// —— 2026-10：1 号周四（lead=4）→ 前月补 09.27-09.30；31+4=35 无尾补 ——
{
  const board = buildMonthBoard('2026-10-15', {});
  eq(board.rows.length, 5, '2026-10 has 35 cells = 5 rows');
  eq(board.rows[0][0].label, '09.27', 'leading filler starts 09.27');
  eq(board.rows[0][3].label, '09.30', 'leading filler ends 09.30');
  eq(board.rows[0][4].label, '10.01', 'month starts at Sunday column');
  eq(board.weekIndex, 2, '2026-10-15 sits in week row 2');
  eq(board.rows[2][4].state, 'today', 'today lands on its row');
  eq(board.rows[4][6].label, '10.31', 'month ends Saturday, no trailing filler');
}

// —— 已签快照：checked 态 + pts、跨年补位 12 月→1 月 ——
{
  const board = buildMonthBoard('2026-11-04', { '2026-11-02': 1, '2026-11-03': 2 });
  eq(board.checkedCount, 2, '本月已签 2 天（客户端计数）');
  eq(board.rows[0][1], { date: '2026-11-02', label: '11.02', state: 'checked', pts: 1 }, 'checked cell keeps snapshot');
  eq(board.rows[0][0].state, 'missed', 'past unchecked = missed');
  eq(board.rows[0][4].state, 'future', 'tomorrow = future');

  const dec = buildMonthBoard('2026-12-01', { '2026-12-01': 3 });
  eq(dec.rows[0][0].label, '11.29', 'December leads with 11.29');
  eq(dec.rows[0][0].state, 'other', 'leading filler state');
  eq(dec.rows[0][2].state, 'checked', 'today checked on Dec 1');
  eq(dec.weekIndex, 0, 'Dec 1 sits in row 0');

  const jan = buildMonthBoard('2027-01-01', {});
  eq(jan.rows[0][0].label, '12.27', 'January leads with 12.27 of prev year');
}

// —— 收起态默认行：今天那行正是周历默认展示的 7 格 ——
{
  const board = buildMonthBoard('2026-11-04', { '2026-11-02': 1 });
  const week = board.rows[board.weekIndex];
  eq(week.map((c) => c.label), ['11.01', '11.02', '11.03', '11.04', '11.05', '11.06', '11.07'], 'collapsed week row labels');
  eq(week[3].state, 'today', 'collapsed row centers today');
}

// —— 与 utils/date 的往返一致性（防手滑换算） ——
eq(shanghaiShiftDays('2026-11-04', -1), '2026-11-03', 'shift back one day');
eq(shanghaiShiftDays('2026-12-01', -1), '2026-11-30', 'shift across month boundary');

console.log('checkinCalendar.check: OK');
