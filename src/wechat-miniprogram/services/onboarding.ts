// Onboarding 服务层 —— 两件互不依赖的事：
//
//   1. 完成（complete）：只要求基础档案（ADR 0013）。资料保存成功即可标记完成，
//      不依赖手表绑定，也不依赖任何 pipeline。
//   2. 数据同步（sync）：绑表之后触发的 full sync。它**不是**完成的前置，纯粹为了
//      把训练数据拉下来。
//
// 所以这里没有"等 run 跑完再收尾"的链路：`completeOnboarding()` 与 `ensureSync()`
// 各管各的，谁也不用等谁。
//
// 同步的语义对齐 Web 的 pages/onboarding/SubmitStep.tsx：triggerSync(full) +
// Idempotency-Key → 轮询 run。与 Web 的一处差异：触发前会列一次该用户的 run，
// 认领别端（Web / 换设备）已经起过的那次 —— Web 只信自己的 localStorage 指针，
// 指针丢了就重复起一个 full sync。
//
// 为什么"续跑"是主路径：onboarding pipeline 在生产实测平均 24 分钟（最长 51 分钟），
// 小程序必然会在中途被杀掉，所以每次进页面都要能接着上次那次 run 继续。

import { getPipelineRun, listUserPipelines, triggerSync } from './sync';
import { getMyProfile } from './profile';
import { ApiError, http } from './request';
import type { PipelineRun } from '../types/sync';

/** onboarding pipeline 的名字（Go catalog.PipelineOnboarding）。 */
const ONBOARDING_PIPELINE = 'onboarding';

// 同步 run 的本地指针。键名带 userId 是因为小程序可以换账号，而 STORAGE_KEYS 都是
// 全局单键，不能复用。前缀沿用 Web 的 stride:onboarding-*，两端对照排查时能对上。
const RUN_KEY_PREFIX = 'stride:onboarding-run:';
const START_KEY_PREFIX = 'stride:onboarding-start-key:';

export interface OnboardingStatus {
  watchReady: boolean;
  profileReady: boolean;
  completed: boolean;
  /** 部署开关：config.yml 的 sync-data-at-onboarding，只关同步、不影响完成。 */
  syncEnabled: boolean;
}

/** 读 onboarding 状态。复用 GET /api/users/me/profile（后端本来就在返回这两块）。 */
export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const p = await getMyProfile();
  const onb = p.onboarding;
  return {
    watchReady: onb?.watch_ready === true,
    profileReady: onb?.profile_ready === true,
    completed: !!onb?.completed_at,
    // 字段缺失按"关"处理：宁可不动 24 分钟的 pipeline，也不要在开关状态未知时乱触发
    syncEnabled: p.features?.sync_data_at_onboarding === true,
  };
}

/**
 * 标记 onboarding 完成。资料已保存时调用；服务端幂等（已完成返回 already-complete）。
 * 不传 run_id：完成不再需要 pipeline（ADR 0013）。
 */
export async function completeOnboarding(): Promise<void> {
  await http.post<{ state?: string }>('/api/users/me/onboarding/complete', {});
  console.log('[onboarding] 服务端已标记 onboarding 完成');
}

export type SyncPhase = 'disabled' | 'no-watch' | 'running' | 'done' | 'failed';

export interface SyncResult {
  phase: SyncPhase;
  runId?: string;
  message?: string;
}

/**
 * 幂等入口：确保该用户有一个正在跑的同步 run，返回当前该走的状态。
 * 顺序：开关 → 有表 → 本地指针 → 认领别端的 run → 触发。
 */
