# 16 周训练热力图（Activity Heatmap）— Design Spec

**Date**: 2026-05-27
**Status**: Approved, ready for implementation planning
**Scope**: 在 `/training-status` 页面 `TrainingLoadSection` 内、"8 周负荷趋势" 线图右侧并排新增一个 GitHub 风格的 16 周训练热力图。仅前端改动 + 1 个 timezone helper；不新增 API、不改 DB。

---

## 1. 背景与动机

`/training-status` 页面已经覆盖了：每日 Dose 柱图（短窗口）+ 急性 / 慢性曲线 + Form 柱图 + 8 周周累加 Dose 趋势线。这些图都聚焦"最近 8~90 天"。

用户希望补一张**长窗口 + 高密度**的视觉：GitHub contribution-graph 样式，16 周 × 7 天 = 112 个 cell，一眼看出"哪一周训练得密、哪一周空"以及"一周内的训练日分布"。位置在 "8 周负荷趋势" 右边，因为两者语义相近（都是周维度长期视角）且色相同源（橙色 Dose）。

---

## 2. 数据来源约束

**全部复用已有 API、不新增 endpoint**：

| 数据 | 来源 | 现状 |
|---|---|---|
| 每日 dose 序列 | `getStrideTrainingLoad(user, loadFetchDays).series` | 已存在；只需把 `loadFetchDays` 从 `Math.max(days, 56)` 扩到 `Math.max(days, 112)` |
| 每日活动列表（tooltip 用） | `getActivities(user, { dateFrom })` | 已存在；改成翻页拉全 |

server-side `/api/{user}/activities` 的 `limit` 参数 cap 在 200（`src/stride_server/routes/activities.py:69` — `Query(50, ge=1, le=200)`）。当前调用传 `limit: 200` 单页可能不够 112 天窗口的全部活动（极端高频用户场景）。改为**前端翻页**直到 `accumulated.length >= total`。

时区：cell 行 / 列对齐用 Asia/Shanghai 周一作为周起点（与 `weekly_plan` 周边界一致）。所有日期比较经 `frontend/src/lib/shanghai.ts` helper。

---

## 3. 页面布局变化

**改动前**（`TrainingStatusPage.tsx:765-795`）：

```
TrainingLoadSection
├─ stats grid（6 cells）
├─ readiness gate banner
├─ 每日 Dose 柱图（full-width）
├─ 慢性 vs 急性区域 + 线图（full-width）
├─ Form 柱图 + legend（full-width）
└─ 8 周负荷趋势线图（full-width）
```

**改动后**：

```
TrainingLoadSection
├─ stats grid（6 cells）              [unchanged]
├─ readiness gate banner              [unchanged]
├─ 每日 Dose 柱图（full-width）        [unchanged]
├─ 慢性 vs 急性区域 + 线图（full-width）[unchanged]
├─ Form 柱图 + legend（full-width）    [unchanged]
└─ ┌─────────────────────────────────────────────────┐
   │  ┌────────────────────┐  ┌────────────────────┐ │
   │  │ 8 周负荷趋势线图    │  │ 16 周训练热力图     │ │
   │  │ (lg:50%)           │  │ (lg:50%)           │ │
   │  └────────────────────┘  └────────────────────┘ │
   │   小屏：上下堆叠                                  │
   └─────────────────────────────────────────────────┘
```

二列 grid 使用 `grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4`，与 page-level `MetricsRow / TrendsRow / ZonesRow` 同一断点策略。

---

## 4. 数据 fetch 策略

### 4.1 扩窗口

```diff
-     const loadFetchDays = Math.max(days, 56)
+     const loadFetchDays = Math.max(days, 112)
```

`getStrideTrainingLoad(user, loadFetchDays)` 已经支持任意天数；server 层无需改动。

### 4.2 翻页拉全 activities

`frontend/src/api.ts` 紧挨 `getActivities` 加：

