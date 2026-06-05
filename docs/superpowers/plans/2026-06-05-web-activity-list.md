# Web Activity List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Web-only `/activities` page matching `spec/web_design.html`, with desktop layout, mobile-browser responsiveness, filters, pagination, and navigation to existing activity details.

**Architecture:** Add a focused React page backed by existing activity APIs. Keep list shaping in a small pure model module so filtering, grouping, summary, and pagination can be tested without rendering. Wire route, sidebar nav, breadcrumb, and telemetry separately.

**Tech Stack:** React 19, React Router 7, TypeScript, Vite, Tailwind CSS 4 theme tokens, Vitest, Testing Library.

---

## File Structure

- Create `frontend/src/pages/activitiesPageModel.ts`: pure helpers for sport classification, month range, filtering, grouping, summary, and pagination.
- Create `frontend/src/pages/ActivitiesPage.tsx`: page component, API calls, filters, responsive UI, loading/error/empty states.
- Create `frontend/src/pages/__tests__/activitiesPageModel.test.ts`: unit tests for helper behavior.
- Create `frontend/src/pages/__tests__/ActivitiesPage.test.tsx`: page rendering, filters, pagination, and navigation tests.
- Create `frontend/src/__tests__/api.activities.test.ts`: paginated API helper test.
- Modify `frontend/src/api.ts`: add `getAllActivities` and delegate existing `getAllActivitiesInRange` to it.
- Modify `frontend/src/App.tsx`: register `/activities`.
- Modify `frontend/src/components/AppLayout.tsx`: add `活动列表` sidebar item under 主功能.
- Modify `frontend/src/lib/breadcrumb.ts`: add `/activities` breadcrumb.
- Create `frontend/src/lib/__tests__/breadcrumb.test.ts`: breadcrumb coverage for `/activities`.
- Modify `frontend/src/telemetry/routeNames.ts` and `frontend/src/telemetry/__tests__/routeNames.test.ts`: add route telemetry.

Implementation constraints:

- Do not touch `mobile/`.
- Do not modify backend API or DB schema.
- Do not modify `spec/web_design.html`.
- Use `formatDateShort`, `sportNameCN`, `shanghaiDate`, and `shanghaiToday`; do not use browser-local date math for calendar labels.
- Do not send category values `run` or `strength` to the backend `sport` parameter. The backend expects exact `sport_name`; category filtering is frontend-only.

---

### Task 1: Add Paginated Activity API Helper

**Files:**
- Modify: `frontend/src/api.ts`
- Create: `frontend/src/__tests__/api.activities.test.ts`

- [ ] **Step 1: Write the failing API helper test**

Create `frontend/src/__tests__/api.activities.test.ts` with a mocked `globalThis.fetch`. The test must assert that `getAllActivities('user-1', { dateFrom: '2026-05-01', dateTo: '2026-05-31' })` fetches two pages when the first response is `{ total: 250, activities: 200 rows }` and the second response is `{ total: 250, activities: 50 rows }`.

Use this assertion shape:

```typescript
expect(result).toHaveLength(250)
expect(fetchMock).toHaveBeenNthCalledWith(
  1,
  '/api/user-1/activities?date_from=2026-05-01&date_to=2026-05-31&limit=200&offset=0',
  { headers: {} },
)
expect(fetchMock).toHaveBeenNthCalledWith(
  2,
  '/api/user-1/activities?date_from=2026-05-01&date_to=2026-05-31&limit=200&offset=200',
  { headers: {} },
)
```

- [ ] **Step 2: Run test to verify RED**

```bash
cd frontend
npm test -- src/__tests__/api.activities.test.ts
```

Expected: FAIL with `getAllActivities` not exported.

- [ ] **Step 3: Implement `getAllActivities`**

Modify `frontend/src/api.ts` near `getAllActivitiesInRange`:

```typescript
export async function getAllActivities(
  user: string,
  opts: { dateFrom?: string; dateTo?: string } = {},
): Promise<Activity[]> {
  const PAGE = 200
  const all: Activity[] = []
  let offset = 0
  while (true) {
    const page = await getActivities(user, { ...opts, limit: PAGE, offset })
    all.push(...page.activities)
    if (page.activities.length === 0 || all.length >= page.total) break
    offset = all.length
  }
  return all
}

export async function getAllActivitiesInRange(
  user: string,
  opts: { dateFrom: string; dateTo?: string },
): Promise<Activity[]> {
  return getAllActivities(user, opts)
}
```

- [ ] **Step 4: Run test to verify GREEN**

```bash
cd frontend
npm test -- src/__tests__/api.activities.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/__tests__/api.activities.test.ts
git commit -m "test: cover paginated activity fetch helper"
```

---

