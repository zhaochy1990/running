import { z } from "zod/v4";
import { EVAL_MESSAGE_SCHEMA_VERSION, type EvalExecutionMessage } from "./protocol.js";

const wireSchema = z.object({ schema_version: z.literal(EVAL_MESSAGE_SCHEMA_VERSION), snapshot_execution_id: z.string().min(1) }).strict();

/** Wire shape of the eval pointer message (mirrors Go `planeval.ExecuteMessage`). */
export function encodeExecutionMessage(snapshotExecutionId: string): Buffer {
  const wire: EvalExecutionMessage = { schema_version: EVAL_MESSAGE_SCHEMA_VERSION, snapshot_execution_id: snapshotExecutionId };
  return Buffer.from(JSON.stringify(wire));
}

/** 解不出来的指针永远处理不了：调用方直接丢弃（不重投）。 */
export function decodeExecutionMessage(body: Buffer): EvalExecutionMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("malformed eval message body");
  }
  return wireSchema.parse(parsed);
}
