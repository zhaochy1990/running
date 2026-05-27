# 16-Week Training Activity Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub-style 16-week activity heatmap to the `/training-status` page, placed next to the existing "8 周负荷趋势" chart inside `TrainingLoadSection`, with cell color driven by STRIDE `training_dose` and tooltip reusing `DailyDoseTooltip`.

**Architecture:** Pure frontend change — no backend, no schema, no new API. Reuse existing `getStrideTrainingLoad.series` for dose values; reuse existing `getActivities` (with new paginated wrapper) for tooltip activity rows; reuse existing `shanghaiWeekStart` for Monday alignment. New `ActivityHeatmap` component is plain SVG (no Recharts) inline in `TrainingStatusPage.tsx`. The 8-week trend chart wrapper changes from full-width to a 2-column grid (lg:50/50) with the heatmap on the right.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Vitest + @testing-library/react.

**Spec reference:** `docs/superpowers/specs/2026-05-27-training-status-16w-heatmap-design.md`

---

## File Structure

**Modify:**
- `frontend/src/api.ts` — add `getAllActivitiesInRange` helper (paginated wrapper around `getActivities`)
- `frontend/src/pages/TrainingStatusPage.tsx` — bump fetch window to ≥112 days, switch to paginated activities fetch, add `heatmapBucket` / `HEATMAP_COLORS` constants, add `ActivityHeatmap` component, restructure 8-week-trend wrapper into a 2-column grid
- `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` — update existing 56-day assertion to 112, add heatmap render test, add paginated fetch test, update default `getActivities` mock shape

**No changes needed:**
- `frontend/src/lib/shanghai.ts` — `shanghaiWeekStart` already exists with the exact semantics needed (Monday-start, Shanghai-pinned, handles both `YYYY-MM-DD` and ISO timestamps; tested in `shanghai.test.ts:72-98`)
- Backend — `/api/{user}/activities` already supports `offset` + returns `total` for pagination; `/api/{user}/stride/training-load` already accepts arbitrary `days` parameter

---

## Task 1: Add `getAllActivitiesInRange` paginated helper

