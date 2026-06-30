// Client-side coach session list (multi-session per vision §5.1).
// Sessions are a UI concept: the server derives the thread id as
// `{user}:coach:{session_id}` and persists message history under it. We keep a
// small per-user index in localStorage so the user can switch between
// conversations; the server is the source of truth for message content.

export interface CoachSessionMeta {
  sessionId: string
  title: string
  lastUsed: string // ISO timestamp
}

const KEY_PREFIX = 'stride.coach.sessions.'

function storageKey(user: string): string {
  return `${KEY_PREFIX}${user}`
}

/** Generate a fresh session id constrained to the server's `[A-Za-z0-9_-]` rule. */
export function newSessionId(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '')
  return (cleaned || `s${Date.now()}`).slice(0, 128)
}

/** The server thread id for a coach session. */
export function coachThreadId(user: string, sessionId: string): string {
  return `${user}:coach:${sessionId}`
}

export function loadSessions(user: string): CoachSessionMeta[] {
  try {
    const raw = localStorage.getItem(storageKey(user))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as CoachSessionMeta[])
      .filter((s) => s && typeof s.sessionId === 'string')
      .sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''))
  } catch {
    return []
  }
}

/** Upsert a session (newest-first), capping the list to keep storage bounded. */
export function saveSession(user: string, meta: CoachSessionMeta, max = 30): CoachSessionMeta[] {
  const existing = loadSessions(user).filter((s) => s.sessionId !== meta.sessionId)
  const next = [meta, ...existing].slice(0, max)
  try {
    localStorage.setItem(storageKey(user), JSON.stringify(next))
  } catch {
    /* ignore quota / disabled storage */
  }
  return next
}

export function deriveTitle(message: string, max = 24): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  if (!trimmed) return '新会话'
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}