export async function ensureSync(userId: string): Promise<SyncResult> {
  const status = await getOnboardingStatus();
  if (!status.syncEnabled) {
    console.warn('[onboarding] 部署开关 sync_data_at_onboarding 为 false，不触发同步');
    return { phase: 'disabled' };
  }
  if (!status.watchReady) {
    console.log('[onboarding] 尚未绑表，不触发同步（pipeline 第一步就是 watch sync）');
    return { phase: 'no-watch' };
  }

  // 1) 本地指针
  const stored = readPointer(userId);
  if (stored) {
    const { verdict, run } = await lookupRun(stored);
    if (verdict === 'valid' && run) return toResult(run);
    if (verdict === 'transient') {
      // 查不动（服务端抖了）：保留指针，让页面继续按这个 runId 轮询
      console.warn(`[onboarding] 查询 run ${stored} 暂时失败，保留指针继续轮询`);
      return { phase: 'running', runId: stored };
    }
    console.warn(`[onboarding] 本地指针 ${stored} 已失效，丢弃后重新解析`);
    clearPointer(userId);
  }

  // 2) 认领别端已起的 run（换设备 / Web 先起过）。
  //    只认非 failed 的：failed 需要用户主动重试起新 run；done 的正好认领来展示结果。
  try {
    const { pipelines } = await listUserPipelines(userId);
    const existing = (pipelines || []).find(
      (r) => r.pipeline_name === ONBOARDING_PIPELINE && r.status !== 'failed',
    );
    if (existing) {
      console.log(`[onboarding] 认领已有 run ${existing.run_id}（${existing.status}）`);
      savePointer(userId, existing.run_id);
      return toResult(existing);
    }
  } catch (err) {
    // 列不出来不阻断：幂等键仍然保证不会重复建 run
    console.warn('[onboarding] 列已有 run 失败，改为直接触发（靠幂等键去重）', err);
  }

  // 3) 触发。key 必须**先落盘再发请求**：请求超时/响应丢失时下次进来复用同一把 key，
  //    服务端 uq_runs_user_idem 会返回已创建的那个 run，而不是再建一个。
  const key = startKeyFor(userId);
  console.log(`[onboarding] 触发 full sync（Idempotency-Key=${key}）`);
  const res = await triggerSync(userId, { full: true, idempotencyKey: key });
  if (!res.run_id) {
    throw new Error(res.error || '同步任务创建失败');
  }
  if (res.deduplicated) {
    console.log('[onboarding] 幂等键命中已有 run（重复触发被服务端去重）');
  }
  savePointer(userId, res.run_id);
  // run 已经建出来了，key 的使命到此结束（它只防"重复创建"），续跑靠 runId 指针。
  // 清掉它，用户失败后重试才算一次新尝试、才会起新 run。
  clearStartKey(userId);
  return { phase: 'running', runId: res.run_id };
}

/** 失败后重试：清指针与旧 key，确保起一个**新** run（否则幂等键会把那个失败的 run 带回来）。 */
export async function retrySync(userId: string): Promise<SyncResult> {
  console.log('[onboarding] 用户重试：清本地指针与幂等键');
  clearPointer(userId);
  clearStartKey(userId);
  return ensureSync(userId);
}

// --- 本地指针 / 幂等键 ---

type Verdict = 'valid' | 'invalid' | 'transient';

function classifyLookupError(err: unknown): Verdict {
  // 4xx = 服务端明确不认这个 run（不存在 / 不属于我 / 400）→ 指针作废重开；
  // 5xx 与网络异常是暂时性的 → 保留指针，免得白扔一个已经跑了很久的 full sync。
  if (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500) {
    return 'invalid';
  }
  return 'transient';
}

async function lookupRun(runId: string): Promise<{ verdict: Verdict; run?: PipelineRun }> {
  try {
    const run = await getPipelineRun(runId);
    if (run.pipeline_name !== ONBOARDING_PIPELINE) return { verdict: 'invalid' };
    return { verdict: 'valid', run };
  } catch (err) {
    return { verdict: classifyLookupError(err) };
  }
}

function toResult(run: PipelineRun): SyncResult {
  if (run.status === 'failed') {
    return { phase: 'failed', runId: run.run_id, message: run.error_message };
  }
  if (run.status === 'done') return { phase: 'done', runId: run.run_id };
  return { phase: 'running', runId: run.run_id };
}

function readPointer(userId: string): string {
  const v = wx.getStorageSync(RUN_KEY_PREFIX + userId);
  return typeof v === 'string' ? v : '';
}

function savePointer(userId: string, runId: string): void {
  wx.setStorageSync(RUN_KEY_PREFIX + userId, runId);
}

function clearPointer(userId: string): void {
  wx.removeStorageSync(RUN_KEY_PREFIX + userId);
}

/** 幂等键：读不到才生成，且先落盘再用（理由见调用处注释）。 */
function startKeyFor(userId: string): string {
  const existing = wx.getStorageSync(START_KEY_PREFIX + userId);
  if (typeof existing === 'string' && existing) return existing;
  // 小程序没有 crypto.randomUUID，用时间戳 + 随机串（与 Web 的降级分支同思路）
  const key = `mp-onboarding-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  wx.setStorageSync(START_KEY_PREFIX + userId, key);
  return key;
}

function clearStartKey(userId: string): void {
  wx.removeStorageSync(START_KEY_PREFIX + userId);
}
