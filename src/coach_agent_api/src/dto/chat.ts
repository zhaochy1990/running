export type ChatRequest = {
  sessionId: string;
  clientTurnId: string;
  message?: string;
  /** Client-supplied ISO-8601 timestamp for the message; server generates Beijing time when absent. */
  timestamp?: string;
  resume?: string | string[];
  target?: Record<string, unknown>;
  reviewContext?: Record<string, unknown>;
};
