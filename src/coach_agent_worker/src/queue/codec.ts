import type { PlanJobMessage } from "../job/model.js";

/** Wire shape of the pointer message (mirrors Go `job.Message` JSON). */
export interface WireMessage {
  job_id: string;
  user_id: string;
}

export function encodeMessage(message: PlanJobMessage): Buffer {
  const wire: WireMessage = { job_id: message.jobId, user_id: message.userId };
  return Buffer.from(JSON.stringify(wire));
}

export function decodeMessage(body: Buffer): PlanJobMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("malformed message body");
  }
  const wire = parsed as Partial<WireMessage>;
  if (typeof wire?.job_id !== "string" || wire.job_id.length === 0) {
    throw new Error("message missing job_id");
  }
  return { jobId: wire.job_id, userId: typeof wire.user_id === "string" ? wire.user_id : "" };
}
