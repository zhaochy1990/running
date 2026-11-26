import type { ManualStrengthRecord, ManualStrengthSummary, ManualStrengthWrite } from '../types/manual-strength';
import { clearStrengthDraft, summarizeStrengthActions } from '../utils/manual-strength';
import { http } from './request';

const listVersions = new Map<string, number>();
type DeletionListener = (userId: string, recordId: string) => void;
const deletionListeners = new Set<DeletionListener>();
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

export function manualStrengthListVersion(userId: string): number {
  return listVersions.get(userId) ?? 0;
}

export function subscribeManualStrengthDeletion(listener: DeletionListener): () => void {
  deletionListeners.add(listener);
  return () => { deletionListeners.delete(listener); };
}

export function getManualStrengthRecord(userId: string, recordId: string): Promise<ManualStrengthRecord> {
  return http.get<ManualStrengthRecord>(recordPath(userId, recordId));
}

export async function deleteManualStrengthRecord(userId: string, recordId: string): Promise<void> {
  await http.delete<void>(recordPath(userId, recordId));
  listVersions.set(userId, manualStrengthListVersion(userId) + 1);
  editedSummaries.get(userId)?.delete(recordId);
  try {
    clearStrengthDraft(userId, recordId);
  } catch {
    console.warn('Could not clear the local draft for a deleted strength record');
  }
  for (const listener of deletionListeners) listener(userId, recordId);
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
    listVersions.set(userId, manualStrengthListVersion(userId) + 1);
  } else {
    const summaries = editedSummaries.get(userId) ?? new Map<string, EditedStrengthSummary>();
    summaries.set(record.id, { name: record.name.trim(), summary: summarizeStrengthActions(record.actions) });
    editedSummaries.set(userId, summaries);
  }
  return record;
}