### Task 2: Add Activity List Model Helpers

**Files:**
- Create: `frontend/src/pages/activitiesPageModel.ts`
- Create: `frontend/src/pages/__tests__/activitiesPageModel.test.ts`

- [ ] **Step 1: Write failing model tests**

Create tests covering these exact behaviors:

```typescript
expect(filterActivities([run10, run5, strength], { sport: 'run', minDistanceKm: 10 })).toEqual([run10])
expect(filterActivities([run10, run5, strength], { sport: 'strength', minDistanceKm: 0 })).toEqual([strength])
expect(groupActivitiesByMonth([may, april])[0]).toMatchObject({ key: '2026-05', label: '2026 年 5 月' })
expect(summarizeActivities([runA, runB, strength])).toEqual({
  totalRunKm: 15,
  runDurationS: 4800,
  avgPaceSecPerKm: 320,
  avgRunHr: 146,
  strengthCount: 1,
  strengthDurationS: 2100,
})
expect(paginateActivities(Array.from({ length: 13 }, makeActivity), 2).items).toHaveLength(1)
expect(monthRangeFromShanghaiToday('2026-05-08')).toEqual({ label: '2026 年 5 月', dateFrom: '2026-05-01', dateTo: '2026-05-31' })
```

Use a local `makeActivity(overrides: Partial<Activity>): Activity` fixture with all required `Activity` fields populated.

- [ ] **Step 2: Run tests to verify RED**

```bash
cd frontend
npm test -- src/pages/__tests__/activitiesPageModel.test.ts
```

Expected: FAIL because `activitiesPageModel.ts` does not exist.

- [ ] **Step 3: Implement model helpers**

Create `frontend/src/pages/activitiesPageModel.ts` with these exports:

```typescript
export const ACTIVITY_PAGE_SIZE = 12
export type ActivitySportFilter = 'all' | 'run' | 'strength'
export interface ActivityFilters { sport: ActivitySportFilter; minDistanceKm: number }
export function isRunActivity(activity: Activity): boolean
export function isStrengthActivity(activity: Activity): boolean
export function activityIconLabel(activity: Activity): '跑' | '力' | '动'
export function filterActivities(activities: Activity[], filters: ActivityFilters): Activity[]
export function summarizeActivities(activities: Activity[]): ActivitySummary
export function groupActivitiesByMonth(activities: Activity[]): ActivityMonthGroup[]
export function paginateActivities(activities: Activity[], requestedPage: number): { page: number; totalPages: number; start: number; items: Activity[] }
export function monthRangeFromShanghaiToday(today: string): { label: string; dateFrom: string; dateTo: string }
export function formatHoursMinutes(seconds: number): string
export function formatPaceSeconds(seconds: number | null): string
```

Implementation rules:

- `isRunActivity`: match `/run|treadmill|trail|track/i` on `sport_name`.
- `isStrengthActivity`: return true for `sport_type` in `[402, 800]` or `/strength/i` on `sport_name`.
- `summarizeActivities`: average run HR weighted by `duration_s`, ignoring null HR.
- `groupActivitiesByMonth`: group by `shanghaiDate(activity.date).slice(0, 7)`, preserving input order.
- `monthRangeFromShanghaiToday`: compute month end with `new Date(Date.UTC(year, month, 0)).getUTCDate()`.

- [ ] **Step 4: Run tests to verify GREEN**

```bash
cd frontend
npm test -- src/pages/__tests__/activitiesPageModel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/activitiesPageModel.ts frontend/src/pages/__tests__/activitiesPageModel.test.ts
git commit -m "test: cover activity list model helpers"
```

---

### Task 3: Build the Activities Page

**Files:**
- Create: `frontend/src/pages/ActivitiesPage.tsx`
- Create: `frontend/src/pages/__tests__/ActivitiesPage.test.tsx`

- [ ] **Step 1: Write failing page tests**

Create `frontend/src/pages/__tests__/ActivitiesPage.test.tsx` with mocked `getAllActivities`, `shanghaiToday`, `formatDateShort`, and `sportNameCN`.

The test suite must cover:

```typescript
expect(await screen.findByRole('heading', { name: '活动列表' })).toBeInTheDocument()
expect(screen.getByText('活动记录 · 全部')).toBeInTheDocument()
expect(screen.getByText('本月统计 · 2026 年 5 月')).toBeInTheDocument()
expect(screen.getByText('类型 · 全部')).toBeInTheDocument()
expect(screen.getByText('距离 · 全部')).toBeInTheDocument()
expect(screen.getByText('2026 年 5 月')).toBeInTheDocument()
expect(screen.getByText('2026 年 4 月')).toBeInTheDocument()
```

Filtering assertions:

