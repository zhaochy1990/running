import type { DataProvider } from "@stride/coach-agent";

const SESSION_PREFIX = "manual-strength-";
const RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type StrengthReviewRecords = Pick<DataProvider, "getManualStrengthDetail">;

export function isStrengthReviewSession(sessionId: string): boolean {
  // Checkpoints use an ASCII case-insensitive collation.
  return sessionId.toLowerCase().startsWith(SESSION_PREFIX);
}

/** The session namespace binds every request to one record owned by the JWT subject. */
export async function findStrengthReviewRecord(records: StrengthReviewRecords | undefined, userId: string, sessionId: string) {
  const recordId = sessionId.slice(SESSION_PREFIX.length);
  if (!records || !sessionId.startsWith(SESSION_PREFIX) || !RECORD_ID_RE.test(recordId)) return null;
  return records.getManualStrengthDetail(userId, recordId);
}
