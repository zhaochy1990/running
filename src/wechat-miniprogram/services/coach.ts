// Coach 对话服务层。

import { http } from './request';

export interface CoachChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// 后端 POST /api/users/me/coach/chat 的响应（字段子集）。
export interface CoachChatResponse {
  session_id?: string;
  assistant_message?: CoachChatMessage;
  created_at?: string;
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
  return http.post<CoachChatResponse>('/api/users/me/coach/chat', {
    session_id: sessionId,
    message,
    client_turn_id: clientTurnId,
  });
}
