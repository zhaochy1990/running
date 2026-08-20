// profile-transform.js — pure, dependency-free mapping from a user's local
// profile.json / onboarding.json to `user_profile` / `user_onboarding` MySQL rows.
//
// Everything here is deterministic and side-effect free so it can be unit-tested
// without touching the filesystem or MySQL (see test/profile-transform.test.js).
// The output is designed to match the Go worker's GORM models so a migrated row
// is indistinguishable from one the Go API would write/read:
//   - user_profile     : src/go/internal/storage/user_models.go (UserProfile)
//   - user_onboarding  : src/go/internal/storage/user_models.go (UserOnboarding)
//
// Source shape (Python blob layer, ADR 0013):
//   profile.json    { display_name, dob, sex, height_cm, weight_kg, ...legacy keys }
//   onboarding.json { coros_ready, profile_ready, completed_at, sync_state, ... }

/** Raised for a per-record problem; the CLI records it and keeps going. */
export class ProfileTransformError extends Error {}

/**
 * Build a `user_profile` row from a profile.json object.
 *
 * Only the five onboarding core columns are migrated (race/training goals live
 * in a separate future table). Any legacy CJK keys (手表, 目标配速_km, …) are
 * ignored. Missing fields collapse to the Go zero value — "" for strings, 0 for
 * numbers — so the row is byte-identical to one the Go POST handler would write
 * and the Go reader (non-pointer string / float64) never scans a SQL NULL.
 *
 * @param {string} userId canonical app UUID
 * @param {object|string} profileJson parsed object or raw JSON string
 */
export function profileRowFromJson(userId, profileJson) {
  const data = parseObject(profileJson, "profile");
  return {
    user_id: userId,
    display_name: strField(data.display_name),
    dob: strField(data.dob),
    sex: strField(data.sex),
    height_cm: numField(data.height_cm),
    weight_kg: numField(data.weight_kg),
  };
}

/**
 * Build a `user_onboarding` row from an onboarding.json object.
 *
 * Python's `coros_ready` maps to the Go model's provider-agnostic `watch_ready`
 * (`watch_ready` is also accepted if a row was already renamed). `completed_at`
 * is converted to a MySQL datetime(6) UTC string, or NULL when absent/blank.
 *
 * @param {string} userId canonical app UUID
 * @param {object|string} onboardingJson parsed object or raw JSON string
 */
export function onboardingRowFromJson(userId, onboardingJson) {
  const data = parseObject(onboardingJson, "onboarding");
  const rawCompleted = data.completed_at;
  const completed =
    rawCompleted != null && String(rawCompleted).trim() !== ""
      ? isoToMysqlDatetime6(String(rawCompleted))
      : null;
  return {
    user_id: userId,
    // coros_ready is the Python source-of-truth; fall back to a pre-renamed
    // watch_ready if that is what the source carries.
    watch_ready: boolField(data.coros_ready ?? data.watch_ready),
    profile_ready: boolField(data.profile_ready),
    completed_at: completed,
  };
}

/**
 * Convert an ISO-8601 datetime (with `Z`, `±HH:MM`, or no offset) to a MySQL
 * `datetime(6)`-shaped UTC string `YYYY-MM-DD HH:MM:SS.ffffff`.
 *
 * The full fractional part is carried through the string exactly (JS `Date`
 * would truncate to ms); the fraction is offset-invariant, so only the
 * second-precision instant is shifted by the timezone offset. Note the target
 * columns are datetime(3), so MySQL rounds the value to milliseconds at rest —
 * this only guarantees the emitted string is correct up to the column precision.
 * An input without an explicit offset is treated as UTC (the Python source
 * always writes `+00:00`).
 */
export function isoToMysqlDatetime6(iso) {
  const s = String(iso).trim();
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      s,
    );
  if (!m) {
    throw new ProfileTransformError(
      `completed_at is not an ISO-8601 datetime: ${iso}`,
    );
  }
  const [, y, mo, d, h, mi, sec, frac = "", offset = "Z"] = m;
  const micros = (frac + "000000").slice(0, 6);

  let epochSec = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) / 1000;
  if (offset !== "Z") {
    const om = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
    const sign = om[1] === "+" ? 1 : -1;
    const offMin = sign * (Number(om[2]) * 60 + Number(om[3]));
    epochSec -= offMin * 60; // local instant -> UTC instant
  }
  const dt = new Date(epochSec * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return (
    `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())} ` +
    `${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}:${p2(dt.getUTCSeconds())}.${micros}`
  );
}

function parseObject(json, kind) {
  let data;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new ProfileTransformError(`${kind} is not valid JSON`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProfileTransformError(`${kind} must be a JSON object`);
  }
  return data;
}

/** Any value -> string; null/undefined -> "" (Go zero value). */
function strField(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/** Number or numeric string -> number; anything else -> 0 (Go zero value). */
function numField(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Truthy JSON bool/`"true"`/`1` -> true; everything else -> false. */
function boolField(v) {
  return v === true || v === "true" || v === 1;
}
