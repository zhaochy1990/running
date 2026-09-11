// Coach 对话服务层。

import { http, getToken, refreshToken, handleSessionExpired } from './request';
import { SseParser, type SseEvent } from '../utils/sse';
import { COACH_BASE_URL, CLIENT_ID, COACH_REQUEST_TIMEOUT } from '../constants/config';

// coach_agent_api 对话端点（见 constants/config.ts 的 COACH_BASE_URL）。
const COACH_CHAT_ENDPOINT = `${COACH_BASE_URL}/api/users/me/coach/chat`;

/**
 * 教练对话的权威目标引用（后端 `CoachTargetRef`）。首页「和教练聊一聊」把
 * 具体计划 session 作为上下文挂到一次对话：target 随每轮消息发送，服务端经
 * <coach_turn_scope> 注入模型，使其聚焦该 session（date + session_index）。
 */
export interface CoachSessionTarget {
  kind: 'master' | 'week' | 'session';
  plan_id?: string | null;
  folder?: string | null;
  date?: string | null;
  session_index?: number | null;
}

let turnCounter = 0;

// ── 跨 tab 交接（首页「和教练聊一聊」→ 教练 tab）─────────────────────────────
// switchTab 不能携带 query，因此把待挂载的 target + 展示标签暂存到本地，
// 教练页 onShow 消费后清除。
const PENDING_CONTEXT_KEY = 'coach.pendingContext';

/** 首页「和教练聊一聊」交给教练页的上下文：机器可读 target + 展示标签。 */
export interface PendingCoachContext {
  target: CoachSessionTarget;
  /** 展示用，如「轻松跑 12km · 9月8日」；为空则只显示日期。 */
  label: string;
}

export function setPendingCoachContext(context: PendingCoachContext): void {
  try {
    wx.setStorageSync(PENDING_CONTEXT_KEY, context);
  } catch {
    /* ignore */
  }
}