```ts
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

`TrainingStatusPage.tsx` 内 `Promise.all([...])` 第 5 项替换：

```diff
-     getActivities(user, { dateFrom, limit: 200 }),
+     getAllActivitiesInRange(user, { dateFrom }),
```

返回 shape 变化：从 `{ activities, total, offset, limit }` 变成 `Activity[]`。`.then` 解构里 `setActivities(acts.activities)` → `setActivities(acts)`。

**为什么不抬 server cap**：200 是合理的单页防爆上限，不该为某一个 use case 妥协。
**为什么不新增 dose-summary endpoint**：tooltip 完全复用现有 `DailyDoseTooltip` + `activitiesByDate`，前端只需要完整 `Activity[]`，不需要新 shape。

---

## 5. 时区 helper 扩展

`frontend/src/lib/shanghai.ts` 新增：

```ts
// Monday of the Shanghai-local week containing the given ISO date.
// shanghaiMondayOf('2026-05-27') === '2026-05-25'  (Wed → preceding Mon)
// shanghaiMondayOf('2026-05-25') === '2026-05-25'  (Mon → itself)
// shanghaiMondayOf('2026-05-31') === '2026-05-25'  (Sun → preceding Mon)
export function shanghaiMondayOf(isoDate: string): string
```

实现：先把 isoDate 解析为 Shanghai-local Date，求 `getDay()` 中 Mon=1..Sun=0（map Sun=7），减去 `(dayIdx - 1)` 天即可。

---

## 6. ActivityHeatmap 组件

### 6.1 形态

**Inline 在 `TrainingStatusPage.tsx`**，不抽单独文件 — 与 `ChartCard / MetricsRow / TrendsRow / LoadStat / DailyDoseTooltip` 同级。

```tsx
function ActivityHeatmap({
  weeks,
  series,
  activitiesByDate,
}: {
  weeks: number  // 固定传 16
  series: StrideTrainingLoadResponse['series']
  activitiesByDate: Map<string, Activity[]>
}): JSX.Element
```

### 6.2 数据派生

```
1. todayCN     = shanghaiToday()                         // e.g. '2026-05-27'
2. thisMonday  = shanghaiMondayOf(todayCN)               // '2026-05-25'
3. firstMonday = thisMonday - 15 weeks                    // '2026-02-09'
4. seriesByDate: Map<string, RawSeriesRow> 从 series 构造
5. 生成 16 × 7 = 112 cells: { date, weekIdx, dayIdx, dose, isFuture, isToday }
   - date     = firstMonday + (weekIdx * 7 + dayIdx) days
   - dose     = seriesByDate.get(date)?.training_dose ?? null
   - isFuture = date > todayCN
   - isToday  = date === todayCN
```

### 6.3 Bucket 与色板

```ts
function heatmapBucket(dose: number | null): 0 | 1 | 2 | 3 | 4 {
  if (dose == null || dose <= 0) return 0
  if (dose <= 40) return 1
  if (dose <= 80) return 2
  if (dose <= 120) return 3
  return 4
}

const HEATMAP_COLORS = [
  '#f0f1f4',  // 0 = empty / rest        (slate-100-ish)
  '#fed7aa',  // 1 = light  (1–40)        (orange-200)
  '#fdba74',  // 2 = mid    (41–80)       (orange-300)
  '#fb923c',  // 3 = dark   (81–120)      (orange-400)
  '#c2410c',  // 4 = deepest (>120)       (orange-700)
] as const
```

档位依据：Z2 8km 轻松跑 ≈ 35–45 dose（多在 1–2 档）；Z4 间歇 ≈ 60–90 dose（3 档）；马拉松比赛 120+（4 档顶档）。

### 6.4 SVG 渲染规格

| 项 | 值 |
|---|---|
| Cell size | 18 × 18 px, `rx={3}` |
| Cell gap | 3 px |
| Day-label column | 28 px wide, 10px font-mono `#8888a0`, 只标 周一 / 周三 / 周五 |
| Month-label row | 12 px tall, 10px font-mono `#8888a0`，列的周一所在月份首次出现时标 |
| 总 viewBox | `28 + 16 × 21 = 364` × `12 + 7 × 21 = 159` |
| 外层 container | `<ResponsiveContainer>` 不用；直接 `<svg width="100%" viewBox="0 0 364 159" preserveAspectRatio="xMinYMid meet">` |
| 容器高度 | `180px`（与对面 8 周线图 `<ResponsiveContainer height={180}>` 对齐） |

**Cell `<rect>` 状态**：

| 状态 | 渲染 |
|---|---|
| 普通 | `fill={HEATMAP_COLORS[bucket]}` |
| 未来日 | `fill="transparent"` + `stroke="#e8eaf0"` `strokeDasharray="2 2"`，无 hover |
| 今日 | 底色 + 外圈 `stroke="#1a1c2e"` `strokeWidth={1}` |
| Hover | 在底色 / 今日 stroke 之上叠加 `stroke="#1a1c2e"` `strokeWidth={1.5}` |

### 6.5 Tooltip — 复用 DailyDoseTooltip

不是 Recharts chart，所以不能用 Recharts `<Tooltip>` 注入。改用 React state 跟踪：

```tsx
const [hovered, setHovered] = useState<{ date: string; x: number; y: number } | null>(null)
```

cell `onMouseEnter` 设状态，`onMouseLeave` 清空。Tooltip body 用 `position: fixed` + `pointer-events-none` 跟随鼠标：