```typescript
fireEvent.change(screen.getByLabelText('活动类型'), { target: { value: 'strength' } })
expect(screen.getByText('Strength A')).toBeInTheDocument()
expect(screen.queryByText('Morning Run 10K')).not.toBeInTheDocument()

fireEvent.change(screen.getByLabelText('活动类型'), { target: { value: 'run' } })
fireEvent.change(screen.getByLabelText('距离下限'), { target: { value: '10' } })
expect(screen.getByText('Morning Run 10K')).toBeInTheDocument()
expect(screen.queryByText('Easy Run 5K')).not.toBeInTheDocument()
expect(getAllActivities).not.toHaveBeenCalledWith('user-1', expect.objectContaining({ sport: 'run' }))
```

Date range assertion:

```typescript
fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-04-01' } })
fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-04-30' } })
fireEvent.click(screen.getByRole('button', { name: '应用' }))
await waitFor(() => expect(getAllActivities).toHaveBeenCalledWith('user-1', {
  dateFrom: '2026-04-01',
  dateTo: '2026-04-30',
}))
```

Pagination and navigation assertion:

```typescript
expect(await screen.findByText('Run 0')).toBeInTheDocument()
expect(screen.queryByText('Run 12')).not.toBeInTheDocument()
fireEvent.click(screen.getByRole('button', { name: '下一页' }))
expect(screen.getByText('Run 12')).toBeInTheDocument()
fireEvent.click(screen.getByText('Run 12'))
expect(screen.getByText('Activity detail route')).toBeInTheDocument()
```

Empty state assertion:

```typescript
fireEvent.change(screen.getByLabelText('距离下限'), { target: { value: '40' } })
expect(screen.getByText('该范围暂无活动记录。')).toBeInTheDocument()
```

- [ ] **Step 2: Run page tests to verify RED**

```bash
cd frontend
npm test -- src/pages/__tests__/ActivitiesPage.test.tsx
```

Expected: FAIL because `ActivitiesPage.tsx` does not exist.

- [ ] **Step 3: Implement `ActivitiesPage.tsx`**

Create `frontend/src/pages/ActivitiesPage.tsx` with this component structure:

```typescript
export default function ActivitiesPage() {
  const { user } = useUser()
  const [activities, setActivities] = useState<Activity[]>([])
  const [monthActivities, setMonthActivities] = useState<Activity[]>([])
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [sportFilter, setSportFilter] = useState<ActivitySportFilter>('all')
  const [minDistanceKm, setMinDistanceKm] = useState(0)
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [appliedRange, setAppliedRange] = useState<{ dateFrom?: string; dateTo?: string }>({})
  const [page, setPage] = useState(1)
}
```

Data fetching rules:

- Compute `monthRange = monthRangeFromShanghaiToday(shanghaiToday())` once with `useMemo`.
- Fetch `getAllActivities(user, appliedRange)` and `getAllActivities(user, { dateFrom: monthRange.dateFrom, dateTo: monthRange.dateTo })` in `Promise.all` to avoid waterfalls.
- Refetch when `appliedRange` or `user` changes.
- Reset `page` to 1 when `sportFilter`, `minDistanceKm`, or `appliedRange` changes.

Render rules:

- Use `ViewHead` with the exact design text from the spec.
- Monthly summary uses `grid grid-cols-2 lg:grid-cols-6`.
- Filter controls use accessible labels: `活动类型`, `距离下限`, `开始日期`, `结束日期`.
- Activity rows use `Link to={`/activity/${activity.label_id}`}`.
- Desktop row layout: `lg:grid-cols-[32px_1fr_repeat(5,80px)_auto]`.
- Mobile row layout: `grid-cols-[32px_1fr_auto]`, key metrics below title, no horizontal overflow.
- Pager buttons use visible names `上一页` and `下一页`.

Use helper functions from `activitiesPageModel.ts`; do not reimplement filtering or summary logic in the component.

- [ ] **Step 4: Run page tests to verify GREEN**

```bash
cd frontend
npm test -- src/pages/__tests__/ActivitiesPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ActivitiesPage.tsx frontend/src/pages/__tests__/ActivitiesPage.test.tsx
git commit -m "feat: add web activity list page"
```

---

### Task 4: Wire Route, Sidebar, Breadcrumb, and Telemetry

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppLayout.tsx`
- Modify: `frontend/src/lib/breadcrumb.ts`
- Create: `frontend/src/lib/__tests__/breadcrumb.test.ts`
- Modify: `frontend/src/telemetry/routeNames.ts`
- Modify: `frontend/src/telemetry/__tests__/routeNames.test.ts`

- [ ] **Step 1: Write failing route metadata tests**

Create `frontend/src/lib/__tests__/breadcrumb.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { resolveBreadcrumb } from '../breadcrumb'

