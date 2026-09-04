// Coach 对话服务层。

import { http } from './request';

// coach turn 是 LLM 编排，可能明显慢于普通读接口，单独放宽超时（微信 60s 上限），
// 避免快速误判失败落兜底文案。普通接口仍走全局 REQUEST_TIMEOUT(15s)。
const COACH_CHAT_TIMEOUT = 60000;

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
 * 用于服务端幂等；本地生成自增 id。
 */
export function sendCoachChatMessage(
  message: string,
  sessionId = 'mini-default',
): Promise<CoachChatResponse> {
  const clientTurnId = `mini-${Date.now()}-${++turnCounter}`;
  return http.post<CoachChatResponse>(
    '/api/users/me/coach/chat',
    {
      session_id: sessionId,
      message,
      client_turn_id: clientTurnId,
    },
    { timeout: COACH_CHAT_TIMEOUT },
  );
}
