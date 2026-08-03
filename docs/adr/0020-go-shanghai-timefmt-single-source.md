# Go Shanghai timezone: single-source `internal/utils/timefmt`

The Python side has one canonical Shanghai helper (`stride_core/timefmt.py`), enforced by a CI grep invariant. The Go side had grown **four independent Shanghai (UTC+8) implementations** — `watchmap.ShanghaiDay` (exported, tested, 2 callers), `onboardingcompute.shanghaiToday` (private), `pb.shanghaiDayStr` (private), and `garmin.shanghaiZone` (`time.FixedZone("CST", 8*3600)`) — each re-deriving the same civil-day/zone logic. When the new Go Race Goal handler (ADR 0019) needed a "today in Shanghai" for its future-date guard, adding a fifth copy was the path of least resistance. We instead **create one canonical package and converge the existing four onto it**, mirroring the Python single-source discipline (AGENTS.md "don't reinvent the wheel").

## Decision

- **New package `src/go/internal/utils/timefmt`** (package `timefmt`), the single home for Shanghai civil-day/zone conversions in `src/go`. Named to mirror Python's `stride_core/timefmt.py` — the garmin code already commented that its zone was "matching stride_core.timefmt on the Python side", so the cross-language name aids discoverability. It lives under a neutral `internal/utils/` umbrella rather than in a compute package so general time handling isn't coupled to watch-data mapping.
- **Surface (Shanghai-prefixed exported symbols):**
  - `var Shanghai = time.FixedZone("CST", 8*3600)` — the fixed UTC+8 zone (no DST).
  - `ShanghaiDay(utc time.Time) time.Time` — civil Shanghai day as a UTC-midnight `time.Time` (exact day arithmetic).
  - `ShanghaiToday() time.Time` — `ShanghaiDay(time.Now())`.
  - `ShanghaiDayStr(utc time.Time) string` — `ShanghaiDay(utc).Format("2006-01-02")`.
  The names carry the zone deliberately: with a domain-neutral package name, a bare `Today()` would reintroduce exactly the "today in which timezone?" ambiguity the HARD timezone discipline exists to prevent. `ShanghaiDay` keeps the same name/signature as the exported `watchmap.ShanghaiDay` it replaces, so the migration is a straight move.
- **Full convergence, delete the duplicates.** All four existing implementations are re-expressed on `timefmt` and their local definitions removed: `watchmap.ShanghaiDay` (and its `trainingloadsource` + `calibrationsource` callers + `watchmap_test.go`), `onboardingcompute.shanghaiToday`, `pb.shanghaiDayStr`, and `garmin.shanghaiZone` (which keeps `time.Now().In(timefmt.Shanghai)`). After this there is exactly one Shanghai implementation in `src/go`.
- **Lands as its own prep commit**, before the Race Goal feature commit, so the cross-cutting refactor and the feature are reviewable separately.

## Consequences

- **Blast radius beyond the feature.** The convergence edits `compute/watchmap` (+ two source packages + a test), `handlers/onboardingcompute`, `compute/pb`, and `provider/garmin` — packages unrelated to Race Goals. This is deliberate: it's the price of collapsing to a single source, and it's isolated in its own commit.
- **No Go-side CI grep guard (yet).** Unlike Python's `test_timezone_invariants.py`, there is no automated check preventing a fifth Go copy from reappearing. Adding one is a noted follow-up; for now the single package + this ADR are the guard.
- **Fixed-offset, not IANA.** `timefmt.Shanghai` is `FixedZone("CST", 8*3600)`, matching the existing garmin/Python convention (Asia/Shanghai has no DST), and avoids a `time.LoadLocation` tzdata dependency in the container.
