export type StrengthLoadUnit = 'kg' | 'lb' | 'bodyweight';
export type StrengthQuantityUnit = 'reps' | 'seconds';

export interface ManualStrengthSet {
  load: string;
  load_unit: StrengthLoadUnit;
  quantity: number;
  quantity_unit: StrengthQuantityUnit;
}

export interface ManualStrengthAction {
  name: string;
  sets: ManualStrengthSet[];
}

export interface ManualStrengthSummary {
  action_count: number;
  set_count: number;
}

export interface ManualStrengthContent {
  name: string;
  note: string;
  actions: ManualStrengthAction[];
}

export interface ManualStrengthRecord extends ManualStrengthContent {
  id: string;
  source: 'manual_strength';
  started_at: string;
  ended_at: string;
  revision: number;
}

export interface ManualStrengthWrite extends ManualStrengthContent {
  mutation_id: string;
  revision: number;
  started_at?: string;
}
