import type { InitialWeeksResult } from '../services/master-plan';

/** Explain partial/empty first-batch outcomes without claiming a replay did no work. */
export function initialWeeksNotice(result: InitialWeeksResult | undefined): string | null {
  if (!result || result.replayed) return null;
  if (result.skipped.length > 0) {
    return '部分周课未应用，原有安排未更改。请到本周课表查看安排。';
  }
  if (result.applied.length === 0) {
    return '这版计划不含可应用的首批周课，请到本周课表查看安排。';
  }
  return null;
}
