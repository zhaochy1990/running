import type { Lap } from '../types/activity';

/** 单圈配速标记：与上一同类圈的走向 + 全场最快 / 最慢高亮。 */
export interface LapPaceMark {
  /** '' = 无走向（首圈 / 本类圈只有这一圈 / 配速缺失 / 配速持平） */
  trend: '' | 'up' | 'down';
  /** ↗ / ↘，无走向时为空 */
  arrow: string;
  /** 整行高亮 class */
  rowClass: '' | 'lap-row--fastest' | 'lap-row--slowest';
  /** 圈数徽标 class */
  tagClass: '' | 'lap-row__tag--fastest';
  /** 圈数徽标文字 */
  tag: '' | '最快' | '最慢';
}

const ARROW: Record<'up' | 'down', string> = { up: '↗', down: '↘' };

/** 同类圈：两圈距离相差不超过较大者的这个比例（800m 快圈与 400m 慢圈不同类）。 */
const SAME_CLASS_TOLERANCE = 0.25;

/** 可排名圈少于这个数就不标最快 / 最慢。 */
const MIN_RANKABLE_LAPS = 3;

function distanceOf(lap: Lap): number {
  return lap.distance_km != null && lap.distance_km > 0 ? lap.distance_km : 0;
}

/** 中位圈距离（只看有效距离）；不足一圈返回 0。 */
function midDistance(laps: Lap[]): number {
  const ds = laps
    .map(distanceOf)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  return ds.length ? ds[ds.length >> 1] : 0;
}

function sameClass(a: Lap, b: Lap): boolean {
  const da = distanceOf(a);
  const db = distanceOf(b);
  return da > 0 && db > 0 && Math.abs(da - db) <= Math.max(da, db) * SAME_CLASS_TOLERANCE;
}

/**
 * 计算圈速表每圈的配速箭头与最快 / 最慢高亮。
 *
 * 两个判断都只收「真跑出来的圈」：间歇课收尾的 13m 残圈、两组之间的 30m 停顿，
 * 配速动辄 40'+/km，收进来它们就永远是全场最快 / 最慢。
 */
export function lapPaceMarks(laps: Lap[]): LapPaceMark[] {
  const median = midDistance(laps);
  // 距离不到中位圈一半的算残圈 / 停顿
  const isRealLap = (lap: Lap) => median > 0 && distanceOf(lap) * 2 >= median && lap.avg_pace != null;

  const rankable = laps.map((lap, i) => (isRealLap(lap) ? i : -1)).filter((i) => i >= 0);
  let fast = -1;
  let slow = -1;
  if (rankable.length >= MIN_RANKABLE_LAPS) {
    // 按配速（s/km，越小越快）比，不按 duration_s —— 距离不同的圈比时间会得出反的结论
    for (const i of rankable) {
      if (fast < 0 || (laps[i].avg_pace as number) < (laps[fast].avg_pace as number)) fast = i;
      if (slow < 0 || (laps[i].avg_pace as number) > (laps[slow].avg_pace as number)) slow = i;
    }
    // 全部同配速时不分高下
    if (laps[fast].avg_pace === laps[slow].avg_pace) fast = slow = -1;
  }

  return laps.map((lap, i) => {
    // 箭头跟「上一圈同类圈」比，不跟紧邻的上一行比：间歇课 800m 快圈之间夹着
    // 400m 慢圈和休息圈，跟紧邻行比会得到一路 ↗↘ 噪声，甚至整片没有箭头。
    let ref = -1;
    if (isRealLap(lap)) {
      for (let j = i - 1; j >= 0; j--) {
        if (isRealLap(laps[j]) && sameClass(lap, laps[j])) {
          ref = j;
          break;
        }
      }
    }
    const prev = ref >= 0 ? (laps[ref].avg_pace as number) : null;
    const cur = lap.avg_pace;
    const trend = cur == null || prev == null || cur === prev ? '' : cur < prev ? 'up' : 'down';
    return {
      trend,
      arrow: trend ? ARROW[trend] : '',
      rowClass: i === fast ? 'lap-row--fastest' : i === slow ? 'lap-row--slowest' : '',
      tagClass: i === fast ? 'lap-row__tag--fastest' : '',
      tag: i === fast ? '最快' : i === slow ? '最慢' : '',
    };
  });
}
