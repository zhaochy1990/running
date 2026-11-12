// 伤病模式服务层（#858 PR-E）—— Go plan_injury.go 用户通道封装。
//
// 语义（票面 Q11/Q14 定稿）：enter 四选一自判（continue 立即关闭仅记录）；
// checkin 每天一答（recovered 关闭 / worse 置 needs_verdict 要求重判）；
// doctor 解决 pending_doctor 待定（continue 关闭）。关闭路径统一回
// {closed:true}，否则回读 injury 行。

import { http, ApiError } from './request';
import type { InjuryCheckinAnswer, InjuryMutationResult, InjuryVerdict, PlanInjuryState } from '../types/adjustment';

/** 拉当前激活的伤病状态；不在伤病模式（404）返回 null。 */
export async function getInjuryState(userId: string): Promise<PlanInjuryState | null> {
  try {
    const res = await http.get<{ injury: PlanInjuryState }>(
      `/api/users/${encodeURIComponent(userId)}/plan-injury`,
    );
    return res.injury;
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) return null;
    throw err;
  }
}

/** 进入伤病模式：detail（哪里伤/一句话，给教练看）+ 四选一自判。 */
export function enterInjury(
  userId: string,
  detail: string,
  verdict: InjuryVerdict,
): Promise<InjuryMutationResult> {
  return http.post<InjuryMutationResult, { detail: string; verdict: InjuryVerdict }>(
    `/api/users/${encodeURIComponent(userId)}/plan-injury/enter`,
    { detail, verdict },
  );
}

/** 每日恢复轻问：better/same 记履历；worse 置 needs_verdict；recovered 关闭。 */
export function checkinInjury(
  userId: string,
  answer: InjuryCheckinAnswer,
): Promise<InjuryMutationResult> {
  return http.post<InjuryMutationResult, { answer: InjuryCheckinAnswer }>(
    `/api/users/${encodeURIComponent(userId)}/plan-injury/checkin`,
    { answer },
  );
}

/** 医生结论三选一（pending_doctor 态）：continue 关闭；reduced/rest 转模式。 */
export function answerInjuryDoctor(
  userId: string,
  verdict: Exclude<InjuryVerdict, 'undecided'>,
): Promise<InjuryMutationResult> {
  return http.post<InjuryMutationResult, { verdict: Exclude<InjuryVerdict, 'undecided'> }>(
    `/api/users/${encodeURIComponent(userId)}/plan-injury/doctor`,
    { verdict },
  );
}
