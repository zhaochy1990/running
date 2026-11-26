// 首次同步 session 客户端（devops#1015 / epic devops#1004 T11；服务端契约 devops#1006）。
//
// 与旧 full-run 流程（services/onboarding.ts 的 ensureSync）是两条互斥路径，由
// profile features 的双开关决定：sync_data_at_onboarding（总开关）与
// onboarding_sync_session（新 rollout）同时开才走这里；任一关闭维持旧路径。
//
// 与旧路径的本质差异：**没有本地指针，也没有幂等键**。session 的创建/认领是
// 服务端原子操作（同绑定多端并发 POST 解析到同一个 session；杀进程、换设备、
// 重新登录后再 POST 一次也只是认领，不会重复起 full）。所以小程序端只需要：
//   - 提交步：POST（创建/认领）→ 等 shell_ready（session 与可靠派发记录均已
//     持久化）→ profile-only 完成后进首页；新 run 永远不交给旧完成验证。
//   - 首页状态卡：GET 只读轮询 + 失败时 POST {retry:true}（只恢复未完成工作，
//     已成功抓取的范围服务端复用凭据，不重拉）。

import { ApiError, http } from './request';

/** GET/POST /api/users/me/onboarding/sync（user-tier "me"，客户端不能指定他人）。 */
const SESSION_ENDPOINT = '/api/users/me/onboarding/sync';

// —— 服务端 View 契约（Go internal/onboardingsync.View；与 Web frontend/src/api.ts 对齐）——

/** 单阶段就绪度（服务端按上报覆盖推导，客户端只展示、不自行推断）。 */
export type OnboardingSyncReadiness =
  | 'not_started'
  | 'pending'
  | 'running'
  | 'ready'
  | 'ready_with_gaps'
  | 'failed'
  | 'partial'
  | 'unavailable';

/** 合法缺测（厂商实际没有的数据），与「待抓取失败」语义不同，展示必须区分。 */
export interface OnboardingSyncStageGap {
  from: string;
  to: string;
  reason?: string;
}

export interface OnboardingSyncStageView {
  stage: string;
  status: string;
  readiness: OnboardingSyncReadiness;
  target_from: string;
  target_to: string;
  scanned_from?: string | null;
  scanned_to?: string | null;
  observed_from?: string | null;
  observed_to?: string | null;
  gaps?: OnboardingSyncStageGap[];
  job_id?: string | null;
  error?: string | null;
}

export interface OnboardingSyncView {
  session_id: string;
  /** waiting_legacy | dispatching | running | completed | completed_with_gaps | failed | superseded */
  state: string;
  /** session 与可靠派发记录均已持久化；true 之前 UI 不得声称后台正在同步。 */
  shell_ready: boolean;
  provider: string;
  binding_revision: number;
  anchor_day: string;
  legacy_run_id?: string | null;
  retry_count: number;
  historical_analysis_reason?: string;
  historical_analysis_poll?: boolean;
  error?: string | null;
  stages: OnboardingSyncStageView[];
  readiness: {
    shell_ready: boolean;
    recent_data: OnboardingSyncReadiness;
    recent_analysis: OnboardingSyncReadiness;
    extended_data: OnboardingSyncReadiness;
    historical_data: OnboardingSyncReadiness;
    historical_analysis: OnboardingSyncReadiness;
    auxiliary: OnboardingSyncReadiness;
  };
  created_at: string;
  updated_at: string;
}

/** 只读状态。404 = 尚无 session；403 = 任一开关关闭（入口对该客户端不存在）。 */
export function getOnboardingSyncSession(): Promise<OnboardingSyncView> {
  return http.get<OnboardingSyncView>(SESSION_ENDPOINT);
}

/** 创建或认领当前用户当前绑定的 session（幂等；唯一客户端输入是 retry）。 */
export function createOrClaimOnboardingSyncSession(): Promise<OnboardingSyncView> {
  return http.post<OnboardingSyncView>(SESSION_ENDPOINT, {});
}

/** 显式重试：只重新派发未完成的工作，已成功范围复用凭据不重拉。 */
export function retryOnboardingSyncSession(): Promise<OnboardingSyncView> {
  return http.post<OnboardingSyncView, { retry: boolean }>(SESSION_ENDPOINT, { retry: true });
}

// —— 错误分类（onboarding 页与状态卡都靠它决定回退/隐藏/重试）——

/** 403（开关关闭）或 503（部署未接线）：session 入口不可用，回退旧 full-run 流程。 */
export function isSessionEntryUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.statusCode === 403 || err.statusCode === 503);
}

/** 409 no_watch_provider：能力标志不满足（没绑表），应回绑表步而不是报错。 */
export function isNoWatchProvider(err: unknown): boolean {
  return err instanceof ApiError && err.statusCode === 409 && err.code === 'no_watch_provider';
}

/** 404：还没有 session（没走过 session 流程的老用户 / 尚未提交），状态卡静默隐藏。 */
export function isNoSession(err: unknown): boolean {
  return err instanceof ApiError && err.statusCode === 404;
}
