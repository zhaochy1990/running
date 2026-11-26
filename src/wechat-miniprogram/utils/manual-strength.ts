import type {
  ManualStrengthAction,
  ManualStrengthContent,
  ManualStrengthRecord,
  ManualStrengthSet,
  ManualStrengthSummary,
  ManualStrengthWrite,
} from '../types/manual-strength';
import { epochToShanghaiYmd } from './date';

export const LOAD_UNITS = ['kg', 'lb', 'bodyweight'] as const;
export const LOAD_LABELS: readonly string[] = ['kg', 'lb', '自重'];
export const QUANTITY_UNITS = ['reps', 'seconds'] as const;
export const QUANTITY_LABELS: readonly string[] = ['个', '秒'];

type SetForm = Omit<ManualStrengthSet, 'quantity'> & { key: string; quantity: string };
export interface ActionForm {
  key: string;
  name: string;
  sets: SetForm[];
}

export interface StrengthForm {
  name: string;
  note: string;
  actions: ActionForm[];
}

export interface StrengthDraft {
  id: string;
  startedAt: string;
  revision: number;
  form: StrengthForm;
  pending?: ManualStrengthWrite;
}

type ValidationResult =
  | { content: ManualStrengthContent }
  | { field: string; actionKey: string; message: string };

const DRAFT_PREFIX = 'stride:manualStrengthDraft:v1:';
let keySequence = 0;

function newKey(): string {
  return `${Date.now()}-${keySequence++}`;
}

export async function newStrengthId(): Promise<string> {
  const result = await wx.getRandomValues({ length: 16 });
  const bytes = new Uint8Array(result.randomValues);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newSet(): SetForm {
  return { key: newKey(), load: '', load_unit: 'kg', quantity: '0', quantity_unit: 'reps' };
}

export function copySet(set: SetForm): SetForm {
  return { ...set, key: newKey() };
}

export function newAction(): ActionForm {
  return { key: newKey(), name: '', sets: [newSet()] };
}

export function summarizeStrengthActions(actions: ManualStrengthAction[]): ManualStrengthSummary {
  return {
    action_count: actions.length,
    set_count: actions.reduce((total, action) => total + action.sets.length, 0),
  };
}

export async function newStrengthDraft(startedAt: Date): Promise<StrengthDraft> {
  return {
    id: await newStrengthId(),
    startedAt: startedAt.toISOString(),
    revision: 0,
    form: { name: `${epochToShanghaiYmd(startedAt.getTime())} 力量训练`, note: '', actions: [newAction()] },
  };
}

export function editStrengthDraft(record: ManualStrengthRecord): StrengthDraft {
  return {
    id: record.id,
    startedAt: record.started_at,
    revision: record.revision,
    form: {
      name: record.name,
      note: record.note,
      actions: record.actions.map((action) => ({
        ...action,
        key: newKey(),
        sets: action.sets.map((set) => ({ ...set, key: newKey(), quantity: String(set.quantity) })),
      })),
    },
  };
}

export function getStrengthDraft(userId: string): StrengthDraft | undefined {
  if (!userId) return undefined;
  try {
    const draft = wx.getStorageSync(DRAFT_PREFIX + userId) as StrengthDraft | undefined;
    return draft?.id && draft.form?.actions ? draft : undefined;
  } catch {
    return undefined;
  }
}

export function setStrengthDraft(userId: string, draft: StrengthDraft): void {
  wx.setStorageSync(DRAFT_PREFIX + userId, draft);
}

export function clearStrengthDraft(userId: string, id: string): void {
  if (getStrengthDraft(userId)?.id === id) {
    wx.removeStorageSync(DRAFT_PREFIX + userId);
  }
}

export function matchesStrengthWrite(form: StrengthForm, write: ManualStrengthWrite): boolean {
  const validation = validateStrengthForm(form);
  const { name, note, actions } = write;
  return 'content' in validation && JSON.stringify(validation.content) === JSON.stringify({ name, note, actions });
}

/** Reconcile only the persisted snapshot that sent this request. A later
 * page for the same workout may have added sets while it was in flight. */
export function settleStrengthDraft(userId: string, id: string, write: ManualStrengthWrite, revision: number): void {
  const current = getStrengthDraft(userId);
  if (current?.id !== id || current.pending?.mutation_id !== write.mutation_id) return;
  if (matchesStrengthWrite(current.form, write)) {
    clearStrengthDraft(userId, id);
  } else {
    setStrengthDraft(userId, { ...current, revision, pending: undefined });
  }
}

export function validateStrengthForm(form: StrengthForm): ValidationResult {
  if (!form.name.trim()) {
    return { field: 'training-name', actionKey: '', message: '请填写训练名称' };
  }
  if (!form.actions.length) {
    return { field: 'add-action', actionKey: '', message: '请至少添加一个动作' };
  }
  const actions: ManualStrengthContent['actions'] = [];
  for (const action of form.actions) {
    if (!action.name.trim()) {
      return { field: `action-${action.key}`, actionKey: action.key, message: '请填写动作名称' };
    }
    if (!action.sets.length) {
      return { field: `add-set-${action.key}`, actionKey: action.key, message: '请至少添加一组' };
    }
    const sets: ManualStrengthSet[] = [];
    for (const set of action.sets) {
      const quantity = Number(set.quantity);
      if (!/^\d+$/.test(set.quantity) || !Number.isSafeInteger(quantity) || quantity <= 0) {
        return { field: `quantity-${set.key}`, actionKey: action.key, message: '请输入大于 0 的整数' };
      }
      sets.push({
        load: set.load_unit === 'bodyweight' ? '' : set.load,
        load_unit: set.load_unit,
        quantity,
        quantity_unit: set.quantity_unit,
      });
    }
    actions.push({ name: action.name, sets });
  }
  return { content: { name: form.name, note: form.note, actions } };
}

export function strengthSetLabel(set: ManualStrengthSet): string {
  const quantity = `${set.quantity} ${QUANTITY_LABELS[QUANTITY_UNITS.indexOf(set.quantity_unit)]}`;
  if (set.load_unit === 'bodyweight') return `自重 · ${quantity}`;
  return set.load.trim() ? `${set.load} ${set.load_unit} · ${quantity}` : quantity;
}
