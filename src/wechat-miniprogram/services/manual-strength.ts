import type { ManualStrengthRecord, ManualStrengthSummary, ManualStrengthWrite } from '../types/manual-strength';
import { summarizeStrengthActions } from '../utils/manual-strength';
import { http } from './request';

const liveVersions = new Map<string, number>();
type EditedStrengthSummary = { name: string; summary: ManualStrengthSummary };
const editedSummaries = new Map<string, Map<string, EditedStrengthSummary>>();

export function takeManualStrengthEditedSummaries(userId: string): Map<string, EditedStrengthSummary> | undefined {
  const summaries = editedSummaries.get(userId);
  editedSummaries.delete(userId);
  return summaries;
}

function recordPath(userId: string, recordId: string): string {
  return `/api/${encodeURIComponent(userId)}/activities/manual-strength/${encodeURIComponent(recordId)}`;
}

export function manualStrengthLiveVersion(userId: string): number {
  return liveVersions.get(userId) ?? 0;
}

export function getManualStrengthRecord(userId: string, recordId: string): Promise<ManualStrengthRecord> {
  return http.get<ManualStrengthRecord>(recordPath(userId, recordId));
}

export async function saveManualStrengthRecord(
  userId: string,
  recordId: string,
  write: ManualStrengthWrite,
): Promise<ManualStrengthRecord> {
  const record = await http.put<ManualStrengthRecord, ManualStrengthWrite>(recordPath(userId, recordId), write, {
    privateBody: true,
  });
  if (write.started_at) {
    liveVersions.set(userId, manualStrengthLiveVersion(userId) + 1);
  } else {
    const summaries = editedSummaries.get(userId) ?? new Map<string, EditedStrengthSummary>();
    summaries.set(record.id, { name: record.name.trim(), summary: summarizeStrengthActions(record.actions) });
    editedSummaries.set(userId, summaries);
  }
  return record;
}