describe('resolveBreadcrumb', () => {
  it('maps activity list route', () => {
    expect(resolveBreadcrumb('/activities')).toEqual({ section: '训练', current: '活动列表' })
  })
})
```

Modify `frontend/src/telemetry/__tests__/routeNames.test.ts` table to include:

```typescript
['/activities', 'Activity List'],
```

- [ ] **Step 2: Run route metadata tests to verify RED**

```bash
cd frontend
npm test -- src/lib/__tests__/breadcrumb.test.ts src/telemetry/__tests__/routeNames.test.ts
```

Expected: FAIL because `/activities` is not mapped.

- [ ] **Step 3: Add breadcrumb and telemetry mappings**

Modify `frontend/src/lib/breadcrumb.ts` after `/plan`:

```typescript
if (pathname === '/activities') {
  return { section: '训练', current: '活动列表' }
}
```

Modify `frontend/src/telemetry/routeNames.ts` so `RULES` includes:

```typescript
['/activities', 'Activity List'],
```

- [ ] **Step 4: Register route and sidebar nav**

Modify `frontend/src/App.tsx`:

```typescript
import ActivitiesPage from './pages/ActivitiesPage'
```

Add route inside protected `AppLayout`:

```tsx
<Route path="/activities" element={<ActivitiesPage />} />
```

Modify `frontend/src/components/AppLayout.tsx` under 主功能:

```tsx
<NavItem to="/activities" collapsed={collapsed} icon={<ActivityIcon />} text="活动列表" />
```

Add icon function:

```tsx
function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}
```

- [ ] **Step 5: Run route and page tests to verify GREEN**

```bash
cd frontend
npm test -- src/lib/__tests__/breadcrumb.test.ts src/telemetry/__tests__/routeNames.test.ts src/pages/__tests__/ActivitiesPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/AppLayout.tsx frontend/src/lib/breadcrumb.ts frontend/src/lib/__tests__/breadcrumb.test.ts frontend/src/telemetry/routeNames.ts frontend/src/telemetry/__tests__/routeNames.test.ts
git commit -m "feat: wire activity list route"
```

---

### Task 5: Verify Build and Browser Responsiveness

**Files:**
- Modify only files touched in Tasks 1-4 if verification exposes a defect.

- [ ] **Step 1: Run targeted tests**

```bash
cd frontend
npm test -- src/__tests__/api.activities.test.ts src/pages/__tests__/activitiesPageModel.test.ts src/pages/__tests__/ActivitiesPage.test.tsx src/lib/__tests__/breadcrumb.test.ts src/telemetry/__tests__/routeNames.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full frontend tests**

```bash
cd frontend
npm test
```

Expected: PASS.

- [ ] **Step 3: Run production build**

```bash
cd frontend
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Start dev server**

```bash
cd frontend
npm run dev -- --host 127.0.0.1
```

Expected: Vite prints a local URL such as `http://127.0.0.1:5173/`.

- [ ] **Step 5: Browser-check desktop and mobile widths**

Desktop at 1440 px:

- Sidebar shows and highlights `活动列表`.
- `/activities` shows header, six-column summary, filters, grouped list, pager.
- Clicking an activity row navigates to `/activity/:id`.

Mobile-browser at 390 px:

- Existing hamburger menu controls sidebar.
- Summary grid is two columns.
- Filter controls fit without horizontal scroll.
- Activity rows render as compact cards with key metrics.
- Pager wraps without horizontal overflow.

- [ ] **Step 6: Commit verification fixes if any**

If Step 5 required changes:

```bash
git add frontend/src/pages/ActivitiesPage.tsx frontend/src/pages/activitiesPageModel.ts frontend/src/pages/__tests__/ActivitiesPage.test.tsx frontend/src/pages/__tests__/activitiesPageModel.test.ts
git commit -m "fix: polish activity list responsive layout"
```

If no changes were needed, do not create this commit.

---

## Final Verification

Run before declaring complete:

```bash
cd frontend
npm test
npm run build
```

Expected:

- All Vitest tests pass.
- TypeScript build passes.
- `/activities` is reachable through the sidebar.
- `/activities` works at desktop and mobile-browser widths.

---

## Self-Review Notes

- Spec coverage: route, sidebar, page structure, monthly stats, filters, grouping, pagination, empty state, activity detail navigation, and mobile-browser responsiveness are covered by Tasks 1-5.
- Scope: no task touches `mobile/`, backend routes, DB schema, or `spec/web_design.html`.
- Type consistency: page tests and implementation use `Activity`, `getAllActivities`, `ActivitySportFilter`, and helper names defined in earlier tasks.
