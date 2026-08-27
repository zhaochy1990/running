export type ChatRequest = {
  sessionId: string;
  clientTurnId: string;
  message?: string;
  resume?: string | string[];
  target?: Record<string, unknown>;
  reviewContext?: Record<string, unknown>;
};
