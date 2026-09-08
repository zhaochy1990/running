// Coach 对话服务层。

import { http } from './request';
import { COACH_BASE_URL, COACH_REQUEST_TIMEOUT } from '../constants/config';

// coach_agent_api 对话端点（见 constants/config.ts 的 COACH_BASE_URL）。
const COACH_CHAT_ENDPOINT = `${COACH_BASE_URL}/api/users/me/coach/chat`;

// 后端 POST /api/users/me/coach/chat 的响应（字段子集，TS coach_agent_api）。
// 完成的回答在顶层 `message`（GFM markdown）；`status` 为 completed 时才有
// `message`，needs_input 时携带 `interrupt`（本文只消费 completed）。
export interface CoachChatResponse {
  status?: string;
  message?: string;
  session_id?: string;
  client_turn_id?: string;
}

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

/**
 * 发送一轮 Coach 对话。client_turn_id 由后端要求（缺失 422），
 * 用于服务端幂等：同一 id + 同一请求重放返回同一 turn，不重复调模型。
 * 重试失败消息时传入同一 clientTurnId，避免重开一轮生成。
 * 可选 target：把本轮焦点锚定到具体计划 session（见 CoachSessionTarget）。
 */
export function sendCoachChatMessage(
  message: string,
  sessionId = 'mini-default',
  clientTurnId = `mini-${Date.now()}-${++turnCounter}`,
  target?: CoachSessionTarget,
): Promise<CoachChatResponse> {
  return http.post<CoachChatResponse>(
    COACH_CHAT_ENDPOINT,
    {
      session_id: sessionId,
      message,
      client_turn_id: clientTurnId,
      ...(target ? { target } : {}),
    },
    { timeout: COACH_REQUEST_TIMEOUT },
  );
}

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

// GET /api/users/me/coach/sessions/{session_id}/messages 的历史行（stride-coach-api）。
// 只含 user / assistant 两种气泡；assistant 正文即 GFM markdown。
export interface CoachHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
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
