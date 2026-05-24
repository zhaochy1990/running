/**
 * Asia/Shanghai timezone helpers — the canonical (and only) place the
 * frontend should do date/time math on activity timestamps.
 *
 * Why this module exists:
 * - `coros.db` stores UTC ISO 8601 strings. The backend serializes them
 *   to Shanghai ISO (`...+08:00`) at the API boundary so plain string
 *   slicing yields the correct Shanghai date.
 * - Even so, never trust `new Date()` or `d.getDate()` for date math on
 *   the frontend: those return browser-local values, which is correct
 *   when the user is in China but silently wrong abroad.
 * - These helpers pin every date computation to `Asia/Shanghai` so the
 *   result is invariant regardless of where the dashboard is opened.
 *
 * Forbidden patterns (a manual code-review checklist; mirrored in
 * `tests/test_timezone_invariants.py` on the backend):
 *   - `activity.date.slice(0, 10)`  → use `shanghaiDate(activity.date)`
 *   - `activity.date.slice(5, 10)`  → use `shanghaiMonthDay(activity.date)`
 *   - `new Date().getFullYear()` etc. for "today"  → use `shanghaiToday()`
 */

const SHANGHAI_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const SHANGHAI_MD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
})

const SHANGHAI_ZH_SHORT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
})

const SHANGHAI_HMS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const SHANGHAI_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * Parse the various date-shaped strings the backend hands us into a `Date`
 * instant. Accepts ISO 8601 (with or without offset), `YYYYMMDD`, and
 * `YYYY-MM-DD`. Returns null when the input is empty or unparseable.
 *
 * Note: bare `YYYY-MM-DD` is treated as Shanghai 00:00 (not UTC midnight, the
 * default `new Date()` behavior). This matters because the backend serves
 * `date_from`/`date_to` as YYYY-MM-DD Shanghai dates.
 */
function parseToInstant(s: string | null | undefined): Date | null {
  if (!s) return null
  // Full ISO 8601: trust offset if present, otherwise treat as UTC.
  if (s.includes('T')) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  // Compact YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4)
    const m = +s.slice(4, 6)
    const d = +s.slice(6, 8)
    // Shanghai 00:00 of that day. (+08:00 → UTC y-m-(d-1) 16:00)
    return new Date(Date.UTC(y, m - 1, d) - 8 * 3600 * 1000)
  }
  // YYYY-MM-DD: pin to Shanghai midnight, not the JS default UTC midnight.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 8 * 3600 * 1000)
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** Return `YYYY-MM-DD` in Asia/Shanghai for any timestamp-shaped input. */
export function shanghaiDate(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  return SHANGHAI_YMD.format(d)
}

/** Return `MM-DD` in Asia/Shanghai (sidebar / mini-list use). */
export function shanghaiMonthDay(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  // en-CA emits MM-DD with two digits, matching the previous slice(5, 10).
  return SHANGHAI_MD.format(d)
}

/** Localized short date (e.g. `5月9日`) — display only. */
export function shanghaiMonthDayCN(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  return SHANGHAI_ZH_SHORT.format(d).replace(/\//g, '/')
}

/** Return `HH:MM:SS` in Asia/Shanghai. */
export function shanghaiTime(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  return SHANGHAI_HMS.format(d)
}

/** Return `HH:MM` in Asia/Shanghai (used in feedback headers). */
export function shanghaiTimeShort(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  return SHANGHAI_HM.format(d)
}

/** Today's date as `YYYY-MM-DD` in Asia/Shanghai. Replaces
 * `new Date().getFullYear()` patterns that quietly resolve to browser TZ. */
export function shanghaiToday(): string {
  return SHANGHAI_YMD.format(new Date())
}

/** Weekday label for a Shanghai-pinned date (周一…周日). */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const SHANGHAI_DOW = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
})
const DOW_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}
export function shanghaiWeekday(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  const idx = DOW_MAP[SHANGHAI_DOW.format(d)] ?? 0
  return WEEKDAYS[idx]
}

/**
 * Return the Monday of the Shanghai-local week containing the given date,
 * as `YYYY-MM-DD`. Week start = Monday (ISO 8601, matches the project's
 * weekly_plan convention).
 *
 * Returns '' for null/empty/unparseable input. The arithmetic is done in
 * Shanghai time, so Sunday 23:00 UTC (= Monday 07:00 Shanghai) correctly
 * resolves to that Monday's week.
 */
export function shanghaiWeekStart(s: string | null | undefined): string {
  const d = parseToInstant(s)
  if (!d) return ''
  const ymd = SHANGHAI_YMD.format(d)
  const dowIdx = DOW_MAP[SHANGHAI_DOW.format(d)] ?? 0
  const daysBack = (dowIdx + 6) % 7  // Mon→0, Tue→1, …, Sun→6
  const [y, m, day] = ymd.split('-').map(Number)
  const anchor = new Date(Date.UTC(y, m - 1, day))
  anchor.setUTCDate(anchor.getUTCDate() - daysBack)
  const yy = anchor.getUTCFullYear()
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(anchor.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}
