// Mirrors `src/stride_server/routes/strength.py` response shape.

export type StrengthTargetKind = 'reps' | 'time_s'

export interface StrengthTabExercise {
  // From the planned spec (always present):
  canonical_id: string
  display_name: string
  sets: number
  target_kind: StrengthTargetKind
  target_value: number
  rest_seconds: number
  note: string | null

  // Joined from the curated library (null/empty when no match or image
  // not product-grade):
  code: string | null
  image_url: string | null
  name_zh: string | null
  key_points: string[]
  muscle_focus: string[]
  common_mistakes: string[]
}

export interface StrengthTabSession {
  date: string                       // ISO YYYY-MM-DD
  session_index: number
  summary: string
  notes_md: string | null
  exercises: StrengthTabExercise[]
}

export interface StrengthTabResponse {
  folder: string
  sessions: StrengthTabSession[]
}