**Files:**
- Modify: `frontend/src/api.ts` (insert immediately after `getActivities`, around line 423)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` (after the existing `describe('TrainingStatusPage', ...)` block). This test imports the helper directly, calls it, and verifies pagination behavior.

Add at the top of the file (with the other imports):

```ts
import { getAllActivitiesInRange } from '../../api'
```

Append at the end of the file:

```tsx
describe('getAllActivitiesInRange', () => {
  it('returns a single page when total fits in one fetch', async () => {
    const acts = Array.from({ length: 50 }, (_, i) => ({ label_id: `a${i}` } as api.Activity))
    vi.mocked(api.getActivities).mockResolvedValueOnce({
      total: 50, offset: 0, limit: 200, activities: acts,
    })
    const out = await getAllActivitiesInRange(USER, { dateFrom: '2026-02-09' })
    expect(out).toHaveLength(50)
    expect(api.getActivities).toHaveBeenCalledTimes(1)
    expect(api.getActivities).toHaveBeenCalledWith(USER, {
      dateFrom: '2026-02-09', limit: 200, offset: 0,
    })
  })

  it('paginates when total exceeds one page', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ label_id: `a${i}` } as api.Activity))
    const page2 = Array.from({ length: 50 }, (_, i) => ({ label_id: `b${i}` } as api.Activity))
    vi.mocked(api.getActivities)
      .mockResolvedValueOnce({ total: 250, offset: 0,   limit: 200, activities: page1 })
      .mockResolvedValueOnce({ total: 250, offset: 200, limit: 200, activities: page2 })
    const out = await getAllActivitiesInRange(USER, { dateFrom: '2026-02-09' })
    expect(out).toHaveLength(250)
    expect(api.getActivities).toHaveBeenCalledTimes(2)
    expect(api.getActivities).toHaveBeenNthCalledWith(2, USER, {
      dateFrom: '2026-02-09', limit: 200, offset: 200,
    })
  })

  it('passes dateTo through when provided', async () => {
    vi.mocked(api.getActivities).mockResolvedValueOnce({
      total: 0, offset: 0, limit: 200, activities: [],
    })
    await getAllActivitiesInRange(USER, { dateFrom: '2026-02-09', dateTo: '2026-05-27' })
    expect(api.getActivities).toHaveBeenCalledWith(USER, {
      dateFrom: '2026-02-09', dateTo: '2026-05-27', limit: 200, offset: 0,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'getAllActivitiesInRange'`
Expected: FAIL — error like `getAllActivitiesInRange is not a function` or import error (the symbol doesn't exist yet).

- [ ] **Step 3: Implement `getAllActivitiesInRange` in `api.ts`**

Open `frontend/src/api.ts`. Find the existing `getActivities` function (~line 411). Insert this new function immediately after it (before `triggerSync`):

```ts
/**
 * Fetch all activities matching the given date range, walking the server's
 * pagination automatically. The activities endpoint caps `limit` at 200
 * (`src/stride_server/routes/activities.py`), so callers that need a longer
 * window must paginate. Uses the API's `total` field as the termination
 * signal.
 */
export async function getAllActivitiesInRange(
  user: string,
  opts: { dateFrom: string; dateTo?: string },
): Promise<Activity[]> {
  const PAGE = 200
  const all: Activity[] = []
  let offset = 0
  while (true) {
    const page = await getActivities(user, { ...opts, limit: PAGE, offset })
    all.push(...page.activities)
    if (all.length >= page.total) break
    offset += PAGE
  }
  return all
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'getAllActivitiesInRange'`
Expected: PASS — all 3 sub-tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/__tests__/TrainingStatusPage.test.tsx
git commit -m "feat(api): add paginated getAllActivitiesInRange helper"
```

---

## Task 2: Bump fetch window to ≥112 days, switch to paginated activities fetch

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx:91-113` (the `useEffect` Promise.all)
- Modify: `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx:164-172` (existing time-range toggle test)
- Modify: `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx:108-110` (default `getActivities` mock)

- [ ] **Step 1: Update existing test assertions to match new clamp value**

In `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx`, find the test `'refetches training-load on time-range toggle'` (line 164). Replace the `56` literal with `112`:

```tsx
  it('refetches training-load on time-range toggle', async () => {
    renderPage()
    // Initial window is 30d, but the 16-week heatmap needs ≥ 112 days, so
    // the fetch is clamped to max(window, 112).
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 112))

    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    // 90 < 112 so it stays clamped at 112.
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 112))
  })
```

(Note: the toggle test's expected behavior changes — toggling to 90d no longer triggers a new fetch value because 90 < 112. We assert it still gets called with 112 to be explicit. If we wanted toggle differentiation we'd need a `>112` option, which the UI doesn't have. Keep the existing assertion shape: it confirms the clamp logic.)

- [ ] **Step 2: Update default `getActivities` mock to match new call pattern**

Still in the test file. The default `beforeEach` mock returns `{ total: 0, offset: 0, limit: 200, activities: [] }`. Since the page will now call `getAllActivitiesInRange` (which internally calls `getActivities` once when `total === 0`), this mock continues to work — `getAllActivitiesInRange(...)` will see `total: 0` and return `[]` after one call. **No change needed for the default mock**, but verify by re-running existing tests at the end of Step 5.

- [ ] **Step 3: Run tests to verify failure**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'refetches training-load'`
Expected: FAIL — current code clamps to 56, test now expects 112.

- [ ] **Step 4: Update `TrainingStatusPage.tsx` `useEffect` Promise.all**

Open `frontend/src/pages/TrainingStatusPage.tsx`. In the `useEffect` body (~line 86), find:

```ts
    // The 8-week trend chart needs ≥ 56 days to fill all buckets, regardless
    // of the user's chosen daily-chart window. Fetch the larger of the two.
    const loadFetchDays = Math.max(days, 56)
    // Fetch activities for the same window so the daily-dose tooltip can show
    // the per-day training summary (distance / pace / HR).
    const today = new Date()
    const from = new Date(today.getTime() - loadFetchDays * 86400000)
    const dateFrom = from.toISOString().slice(0, 10)
    Promise.all([
      getHealth(user, 90),
      getHrv(user, 90),
      getStrideZones(user),
      getStrideTrainingLoad(user, loadFetchDays),
      getActivities(user, { dateFrom, limit: 200 }),
    ])
      .then(([h, hv, z, ld, acts]) => {
        if (cancelled) return
        setHealth({ health: h.health, rhr_baseline: h.rhr_baseline, hrv_snapshot: h.hrv ?? null })
        setHrv({ hrv: hv.hrv })
        setZones(z)
        setLoad(ld)
        setActivities(acts.activities)
      })
```

Replace with:

```ts
    // The 16-week activity heatmap needs 112 days; the 8-week trend chart
    // needs ≥ 56. Fetch the larger of {window, 112}.
    const loadFetchDays = Math.max(days, 112)
    // Fetch activities for the same window so the daily-dose tooltip can show
    // the per-day training summary (distance / pace / HR). Pages through the
    // 200-cap server limit transparently.
    const today = new Date()
    const from = new Date(today.getTime() - loadFetchDays * 86400000)
    const dateFrom = from.toISOString().slice(0, 10)
    Promise.all([
      getHealth(user, 90),
      getHrv(user, 90),
      getStrideZones(user),
      getStrideTrainingLoad(user, loadFetchDays),
      getAllActivitiesInRange(user, { dateFrom }),
    ])
      .then(([h, hv, z, ld, acts]) => {
        if (cancelled) return
        setHealth({ health: h.health, rhr_baseline: h.rhr_baseline, hrv_snapshot: h.hrv ?? null })
        setHrv({ hrv: hv.hrv })
        setZones(z)
        setLoad(ld)
        setActivities(acts)
      })
```

Then update the import at the top of the same file (~line 7-11):

```ts
import {
  getAllActivitiesInRange, getHealth, getHrv, getStrideZones, getStrideTrainingLoad,
  type Activity, type HealthRecord, type HRVSnapshot, type HrvDailyRecord,
  type StrideZonesResponse, type StrideTrainingLoadResponse,
} from '../api'
```

(Remove `getActivities` from the import — it's no longer called directly. Keep all the types.)

- [ ] **Step 5: Run all TrainingStatusPage tests**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx`
Expected: ALL PASS — the 4 existing TrainingStatusPage tests + the 3 new `getAllActivitiesInRange` tests from Task 1.

If `'renders all sections on happy path'` fails because of an import/type error, the most likely culprit is leaving `getActivities` in the import list when nothing uses it; TypeScript treats that as unused. Remove it.

- [ ] **Step 6: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (or only errors unrelated to this file).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/TrainingStatusPage.tsx frontend/src/pages/__tests__/TrainingStatusPage.test.tsx
git commit -m "refactor(training-status): clamp fetch window to 112d + paginate activities"
```

---

## Task 3: Add `heatmapBucket` function + `HEATMAP_COLORS` palette

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx` (add constants near existing `formColor` ~ line 22-29)
- Modify: `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` (add bucket tests)

These are pure, testable functions — get them in first so the component test can rely on them.

- [ ] **Step 1: Write the failing tests**

To enable importing the bucket function from a test, **first** make it a named export. Append the following test block at the end of `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx`:

```tsx
import { heatmapBucket } from '../TrainingStatusPage'

describe('heatmapBucket', () => {
  it('returns 0 for null / 0 / negative', () => {
    expect(heatmapBucket(null)).toBe(0)
    expect(heatmapBucket(0)).toBe(0)
    expect(heatmapBucket(-5)).toBe(0)
  })
  it('returns 1 for 1..40', () => {
    expect(heatmapBucket(1)).toBe(1)
    expect(heatmapBucket(40)).toBe(1)
  })
  it('returns 2 for 41..80', () => {
    expect(heatmapBucket(41)).toBe(2)
    expect(heatmapBucket(80)).toBe(2)
  })
  it('returns 3 for 81..120', () => {
    expect(heatmapBucket(81)).toBe(3)
    expect(heatmapBucket(120)).toBe(3)
  })
  it('returns 4 for >120', () => {
    expect(heatmapBucket(121)).toBe(4)
    expect(heatmapBucket(500)).toBe(4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'heatmapBucket'`
Expected: FAIL — `heatmapBucket` is not exported / not defined.

- [ ] **Step 3: Add `heatmapBucket` and `HEATMAP_COLORS` to `TrainingStatusPage.tsx`**

Open `frontend/src/pages/TrainingStatusPage.tsx`. Just below the existing `readinessGateLabel` function (~ line 60), and **before** the `AXIS_TICK` block (~ line 61), insert:

```ts
// 16-week activity heatmap (Task: 16-week heatmap). Bucket fixed thresholds
// (dose-based): empty / light / mid / dark / deepest. Thresholds tuned to
// the project's typical training-dose ranges — Z2 8km ≈ 35-45, Z4 interval
// ≈ 60-90, marathon race ≥ 120.
export function heatmapBucket(dose: number | null): 0 | 1 | 2 | 3 | 4 {
  if (dose == null || dose <= 0) return 0
  if (dose <= 40) return 1
  if (dose <= 80) return 2
  if (dose <= 120) return 3
  return 4
}

// Orange gradient matching the existing Dose color (#e68a00) family —
// Tailwind orange-200/300/400/700 give 4 visually distinct active levels
// plus a neutral slate-100 for empty days.
export const HEATMAP_COLORS = [
  '#f0f1f4',  // 0 = empty / rest
  '#fed7aa',  // 1 = light  (1–40)
  '#fdba74',  // 2 = mid    (41–80)
  '#fb923c',  // 3 = dark   (81–120)
  '#c2410c',  // 4 = deepest (>120)
] as const
```

Both are exported so tests can import them.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'heatmapBucket'`
Expected: PASS — all 5 sub-tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TrainingStatusPage.tsx frontend/src/pages/__tests__/TrainingStatusPage.test.tsx
git commit -m "feat(training-status): add heatmapBucket + color palette"
```

---

## Task 4: Build `ActivityHeatmap` component (data layer, no UI yet)

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx` (add component below `DailyDoseTooltip`)
- Modify: `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` (add render test)

We build the component in two passes. This task wires up data + structural SVG. Task 5 adds tooltip + integration into the page.

- [ ] **Step 1: Write the failing render test**

Append to `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx`:

```tsx
import { ActivityHeatmap } from '../TrainingStatusPage'

describe('ActivityHeatmap', () => {
  // Stable today for deterministic rendering. The page itself uses
  // shanghaiToday(), so we mock the system clock to a known Shanghai
  // Wednesday (2026-05-27). Container's week-Monday = 2026-05-25,
  // so cell column 15 spans 2026-05-25 .. 2026-05-31; today is column 15
  // row 2 (Wed), and 2026-05-28 .. 2026-05-31 are future.
  beforeEach(() => {
    vi.useFakeTimers()
    // 2026-05-27T08:00:00+08:00 = 2026-05-27T00:00:00Z (Shanghai Wed)
    vi.setSystemTime(new Date('2026-05-27T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders 112 cell rects across 16 weeks × 7 days', () => {
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={[]}
        activitiesByDate={new Map()}
      />,
    )
    // Each <rect> with class 'heatmap-cell' is one day cell.
    const cells = container.querySelectorAll('rect.heatmap-cell')
    expect(cells.length).toBe(112)
  })

  it('colors cells by dose bucket', () => {
    const series: any[] = [
      { date: '2026-05-20', training_dose: 0,   algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-21', training_dose: 30,  algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-22', training_dose: 60,  algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-23', training_dose: 100, algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-24', training_dose: 150, algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
    ]
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={series}
        activitiesByDate={new Map()}
      />,
    )
    // Pull cells indexed by data-date attribute.
    const cellAt = (date: string) =>
      container.querySelector(`rect.heatmap-cell[data-date="${date}"]`)
    expect(cellAt('2026-05-20')?.getAttribute('fill')).toBe('#f0f1f4')  // bucket 0
    expect(cellAt('2026-05-21')?.getAttribute('fill')).toBe('#fed7aa')  // bucket 1
    expect(cellAt('2026-05-22')?.getAttribute('fill')).toBe('#fdba74')  // bucket 2
    expect(cellAt('2026-05-23')?.getAttribute('fill')).toBe('#fb923c')  // bucket 3
    expect(cellAt('2026-05-24')?.getAttribute('fill')).toBe('#c2410c')  // bucket 4
  })

  it('marks future days with dashed stroke and transparent fill', () => {
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={[]}
        activitiesByDate={new Map()}
      />,
    )
    // 2026-05-28 is Thursday, the day after the fake "today" (2026-05-27 Wed).
    const future = container.querySelector('rect.heatmap-cell[data-date="2026-05-28"]')
    expect(future).not.toBeNull()
    expect(future?.getAttribute('fill')).toBe('transparent')
    expect(future?.getAttribute('stroke-dasharray')).toBe('2 2')
  })

  it('marks today with a dark stroke', () => {
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={[]}
        activitiesByDate={new Map()}
      />,
    )
    const today = container.querySelector('rect.heatmap-cell[data-date="2026-05-27"]')
    expect(today).not.toBeNull()
    expect(today?.getAttribute('stroke')).toBe('#1a1c2e')
  })
})
```

Also add `afterEach` to the test file's imports (it's likely already imported alongside `beforeEach` from vitest):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'ActivityHeatmap'`
Expected: FAIL — `ActivityHeatmap is not defined / not exported`.

- [ ] **Step 3: Implement `ActivityHeatmap` component**

Open `frontend/src/pages/TrainingStatusPage.tsx`. Find the existing `DailyDoseTooltip` function (~ line 562). **After** the closing `}` of that function and **before** the `function TrainingLoadSection(` declaration, insert the entire component:

```tsx
// === 16-week training activity heatmap ===
//
// GitHub-style contribution graph: 16 columns × 7 rows. Each cell = one
// Shanghai-local day. Color from STRIDE training_dose; future days render
// as dashed outlines. Tooltip body reuses DailyDoseTooltip (mounted at the
// cursor via position:fixed, since this isn't a Recharts chart).

const HEATMAP_CELL = 18
const HEATMAP_GAP = 3
const HEATMAP_DAY_LABEL_W = 28
const HEATMAP_MONTH_LABEL_H = 12
const HEATMAP_STEP = HEATMAP_CELL + HEATMAP_GAP  // 21

function addDays(isoDate: string, days: number): string {
  // isoDate is YYYY-MM-DD (Shanghai-local day). Build the next instant by
  // anchoring at Shanghai midnight (UTC-08 of the same wall date) and adding
  // `days * 86400000` ms. Result is still YYYY-MM-DD via shanghaiDate().
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return ''
  const utcAnchor = Date.UTC(+m[1], +m[2] - 1, +m[3]) - 8 * 3600 * 1000
  return shanghaiDate(new Date(utcAnchor + days * 86400000).toISOString())
}

type HeatmapCell = {
  date: string
  weekIdx: number  // 0..weeks-1
  dayIdx: number   // 0=Mon .. 6=Sun
  dose: number | null
  isFuture: boolean
  isToday: boolean
}

export function ActivityHeatmap({
  weeks,
  series,
  activitiesByDate,
}: {
  weeks: number
  series: StrideTrainingLoadResponse['series']
  activitiesByDate: Map<string, Activity[]>
}) {
  const [hovered, setHovered] = useState<{ date: string; x: number; y: number } | null>(null)

  const cells: HeatmapCell[] = useMemo(() => {
    const todayCN = shanghaiToday()
    const thisMonday = shanghaiWeekStart(todayCN)
    const firstMonday = addDays(thisMonday, -(weeks - 1) * 7)
    const seriesByDate = new Map(series.map((r) => [r.date, r]))
    const out: HeatmapCell[] = []
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const date = addDays(firstMonday, w * 7 + d)
        out.push({
          date,
          weekIdx: w,
          dayIdx: d,
          dose: seriesByDate.get(date)?.training_dose ?? null,
          isFuture: date > todayCN,
          isToday: date === todayCN,
        })
      }
    }
    return out
  }, [weeks, series])

  const seriesByDate = useMemo(() => new Map(series.map((r) => [r.date, r])), [series])

  // Build month-label markers: for each column whose Monday's month differs
  // from the previous column's Monday's month, label that column with the
  // month number.
  const monthLabels: Array<{ weekIdx: number; label: string }> = []
  let lastMonth = ''
  for (let w = 0; w < weeks; w++) {
    const monday = cells[w * 7].date  // every column's first cell is Mon
    const month = monday.slice(5, 7)
    if (month !== lastMonth) {
      monthLabels.push({ weekIdx: w, label: `${parseInt(month, 10)}月` })
      lastMonth = month
    }
  }

  const svgW = HEATMAP_DAY_LABEL_W + weeks * HEATMAP_STEP
  const svgH = HEATMAP_MONTH_LABEL_H + 7 * HEATMAP_STEP

  return (
    <div>
      <p className="text-[11px] font-mono text-text-muted mb-2 ml-1">
        16 周训练热力图 · 16-Week Activity Heatmap
      </p>
      <div style={{ height: 180 }}>
        <svg
          width="100%"
          viewBox={`0 0 ${svgW} ${svgH}`}
          preserveAspectRatio="xMinYMid meet"
          style={{ maxHeight: '100%' }}
        >
          {/* Month labels */}
          {monthLabels.map(({ weekIdx, label }) => (
            <text
              key={`m-${weekIdx}`}
              x={HEATMAP_DAY_LABEL_W + weekIdx * HEATMAP_STEP}
              y={HEATMAP_MONTH_LABEL_H - 2}
              fontSize={10}
              fontFamily="JetBrains Mono"
              fill="#8888a0"
            >
              {label}
            </text>
          ))}
          {/* Day-of-week labels: Mon (row 0), Wed (row 2), Fri (row 4) */}
          {[
            { y: 0, label: '周一' },
            { y: 2, label: '周三' },
            { y: 4, label: '周五' },
          ].map(({ y, label }) => (
            <text
              key={`d-${y}`}
              x={0}
              y={HEATMAP_MONTH_LABEL_H + y * HEATMAP_STEP + HEATMAP_CELL - 4}
              fontSize={10}
              fontFamily="JetBrains Mono"
              fill="#8888a0"
            >
              {label}
            </text>
          ))}
          {/* Cells */}
          {cells.map((c) => {
            const x = HEATMAP_DAY_LABEL_W + c.weekIdx * HEATMAP_STEP
            const y = HEATMAP_MONTH_LABEL_H + c.dayIdx * HEATMAP_STEP
            const bucket = heatmapBucket(c.dose)
            const fill = c.isFuture ? 'transparent' : HEATMAP_COLORS[bucket]
            const stroke = c.isFuture ? '#e8eaf0' : c.isToday ? '#1a1c2e' : 'none'
            const strokeDash = c.isFuture ? '2 2' : undefined
            return (
              <rect
                key={c.date}
                className="heatmap-cell"
                data-date={c.date}
                x={x}
                y={y}
                width={HEATMAP_CELL}
                height={HEATMAP_CELL}
                rx={3}
                fill={fill}
                stroke={stroke}
                strokeWidth={c.isToday ? 1 : c.isFuture ? 1 : 0}
                strokeDasharray={strokeDash}
                onMouseEnter={c.isFuture ? undefined : (e) => {
                  setHovered({ date: c.date, x: e.clientX, y: e.clientY })
                }}
                onMouseMove={c.isFuture ? undefined : (e) => {
                  setHovered({ date: c.date, x: e.clientX, y: e.clientY })
                }}
                onMouseLeave={c.isFuture ? undefined : () => setHovered(null)}
              />
            )
          })}
        </svg>
        {/* Legend */}
        <div className="flex items-center justify-end gap-1.5 mt-2 text-[10px] font-mono text-text-muted">
          <span>少</span>
          {HEATMAP_COLORS.map((color, i) => (
            <span
              key={i}
              className="inline-block w-3 h-3 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
          <span>多</span>
          <span className="ml-2">0 · 40 · 80 · 120</span>
        </div>
      </div>
      {/* Tooltip: position:fixed, pointer-events:none */}
      {hovered && (
        <div
          style={{
            position: 'fixed',
            left: hovered.x + 12,
            top: hovered.y + 12,
            zIndex: 50,
            pointerEvents: 'none',
          }}
        >
          <DailyDoseTooltip
            active={true}
            payload={[{
              payload: {
                date: hovered.date,
                training_dose: seriesByDate.get(hovered.date)?.training_dose ?? null,
              },
            }]}
            activitiesByDate={activitiesByDate}
          />
        </div>
      )}
    </div>
  )
}
```

Also need to import `shanghaiToday` and `shanghaiWeekStart` (and ensure `shanghaiDate` is already there — it is). Update the import at line 14:

```ts
import { shanghaiDate, shanghaiToday, shanghaiWeekStart, shanghaiWeekday } from '../lib/shanghai'
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t 'ActivityHeatmap'`
Expected: PASS — all 4 ActivityHeatmap sub-tests green.

If `'renders 112 cell rects'` fails with `< 112`, the most likely cause is `addDays` returning `''` for the boundary case (e.g., from a malformed YMD coming out of `shanghaiToday()` at a JS engine that doesn't support Intl.DateTimeFormat `en-CA`). Check by `console.log(addDays('2026-05-25', 7))` — should be `'2026-06-01'`.

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TrainingStatusPage.tsx frontend/src/pages/__tests__/TrainingStatusPage.test.tsx
git commit -m "feat(training-status): add ActivityHeatmap SVG component"
```

---

## Task 5: Wire `ActivityHeatmap` into the page next to the 8-week trend chart

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx:765-795` (the 8-week trend wrapper)
- Modify: `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` (add integration test)

- [ ] **Step 1: Write the failing integration test**

Append to `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` inside the existing `describe('TrainingStatusPage', ...)` block (before the closing `})`):

```tsx
  it('renders the 16-week heatmap alongside the 8-week trend', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    // Heatmap title is present
    expect(screen.getByText('16 周训练热力图 · 16-Week Activity Heatmap')).toBeInTheDocument()
    // Heatmap renders 112 cells regardless of empty dose series
    const cells = container.querySelectorAll('rect.heatmap-cell')
    expect(cells.length).toBe(112)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx -t '16-week heatmap alongside'`
Expected: FAIL — heatmap title not found in the page DOM (component exists but isn't mounted).

- [ ] **Step 3: Wrap the 8-week trend block in a 2-column grid and add `ActivityHeatmap`**

Open `frontend/src/pages/TrainingStatusPage.tsx`. Find the existing 8-week trend chart block (~ line 765-795):

```tsx
              <div className="mt-4">
                <p className="text-[11px] font-mono text-text-muted mb-2 ml-1">8 周负荷趋势 · 8-Week Load Trend (每周 Dose 累加)</p>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={weeklySeries} margin={{ top: 5, right: 10, bottom: 0, left: -5 }}>
                    ...
                  </LineChart>
                </ResponsiveContainer>
              </div>
```

Replace **just the outer `<div className="mt-4">` and its closing `</div>`** so they become a grid wrapper around two cells. The 8-week chart becomes the first column; the new `ActivityHeatmap` becomes the second:

```tsx
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
                <div>
                  <p className="text-[11px] font-mono text-text-muted mb-2 ml-1">8 周负荷趋势 · 8-Week Load Trend (每周 Dose 累加)</p>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={weeklySeries} margin={{ top: 5, right: 10, bottom: 0, left: -5 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="weekLabel" tick={AXIS_TICK} />
                      <YAxis tick={AXIS_TICK} />
                      <Tooltip
                        {...TOOLTIP_STYLE}
                        labelFormatter={(label: unknown, payload) => {
                          const row = payload?.[0]?.payload as { weekStart?: string } | undefined
                          return row?.weekStart ? `周一 ${row.weekStart}` : `${label}`
                        }}
                        formatter={(value: unknown, _name, ctx) => {
                          const row = (ctx as { payload?: { activeDays?: number } } | undefined)?.payload
                          const dose = typeof value === 'number' ? value.toFixed(1) : `${value}`
                          return [`${dose}（${row?.activeDays ?? 0} 天）`, '周剂量']
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="totalDose"
                        name="周剂量"
                        stroke="#e68a00"
                        strokeWidth={2}
                        dot={{ r: 3.5, fill: '#e68a00', stroke: '#fff', strokeWidth: 1.5 }}
                        activeDot={{ r: 5, fill: '#e68a00', stroke: '#fff', strokeWidth: 2 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <ActivityHeatmap
                  weeks={16}
                  series={rawSeries}
                  activitiesByDate={activitiesByDate}
                />
              </div>
```

(Note the LineChart body is reproduced unchanged — only the wrapping `<div>` changes from `mt-4` to nested-in-grid, and `<ActivityHeatmap>` is added as sibling.)

- [ ] **Step 4: Pass `activitiesByDate` into `TrainingLoadSection` so the heatmap can see it**

Look at `TrainingLoadSection` signature (~ line 604) — it already accepts `activitiesByDate`, so this is already wired. Verify by grepping `activitiesByDate` in `TrainingStatusPage.tsx`:

Run: `grep -n activitiesByDate frontend/src/pages/TrainingStatusPage.tsx`

Expected: at least 3 hits — the `useMemo` definition (~ line 126), the prop passed at the JSX site (~ line 161), and the function signature (~ line 607). No new wiring needed.

- [ ] **Step 5: Run all tests**

Run: `cd frontend && npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx`
Expected: ALL PASS — original 4 + new tests from Tasks 1, 3, 4, 5.

- [ ] **Step 6: Type-check + build**

Run: `cd frontend && npx tsc --noEmit && npx vite build`
Expected: clean build, no TS errors, no vite warnings about chunk size beyond the baseline.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/TrainingStatusPage.tsx frontend/src/pages/__tests__/TrainingStatusPage.test.tsx
git commit -m "feat(training-status): place 16-week heatmap beside 8-week trend"
```

---

## Task 6: Browser smoke test + final commit

- [ ] **Step 1: Start dev server**

Run: `cd frontend && npm run dev:local` (or `npm run dev` if local recipe doesn't exist — check `package.json` scripts first).
Expected: dev server boots on `http://localhost:5173` (or similar).

- [ ] **Step 2: Manual smoke**

Open the browser to `/training-status`. Verify visually:

1. The "8 周负荷趋势" line chart and the new "16 周训练热力图" sit side-by-side on a wide window (lg breakpoint).
2. Resizing to narrow (< 1024px) stacks them vertically.
3. The heatmap shows 16 columns × 7 rows.
4. Today's cell has a dark outline.
5. Future days in the current week have dashed outlines.
6. Hovering a non-future cell with training data shows the standard `DailyDoseTooltip` (date, dose, activity rows).
7. Hovering a rest day shows tooltip with "休息日".
8. Hovering a future day shows nothing.

If the heatmap is empty (all grey), confirm `localStorage` has a valid user — without dose data the heatmap correctly shows all empty cells.

- [ ] **Step 3: Snapshot the verification**

Take a screenshot of the side-by-side layout and the tooltip. Save under `frontend/test-results/` if useful for the PR description, or skip if not needed.

- [ ] **Step 4: Final all-tests pass**

Run: `cd frontend && npm test -- --run`
Expected: full test suite green.

- [ ] **Step 5: Final commit (if nothing else changed) or PR-ready state**

Nothing to commit here unless smoke-test surfaced issues. Note: per project CLAUDE.md, do **not** push or open a PR unless the user explicitly asks.

---

## Spec Coverage Self-Review

| Spec section | Plan task |
|---|---|
| §1 background | (no code) |
| §2 data sources / no new endpoint | Task 1, 2 (reuse `getStrideTrainingLoad`, `getActivities` with pagination) |
| §3 layout (grid lg:50/50) | Task 5 |
| §4.1 fetch window 112d | Task 2 |
| §4.2 paginated activities | Task 1, 2 |
| §5 `shanghaiMondayOf` helper | **Skipped — `shanghaiWeekStart` already exists with same semantics** |
| §6.1 `ActivityHeatmap` inline | Task 4 |
| §6.2 data derivation | Task 4 (`cells` useMemo) |
| §6.3 bucket + palette | Task 3 |
| §6.4 SVG render specs | Task 4 |
| §6.5 tooltip reuse | Task 4 (position:fixed wrapper) |
| §6.6 legend | Task 4 (bottom of component) |
| §7 title text | Task 4 |
| §8 edge cases | Task 4 (future + isToday + empty bucket) |
| §9 tests | Tasks 1, 3, 4, 5 |
| §10 implementation order | This plan's task order |
| §11 out-of-scope | Honored — no week-toggle, no click-through, no server endpoint |