/** 取走待挂载上下文（仅一次）：教练页创建会话并挂 target 后调用。 */
export function takePendingCoachContext(): PendingCoachContext | null {
  try {
    const v = wx.getStorageSync(PENDING_CONTEXT_KEY);
    if (v && typeof v === 'object' && v.target && typeof v.target.kind === 'string') {
      wx.removeStorageSync(PENDING_CONTEXT_KEY);
      return v as PendingCoachContext;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── 流式（SSE）发送 ──────────────────────────────────────────────────────────
// 请求体与同步路径相同，但 header 带 `Accept: text/event-stream`，服务端（coach_agent_api
// routes/chat.ts）据此走 streamSSE：status（phase 阶段）、text_delta（正文分段）、
// done（完整 message）、error。小程序用 wx.request + enableChunked + onChunkReceived
// 接收分块，经 utils/sse 解析。

export type CoachPhase = 'in_subagent' | 'running_tool' | 'analyzing';

export type CoachStreamEvent =
  | { kind: 'status'; phase: CoachPhase; subagent?: string; tool?: string; toolStatus?: string }
  | { kind: 'delta'; delta: string };

/** done 事件的 data（`{ turn_id, ...toPublicResponse }`）；非流式降级时同步 JSON 也走这里。 */
export interface CoachDone {
  turn_id?: string;
  status?: string;
  message?: string;
  interrupt?: unknown;
  /** generation_proposed：确认卡片携带的提案摘要与 kernel 请求。 */
  summary?: string;
  job_type?: string;
  proposal?: unknown;
}

export interface CoachStreamCallbacks {
  onEvent?: (event: CoachStreamEvent) => void;
  onComplete?: (done: CoachDone) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export interface CoachStreamHandle {
  abort: () => void;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 流式发送一轮 Coach 对话。回调式 API：onEvent（status 阶段 / text_delta 分段）、
 * onComplete（done，携带完整 message）、onError。返回 { abort } 句柄。
 *
 * 401 自动处理：刷新 token 后重试一次；刷新失败清会话回登录页。旧基础库未触发
 * enableChunked 时整体响应落在 success.data（整段 SSE 文本），解析器一次性喂入，
 * 行为等价于同步返回，不会挂起。
 */
export function sendCoachChatStream(
  message: string,
  sessionId = 'mini-default',
  clientTurnId = `mini-${Date.now()}-${++turnCounter}`,
  target?: CoachSessionTarget,
  callbacks: CoachStreamCallbacks = {},
): CoachStreamHandle {
  let task: ReturnType<typeof wx.request> | null = null;
  let disposed = false;
  let retried = false;
  let terminalReached = false;

  const dispatch = (ev: SseEvent): void => {
    if (disposed || terminalReached) return;
    if (ev.event === 'done') {
      terminalReached = true;
      callbacks.onComplete?.(safeParse(ev.data) as unknown as CoachDone);
    } else if (ev.event === 'error') {
      terminalReached = true;
      const e = safeParse(ev.data);
      callbacks.onError?.({ code: (e.code as string) ?? 'coach_turn_failed', message: (e.message as string) ?? 'coach turn failed' });
    } else if (ev.event === 'status') {
      const d = safeParse(ev.data);
      callbacks.onEvent?.({
        kind: 'status',
        phase: d.phase as CoachPhase,
        subagent: d.subagent as string | undefined,
        tool: d.tool as string | undefined,
        toolStatus: d.tool_status as string | undefined,
      });
    } else if (ev.event === 'text_delta') {
      const d = safeParse(ev.data);
      callbacks.onEvent?.({ kind: 'delta', delta: typeof d.delta === 'string' ? d.delta : '' });
    }
  };

  const failOnce = (code: string, message: string): void => {
    if (disposed || terminalReached) return;
    terminalReached = true;
    callbacks.onError?.({ code, message });
  };

  const attempt = (token: string): void => {
    if (disposed) return;
    // parser 每次 attempt 新建：401 刷新重试后不残留上一轮未清空的字节缓冲。
    const parser = new SseParser();
    let cancelled = false;
    let sawChunk = false;
    let statusCode = 0;
    let reqTask: ReturnType<typeof wx.request> | null = null;

    const handle401 = (): void => {
      if (cancelled || disposed) return;
      if (retried) {
        failOnce('unauthorized', '授权过期');
        return;
      }
      retried = true;
      cancelled = true;
      try {
        reqTask?.abort();
      } catch {
        /* abort 触发的 fail 由 cancelled 忽略 */
      }
      task = null;
      refreshToken()
        .then((newToken) => attempt(newToken))
        .catch(() => {
          handleSessionExpired();
          failOnce('session_expired', '登录已过期');
        });
    };

    reqTask = wx.request({
      url: COACH_CHAT_ENDPOINT,
      method: 'POST',
      timeout: COACH_REQUEST_TIMEOUT,
      data: {
        session_id: sessionId,
        message,
        client_turn_id: clientTurnId,
        ...(target ? { target } : {}),
      },
      header: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      enableChunked: true,
      success: (res) => {
        if (cancelled || disposed) return;
        if (res.statusCode === 401) {
          handle401();
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          failOnce(`http_${res.statusCode}`, `请求失败(${res.statusCode})`);
          return;
        }
        // 旧基础库未触达 enableChunked：整段 SSE 文本在 res.data，一次性喂入。
        if (!sawChunk && !terminalReached && res.data != null) {
          const text = typeof res.data === 'string' ? res.data : '';
          if (text) {
            const events = parser.feed(text);
            for (const ev of events) dispatch(ev);
          }
          // 纯 JSON（非流式同步响应）：直接用其 message。
          if (!terminalReached) {
            terminalReached = true;
            callbacks.onComplete?.(
              (typeof res.data === 'string' ? (safeParse(res.data) as unknown as CoachDone) : res.data) as CoachDone,
            );
          }
        }
        // 兜底：2xx 到达却没解析出 done/error —— 先 flush 残余字节，恢复被截断的
        // done/error 事件；仍没有才算失败，避免页面一直停在流式状态。
        if (!terminalReached) {
          const residual = parser.flush();
          for (const ev of residual) dispatch(ev);
        }
        if (!terminalReached) failOnce('empty', '未收到回复');
      },
      fail: (err) => {
        if (cancelled || disposed) return;
        failOnce('network', err.errMsg || 'network error');
      },
    });
    task = reqTask;

    if (reqTask.onHeadersReceived) {
      reqTask.onHeadersReceived((res) => {
        statusCode = res.statusCode;
        if (res.statusCode === 401) handle401();
      });
    }
    if (reqTask.onChunkReceived) {
      reqTask.onChunkReceived((res) => {
        if (cancelled || disposed || statusCode === 401) return;
        sawChunk = true;
        const events = parser.feed(res.data);
        for (const ev of events) dispatch(ev);
      });
    }
  };

  getToken().then((token) => {
    if (disposed) return;
    attempt(token ?? '');
  });

  return {
    abort() {
      disposed = true;
      try {
        task?.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

// GET /api/users/me/coach/sessions/{session_id}/messages 的历史行（stride-coach-api）。
// 普通气泡含 user / assistant + content；计划卡片含 role=assistant + kind。
export interface CoachHistoryMessage {
  role: 'user' | 'assistant';
  content?: string;
  kind?: 'generation_proposed' | 'plan_job';
  summary?: string;
  job_type?: string;
  proposal?: unknown;
  job_id?: string;
}

export interface CoachHistoryResponse {
  session_id: string;
  thread_id: string;
  messages: CoachHistoryMessage[];
}

/**
 * 拉取某会话的完整历史。同一 sessionId 与服务端 thread 一一对应；
 * 页面 onLoad 用它恢复对话，切页/刷新后不再丢历史。
 */
export function fetchCoachHistory(sessionId = 'mini-default'): Promise<CoachHistoryResponse> {
  return http.get<CoachHistoryResponse>(
    `${COACH_BASE_URL}/api/users/me/coach/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

// GET /api/users/me/coach/sessions —— 列出当前用户所有教练会话（历史抽屉用）。
// 每项含 session_id、updated_at、preview（首条用户消息，可为空）。
export interface CoachSessionSummary {
  session_id: string;
  updated_at?: string | null;
  preview?: string;
}

export interface CoachSessionsResponse {
  sessions: CoachSessionSummary[];
}

/**
 * 拉取当前用户的教练会话列表（新→旧）。供历史抽屉展示；
 * 后端未部署/网络异常时由调用方回退到本地列表，不阻塞会话功能。
 */
export function fetchCoachSessions(): Promise<CoachSessionsResponse> {
  return http.get<CoachSessionsResponse>(`${COACH_BASE_URL}/api/users/me/coach/sessions`);
}

// ── 计划任务（Plan Job）─────────────────────────────────────────────────────
// 确认卡片确认后，确定性端点入队为训练计划任务，前端轮询 GET /plan-jobs/{id}
// 拿 status/stage/progress/error_code/result_draft_id；完成态经 Go 草稿端点查看/启用/放弃。

export type PlanJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PlanJobPoll {
  job_id: string;
  job_type: string;
  status: PlanJobStatus;
  stage: string;
  progress_pct: number;
  error_code: string | null;
  result_draft_id: string | null;
}

export function fetchPlanJob(jobId: string): Promise<PlanJobPoll> {
  return http.get<PlanJobPoll>(`${COACH_BASE_URL}/api/users/me/coach/plan-jobs/${encodeURIComponent(jobId)}`);
}

export interface PlanProposalConfirmResult {
  job_id: string;
  job_type: string;
}

/** 运动员在确认卡片上点「确认生成」：确定性端点复验提案、入队并追加确认消息。 */
export function confirmPlanProposal(input: {
  session_id: string;
  client_turn_id: string;
  job_type: string;
  request: unknown;
}): Promise<PlanProposalConfirmResult> {
  return http.post<PlanProposalConfirmResult>(`${COACH_BASE_URL}/api/users/me/coach/plan-proposals/confirm`, input);
}