```tsx
{hovered && (
  <div style={{ position: 'fixed', left: hovered.x + 12, top: hovered.y + 12, zIndex: 50, pointerEvents: 'none' }}>
    <DailyDoseTooltip
      active={true}
      payload={[{ payload: { date: hovered.date, training_dose: seriesByDate.get(hovered.date)?.training_dose ?? null } }]}
      activitiesByDate={activitiesByDate}
    />
  </div>
)}
```

`DailyDoseTooltip` 当前签名期望 `payload: Array<{ payload: { date, training_dose } }>` —— 直接匹配。无需改 tooltip 实现。

### 6.6 Legend

底部右对齐，与 Form chart legend 同 font / spacing：

```
                                      少 [□][▦][▩][▣][■] 多   0 · 40 · 80 · 120
```

5 个 12×12 px 色块横排，间距 3px；最右侧 `0 · 40 · 80 · 120` 标 bucket 分界。

---

## 7. Title / sub 文案

```tsx
<p className="text-[11px] font-mono text-text-muted mb-2 ml-1">
  16 周训练热力图 · 16-Week Activity Heatmap
</p>
```

与对面 "8 周负荷趋势 · 8-Week Load Trend (每周 Dose 累加)" 同 style。

---

## 8. 边界与已知坑

| 场景 | 行为 |
|---|---|
| 新用户 < 16 周数据 | 缺失日期在 `seriesByDate` 查不到 → bucket = 0 → 灰色空格 cell（与 GitHub 同语言："这天没动"） |
| dose = 0（活动存在但 dose 计算为 0） | bucket = 0，灰色。Tooltip 依然能弹出显示活动列表 — 区分"真休息"vs"轻活动 0 负荷" |
| 未来天（本周尚未到的天） | dashed 边框，无 hover 触发 |
| `rawSeries` 起点晚于 firstMonday | 起点前的列在 `seriesByDate` 没条目 → bucket = 0 灰色。Acceptable |
| 时区错位 | 全程 `shanghaiToday() / shanghaiDate() / shanghaiMondayOf()`；不使用原生 `new Date()` 表示"今天" |

---

## 9. 测试

`frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` 加：

1. **`heatmapBucket`** — `heatmapBucket(0) === 0`、`heatmapBucket(40) === 1`、`heatmapBucket(41) === 2`、`heatmapBucket(80) === 2`、`heatmapBucket(81) === 3`、`heatmapBucket(120) === 3`、`heatmapBucket(121) === 4`、`heatmapBucket(null) === 0`
2. **`<ActivityHeatmap>` 渲染** — mock dose series（包含一天 0 / 30 / 60 / 100 / 150 dose）→ 断言 SVG 包含 112 个 `<rect>`，且对应 5 种 fill 都至少出现一次
3. **未来日** — mock `series` 含明天 → 该 cell 渲染 dashed stroke
4. **fetch 翻页** — mock `getActivities` 返回 `{ activities: Array(200), total: 250, ... }` 第一次 + `{ activities: Array(50), total: 250, offset: 200, ... }` 第二次 → 断言 `getAllActivitiesInRange` 返回 250 条且调用 2 次

`frontend/src/lib/shanghai.test.ts`（已有此文件则就地加）测：

5. **`shanghaiMondayOf`** — `'2026-05-25'`（Mon）→ `'2026-05-25'`；`'2026-05-27'`（Wed）→ `'2026-05-25'`；`'2026-05-31'`（Sun）→ `'2026-05-25'`；`'2026-06-01'`（Mon）→ `'2026-06-01'`（跨月）

**不测**：tooltip 内部内容（DailyDoseTooltip 已有测试）、month label 算法（视觉细节）、SVG 像素布局。

---

## 10. 落地清单（按依赖顺序）

1. `frontend/src/lib/shanghai.ts` — 加 `shanghaiMondayOf`
2. `frontend/src/lib/shanghai.test.ts`（或同级 spec 文件）— 加 monday 测试
3. `frontend/src/api.ts` — 加 `getAllActivitiesInRange`
4. `frontend/src/pages/TrainingStatusPage.tsx`：
   - `loadFetchDays = Math.max(days, 112)`
   - `getActivities(...)` → `getAllActivitiesInRange(...)`
   - 加 `heatmapBucket` + `HEATMAP_COLORS` 常量（file-scope，紧挨现有 `formColor`）
   - 加 `ActivityHeatmap` 组件
   - 将 8-week trend chart wrapper 改为二列 grid，把 `ActivityHeatmap` 放入第二列
5. `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` — 加 heatmap + bucket + fetch-page 测试

---

## 11. Out of scope（YAGNI）

- 用户可调 weeks（4w / 8w / 16w / 52w 切换）
- 点击 cell 跳转到当天 activities 详情页
- 持久化 hover 状态 / pin tooltip
- 服务器端聚合 endpoint（per-day rollup）
- 横向滚动 / 缩放交互
