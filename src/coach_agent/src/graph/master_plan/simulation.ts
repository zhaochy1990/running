/**
 * PMC（CTL/ATL）日粒度滚动的纯函数件。
 *
 * #803 起，master plan 的负荷推演不再走「按周估算 strategic load」的老
 * simulation（`simulateMasterPlanLoad` 已随老 kernel 一起删除）——负荷曲线由
 * L4b 排位段产出（`phasing/content/schedule/scheduler.ts` 的 loadSeries/loadMeta）。
 * 这里只保留 weekly 侧仍在用的日粒度 PMC 递推。
 */
export interface PmcDay {
  dose: number;
  atl: number;
  ctl: number;
  form: number;
  ratio: number | null;
}

const ACUTE_K = 1 - Math.exp(-1 / 7);
const CHRONIC_K = 1 - Math.exp(-1 / 42);

const round = (value: number): number => Number(value.toFixed(4));

export function simulatePmcDays(doses: readonly number[], initial: { atl: number; ctl: number }): PmcDay[] {
  let atl = initial.atl;
  let ctl = initial.ctl;
  return doses.map((dose) => {
    atl += ACUTE_K * (dose - atl);
    ctl += CHRONIC_K * (dose - ctl);
    return {
      dose: round(dose),
      atl: round(atl),
      ctl: round(ctl),
      form: round(ctl - atl),
      ratio: ctl > 0 ? round(atl / ctl) : null,
    };
  });
}
