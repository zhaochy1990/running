import type { ManualStrengthRecord, ManualStrengthWrite } from '../types/manual-strength';
import { http } from './request';

const liveVersions = new Map<string, number>();
const editedNames = new Map<string, Map<string, string>>();

export function takeManualStrengthEditedNames(userId: string): Map<string, string> | undefined {
  const names = editedNames.get(userId);
  editedNames.delete(userId);
  return names;
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
    const names = editedNames.get(userId) ?? new Map<string, string>();
    names.set(record.id, record.name.trim());
    editedNames.set(userId, names);
  }
  return record;
}
