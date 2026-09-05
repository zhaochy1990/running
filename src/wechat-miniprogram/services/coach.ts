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

let turnCounter = 0;

/**
 * 发送一轮 Coach 对话。client_turn_id 由后端要求（缺失 422），
 * 用于服务端幂等：同一 id + 同一请求重放返回同一 turn，不重复调模型。
 * 重试失败消息时传入同一 clientTurnId，避免重开一轮生成。
 */
export function sendCoachChatMessage(
  message: string,
  sessionId = 'mini-default',
  clientTurnId = `mini-${Date.now()}-${++turnCounter}`,
): Promise<CoachChatResponse> {
  return http.post<CoachChatResponse>(
    COACH_CHAT_ENDPOINT,
    {
      session_id: sessionId,
      message,
      client_turn_id: clientTurnId,
    },
    { timeout: COACH_REQUEST_TIMEOUT },
  );
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
