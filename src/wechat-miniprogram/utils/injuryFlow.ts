// 伤病流程纯逻辑（#858 PR-E）—— 选项文案、问句形态分流、结果文案、比赛临近
// 判定全部抽纯函数，组件/页面只做接线；node 自检见 utils/injuryFlow.check.mts。

import type { InjuryCheckinAnswer, InjuryVerdict, PlanInjuryState } from '../types/adjustment';

/** 进入流四选一（票面文案）。 */
export interface InjuryVerdictOption {
  value: InjuryVerdict;
  label: string;
}

export const INJURY_VERDICT_OPTIONS: ReadonlyArray<InjuryVerdictOption> = [
  { value: 'continue', label: '能继续练' },
  { value: 'reduced', label: '能减量减强度练' },
  { value: 'rest', label: '得完全停' },
  { value: 'undecided', label: '判断不了，先看医生' },
];

/** 每日轻问四键（票面文案）。 */
export interface InjuryCheckinOption {
  value: InjuryCheckinAnswer;
  label: string;
}

export const INJURY_CHECKIN_OPTIONS: ReadonlyArray<InjuryCheckinOption> = [
  { value: 'better', label: '好转' },
  { value: 'same', label: '持平' },
  { value: 'worse', label: '加重' },
  { value: 'recovered', label: '恢复了' },
];

/** 医生结论三键（pending_doctor 态问句「医生怎么说？」）。 */
export interface InjuryDoctorOption {
  value: Exclude<InjuryVerdict, 'undecided'>;
  label: string;
}

export const INJURY_DOCTOR_OPTIONS: ReadonlyArray<InjuryDoctorOption> = [
  { value: 'continue', label: '能继续练' },
  { value: 'reduced', label: '减量练' },
  { value: 'rest', label: '完全停' },
];

/** 轻问弹层的问句形态（按 injury 行派生，纯函数）。 */
export type InjuryAskKind =
  /** 常规恢复轻问：伤怎么样了？四键 checkin。 */
  | 'checkin'
  /** pending_doctor 态：医生怎么说？三键 doctor。 */
  | 'doctor'
  /** needs_verdict（加重后）：伤有变化，回四选一（enter 覆盖）。 */
  | 'verdict';

/** 默认轻问问句（checkin 形态）。 */
export const INJURY_CHECKIN_QUESTION = '伤怎么样了？';
/** pending_doctor 问句。 */
export const INJURY_DOCTOR_QUESTION = '医生怎么说？';
/** needs_verdict（加重后重新自判）问句。 */
export const INJURY_VERDICT_QUESTION = '伤有变化，现在的情况是？';

/** 问句分流：needs_verdict 优先（answer=worse 的直接后果），其次 pending_doctor。 */
export function injuryAskKind(injury: PlanInjuryState | null): InjuryAskKind | null {
  if (!injury) return null;
  if (injury.needs_verdict) return 'verdict';
  if (injury.mode === 'pending_doctor') return 'doctor';
  return 'checkin';
}

/** 轻问问句文案。 */
export function injuryAskQuestion(kind: InjuryAskKind): string {
  if (kind === 'doctor') return INJURY_DOCTOR_QUESTION;
  if (kind === 'verdict') return INJURY_VERDICT_QUESTION;
  return INJURY_CHECKIN_QUESTION;
}

/** enter 成功后的差异化结果文案（票面口径）。 */
export function enterResultText(verdict: InjuryVerdict, closed: boolean): string {
  if (closed || verdict === 'continue') {
    return '好的，计划照旧；伤情有变随时告诉我';
  }
  if (verdict === 'reduced') {
    return '已进入维持训练：E 有氧为主量减半，去质量课；每天会问你恢复情况';
  }
  if (verdict === 'rest') {
    return '已暂停出课，安心养伤；每天会问你恢复情况';
  }
  return '看完医生回来告诉我结论（每天都会问一次）';
}

/** 轻问一答后的结果文案：recovered 退出；worse 转重判；better/same 记录。 */
export function checkinResultText(
  answer: InjuryCheckinAnswer,
  next: PlanInjuryState | null,
): string {
  if (answer === 'recovered' || next == null) {
    return '已退出伤病模式，训练会按你的最新状态接回';
  }
  if (answer === 'worse' || next.needs_verdict) {
    return '收到，先看看现在的情况能怎么练';
  }
  return '已记录，量会随恢复情况回抬';
}

/** 医生结论后的结果文案（continue 会关模式）。 */
export function doctorResultText(verdict: Exclude<InjuryVerdict, 'undecided'>, closed: boolean): string {
  if (closed || verdict === 'continue') {
    return '好的，计划照旧；伤情有变随时告诉我';
  }
  if (verdict === 'reduced') {
    return '已进入维持训练：E 有氧为主量减半，去质量课；每天会问你恢复情况';
  }
  return '已暂停出课，安心养伤；每天会问你恢复情况';
}

/** 比赛临近窗口（票面：完全停 + 比赛周距今 ≤4 周 → 附「按现状重排」行）。 */
export const RACE_CLOSING_WEEKS = 4;

/**
 * 比赛周距今是否 ≤ N 周（上海日历日整天差；raceYmd 非法/已过按 false）。
 * 页面拿 master-plan/current 的 goal.race_date 调它。
 */
export function raceClosingWithinWeeks(raceYmd: string | null | undefined, todayYmd: string): boolean {
  if (!raceYmd || !/^\d{4}-\d{2}-\d{2}$/.test(raceYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(todayYmd)) {
    return false;
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  // 上海日历日 → UTC epoch（复用 date.ts 同款算式；本文件保持零 wx/Date 本地依赖）。
  const toEpoch = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!) - 8 * 60 * 60 * 1000;
  };
  const days = Math.round((toEpoch(raceYmd) - toEpoch(todayYmd)) / DAY_MS);
  return days >= 0 && days <= RACE_CLOSING_WEEKS * 7;
}

/** 训练计划页提示条：伤病激活时的说明文案（reduced/rest 二态）。 */
export function injuryBannerText(mode: PlanInjuryState['mode']): string {
  if (mode === 'rest') return '伤病停训中 · 每日记录恢复状态';
  return '伤病维持训练中 · 量随恢复回抬';
}
