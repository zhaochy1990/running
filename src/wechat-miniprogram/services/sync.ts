// 同步服务层 — 触发手表同步 pipeline + 轮询状态

import { http } from './request';
import type {
  TriggerSyncOptions,
  TriggerSyncResponse,
  PipelineRun,
} from '../types/sync';

const PIPELINE_POLL_INTERVAL_MS = 2000;
const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000;

export function triggerSync(
  userId: string,
  options: TriggerSyncOptions = {},
): Promise<TriggerSyncResponse> {
  const { full = false, idempotencyKey } = options;
  const headers: Record<string, string> = {};
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return http.post<TriggerSyncResponse, { mode: string }>(
    `/api/${encodeURIComponent(userId)}/sync`,
    { mode: full ? 'full' : 'incremental' },
    { header: headers },
  );
}

export function getPipelineRun(runId: string): Promise<PipelineRun> {
  return http.get<PipelineRun>(`/api/pipelines/${encodeURIComponent(runId)}`);
}

export interface PollPipelineOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (run: PipelineRun) => void;
}

export interface PollPipelineHandle {
  promise: Promise<PipelineRun>;
  cancel: () => void;
}

export function pollPipeline(
  runId: string,
  options: PollPipelineOptions = {},
): PollPipelineHandle {
  const {
    intervalMs = PIPELINE_POLL_INTERVAL_MS,
    timeoutMs = PIPELINE_TIMEOUT_MS,
    onProgress,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectPromise: ((err: Error) => void) | null = null;

  const promise = new Promise<PipelineRun>((resolve, reject) => {
    rejectPromise = reject;
    const tick = async (): Promise<void> => {
      if (cancelled) {
        reject(new Error('cancelled'));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('同步超时'));
        return;
      }
      try {
        const run = await getPipelineRun(runId);
        // 取消可能发生在 in-flight 请求期间；await 返回后需重查 cancelled，
        // 避免在页面已卸载后仍按实际 pipeline 结局 resolve/reject 并弹 toast。
        if (cancelled) {
          reject(new Error('cancelled'));
          return;
        }
        onProgress?.(run);

        if (run.status === 'done') {
          resolve(run);
          return;
        }
        if (run.status === 'failed') {
          reject(new Error(run.error_message || '同步失败'));
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      timer = setTimeout(tick, intervalMs);
    };

    void tick();
  });

  return {
    promise,
    cancel: () => {
      // 幂等：已在终止路径或已被取消时不重复 settle。
      if (cancelled) return;
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // 若取消发生在轮询间隙（上一次请求已返回、下一次 timer 未触发），
      // tick 不会再次运行，这里必须主动 reject，否则 promise 永远 pending，
      // 调用方的 await 永不返回、finally 不执行，泄漏一个挂起的 promise。
      rejectPromise?.(new Error('cancelled'));
    },
  };
}
