import type { Segment } from '../types/activity';

/** 单圈配速标记：与上一圈的走向 + 全场最快 / 最慢高亮（恢复圈两者都没有）。 */
export interface LapPaceMark {
  /** '' = 无走向（首圈 / 本圈或上一圈没有配速 / 配速持平） */
  trend: '' | 'up' | 'down';
  /** 心率走向（与上一「有圈号」圈比较）：'' = 无 / 持平，'up' = 心率升高，'down' = 心率降低 */
  hrTrend: '' | 'up' | 'down';
  /** 恢复圈（组间停顿）：不计圈号、不比箭头、不参与最快 / 最慢 */
  rest: boolean;
  /** 整行样式 class */
  rowClass: '' | 'lap-row--fastest' | 'lap-row--slowest' | 'lap-row--rest';
  /** 圈数徽标 class */
  tagClass: '' | 'lap-row__tag--fastest';
  /** 圈数徽标文字 */
  tag: '' | '最快' | '最慢';
}

/** 有配速的圈少于这个数就不标最快 / 最慢。 */
const MIN_RANKABLE_LAPS = 3;

/** 后端 SegmentName 给停顿圈起的名字（exercise_type 4/3 → 恢复 / 休息） */
const REST_SEG_NAMES = ['恢复', '休息'];

/** COROS 原始圈类型：3 = 恢复圈（一部分圈 exercise_type 为 0，seg_name 会回落成「训练」） */
const REST_MODE = 3;

/**
 * 计算圈速表每圈的配速箭头与最快 / 最慢高亮。
 *
 * - 恢复圈（seg_name 恢复 / 休息，或原始 mode 3）不计圈号、不比箭头、不参与最快 / 最慢。
 * - 箭头：本圈配速 vs 上一「有圈号」圈的配速（跨过中间的恢复圈）。
 * - 最快 / 最慢：所有有配速的普通圈一起排（含 400m 慢跑圈、收尾残圈），按配速
 *   s/km 比，不按 duration_s —— 距离不同的圈比时间会得出反的结论。
 */
export function lapPaceMarks(laps: Segment[]): LapPaceMark[] {
  const rest = laps.map((lap) => REST_SEG_NAMES.includes(lap.seg_name) || lap.mode === REST_MODE);

  const active = laps.map((_, i) => (rest[i] ? -1 : i)).filter((i) => i >= 0);
  const paced = active.filter((i) => laps[i].avg_pace != null);

  let fast = -1;
  let slow = -1;
  if (paced.length >= MIN_RANKABLE_LAPS) {
    for (const i of paced) {
      if (fast < 0 || (laps[i].avg_pace as number) < (laps[fast].avg_pace as number)) fast = i;
      if (slow < 0 || (laps[i].avg_pace as number) > (laps[slow].avg_pace as number)) slow = i;
    }
    // 全部同配速时不分高下
    if (laps[fast].avg_pace === laps[slow].avg_pace) fast = slow = -1;
  }

  // 心率趋势沿用同一套「上一有圈号圈」规则（跨过恢复圈），方向 = 数据方向：升高 up / 降低 down。
  const dir = (cur: number | null | undefined, prev: number | null | undefined): '' | 'up' | 'down' =>
    cur == null || prev == null || cur === prev ? '' : cur > prev ? 'up' : 'down';

  let prevActive = -1;
  return laps.map((lap, i): LapPaceMark => {
    if (rest[i]) {
      return { trend: '', hrTrend: '', rest: true, rowClass: 'lap-row--rest', tagClass: '', tag: '' };
    }
    const cur = lap.avg_pace;
    const prev = prevActive >= 0 ? laps[prevActive].avg_pace : null;
    const prevHr = prevActive >= 0 ? laps[prevActive].avg_hr : null;
    prevActive = i;
    const trend = cur == null || prev == null || cur === prev ? '' : cur < prev ? 'up' : 'down';
    return {
      trend,
      hrTrend: dir(lap.avg_hr, prevHr),
      rest: false,
      rowClass: i === fast ? 'lap-row--fastest' : i === slow ? 'lap-row--slowest' : '',
      tagClass: i === fast ? 'lap-row__tag--fastest' : '',
      tag: i === fast ? '最快' : i === slow ? '最慢' : '',
    };
  });
}
