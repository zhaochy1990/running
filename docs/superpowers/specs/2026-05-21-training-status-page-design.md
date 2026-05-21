# 训练状态（STRIDE）页面 — Design Spec

**Date**: 2026-05-21
**Status**: Approved, ready for implementation planning
**Scope**: 新增一个 `/training-status` 页面，展示 STRIDE 自研算法计算出的训练状态。旧页面 / 旧 API 全部保持不变。

---

## 1. 背景与动机

当前 `/health`、`/ability`、`/body-composition` 三个页面混合展示了手表厂商上报字段（COROS 的 `ati / cti / training_load_state` 等）和 STRIDE 自研算法字段（`acute_load / chronic_load / form` 等）。用户希望有一个**纯 STRIDE 自研指标**的状态页，明确这些值的来源是 STRIDE 算法而非手表黑盒。

具体诉求：

- 在 sidebar "数据 / 分析" 组里新增一个 tab，labeled **训练状态（STRIDE）**
- 旧页面、旧 endpoints 全部保留不动（继续透传手表厂商字段）
- 新页面展示：RHR（手表 raw）+ HRV（手表 raw）+ 阈值配速 / 阈值心率（STRIDE）+ 配速 / 心率区间（STRIDE）+ 训练负荷（STRIDE）
- 阈值与区间始终展示**当前值**；RHR / HRV / 训练负荷展示**趋势**

---

## 2. 数据来源约束（HARD）

**STRIDE 自研 vs. 手表透传** 区分（基于代码核查）：

| 字段 | 性质 | 来源 |
|---|---|---|
| `daily_health.rhr` | 手表上报 | COROS API `testRhr / rhr`（`stride_core/models.py:417`） |
| `daily_hrv.*` | 手表上报 | COROS API（COROS 用户为空，Garmin 用户有数据） |
| `daily_health.ati / cti / training_load_ratio / training_load_state` | **手表上报** | COROS API 透传字段 ← **本页面不使用** |
| `running_calibration_snapshot.threshold_speed_mps` | **STRIDE 自研** | `stride_core/running_calibration/core.py:36-89`（best-effort 上包络模型） |
| `running_calibration_snapshot.threshold_hr` | **STRIDE 自研** | 同上文件 lines 60-74（稳定阈值 HR 候选加权中位数） |
| `running_calibration_zone.*` | **STRIDE 自研** | `stride_core/running_calibration/zones.py:42-102`（基于 threshold × 固定比例） |
| `daily_training_load.acute_load / chronic_load / form / load_ratio` | **STRIDE 自研** | `stride_core/training_load/core.py:470-541`（基于 STRIDE TRIMP + 外部 TSS 加权 EWMA） |
| `activity_training_load.training_dose` | **STRIDE 自研** | 同文件 lines 276-332 |
| 计算字段 `rhr_baseline`（90d p10） | **STRIDE 自研**（边界） | `stride_server/routes/health.py:65-74`（窗口运算） |

**禁用清单（本页面绝不读取）**：
- `daily_health.ati`、`daily_health.cti`、`daily_health.training_load_*`、`daily_health.fatigue`
- `activities.training_load`（COROS 字段）
- `/api/{user}/health` 响应里的 `summary` / `pmc` 数组（这些是 COROS pass-through）

---

## 3. 页面布局

```
┌─ 页面标题: 训练状态  副标题: STRIDE 自研算法 ─────────────┐
│                                       [14d|30d|60d|90d]  │ ← 时间窗切换，默认 30d
└─────────────────────────────────────────────────────────┘

┌─ RHR ─┐ ┌─ HRV ─┐ ┌─ 阈值配速 ─┐ ┌─ 阈值心率 ─┐         ← 4 卡片横排
│ 47 bpm│ │ 62 ms │ │  4:18/km   │ │  175 bpm   │
│ 基线49│ │ 基线58│ │ 置信 0.82  │ │ 置信 0.82  │
└───────┘ └───────┘ └────────────┘ └────────────┘

┌─ RHR 趋势（半行）─────┐ ┌─ HRV 趋势（半行）─────┐         ← 2 趋势图各半行
│  [AreaChart 30d]      │ │  [AreaChart 30d]      │
└───────────────────────┘ └───────────────────────┘

┌─ 配速区间（半行）─────┐ ┌─ 心率区间（半行）─────┐         ← 2 区间列表各半行
│ Z1 轻松 5:58 – 6:42   │ │ Z1 恢复  105 – 140    │
│ Z2 有氧 5:06 – 5:58   │ │ Z2 有氧  140 – 154    │
│ Z3 节奏 4:36 – 5:06   │ │ Z3 节奏  154 – 165    │
│ Z4 阈值 4:18 – 4:36   │ │ Z4 阈值  165 – 175    │
│ Z5 VO2  3:52 – 4:18   │ │ Z5 VO2   175 – 188    │
└───────────────────────┘ └───────────────────────┘

┌─ 训练负荷（整行）─────────────────────────────────────┐   ← 整行
│  Acute 78  Chronic 72  Form +6  Ratio 1.08            │
│  状态: 产出期    Readiness: GO                         │
│  ┌─ PMC 90d 叠加面积图 ─────────────────────────────┐  │
│  │ acute_load / chronic_load / form 三色叠加          │  │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘

┌─ 数据状态脚注 ──────────────────────────────────────────┐
│ Calibration as of 2026-05-15 · 来源: STRIDE 自研算法    │
│ RHR / HRV 来自手表原始读数                              │
└──────────────────────────────────────────────────────────┘
```

布局说明：

- 顶部时间窗切换：`14d | 30d | 60d | 90d`，默认 **30d**
- 4 卡片横排：RHR / HRV / 阈值配速 / 阈值心率
- RHR 与 HRV 卡片下方各有一个趋势图（**半行宽**），加起来占满一整行；阈值配速、阈值心率**不显示趋势**
- 配速区间 + 心率区间：两个**列表**形式（每行一个 zone），左右各半行
- 训练负荷：当前数字 + 状态文案 + PMC 叠加面积图，**整行宽**
- 页脚显示 calibration 日期 + 数据来源说明

---

## 4. 后端 — 新增 API

**原则**：旧 endpoints（`/api/{user}/health`、`/api/{user}/hrv`）保持现状，继续返回手表透传字段。新增 `/api/{user}/stride/*` namespace 专门服务 STRIDE 自研算法输出。

新建文件 `src/stride_server/routes/stride.py`，在 `app.py` 注册路由。

### 4.1 `GET /api/{user}/stride/zones`

读 `running_calibration_snapshot` 最新一行 + `running_calibration_zone` 表。

**响应**（有校准）：

```json
{
  "threshold": {
    "speed_mps": 4.65,
    "pace_per_km_sec": 215,
    "hr_bpm": 175,
    "confidence": 0.82,
    "as_of_date": "2026-05-15",
    "calibration_id": "..."
  },
  "pace_zones": [
    {"name": "Z1", "label": "轻松", "lower_pace": "6:42", "upper_pace": "5:58"},
    {"name": "Z2", "label": "有氧", "lower_pace": "5:58", "upper_pace": "5:06"},
    {"name": "Z3", "label": "节奏", "lower_pace": "5:06", "upper_pace": "4:36"},
    {"name": "Z4", "label": "阈值", "lower_pace": "4:36", "upper_pace": "4:18"},
    {"name": "Z5", "label": "VO2max", "lower_pace": "4:18", "upper_pace": "3:52"}
  ],
  "hr_zones": [
    {"name": "Z1", "label": "恢复", "lower_bpm": 105, "upper_bpm": 140},
    {"name": "Z2", "label": "有氧", "lower_bpm": 140, "upper_bpm": 154},
    {"name": "Z3", "label": "节奏", "lower_bpm": 154, "upper_bpm": 165},
    {"name": "Z4", "label": "阈值", "lower_bpm": 165, "upper_bpm": 175},
    {"name": "Z5", "label": "VO2max", "lower_bpm": 175, "upper_bpm": 188}
  ]
}
```

**响应**（新用户 / 无校准）：

```json
{
  "threshold": null,
  "pace_zones": [],
  "hr_zones": []
}
```

**Fallback 策略**：`running_calibration_zone` 表为空但 `running_calibration_snapshot` 有 threshold → 用 `zones.py` 现场计算并返回（不写回 DB，避免引入 side-effect）。

**配速格式**：服务器返回 `MM:SS`（分:秒/km）字符串；前端不做单位转换。

### 4.2 `GET /api/{user}/stride/training-load?days=N`

读 `daily_training_load` 表（已由 sync hook 持久化）。`days` 范围 `[7, 365]`，默认 90。

**响应**：

```json
{
  "current": {
    "date": "2026-05-21",
    "training_dose": 75.2,
    "acute_load": 78.0,
    "chronic_load": 72.0,
    "form": 6.0,
    "load_ratio": 1.08,
    "readiness_gate": "go",
    "readiness_reasons": ["..."],
    "chronic_load_ramp": 1.5
  },
  "series": [
    {"date": "2026-02-20", "training_dose": 0.0, "acute_load": 65.0, "chronic_load": 70.0, "form": 5.0, "load_ratio": 0.93},
    ...
  ]
}
```

**空数据**：`{"current": null, "series": []}`。

**参数校验**：
- `days < 7` 或 `days > 365` → 422
- 不存在的 user → 404

---

## 5. 前端

### 5.1 文件改动

| 文件 | 操作 |
|---|---|
| `frontend/src/pages/TrainingStatusPage.tsx` | **新建** |
| `frontend/src/lib/api.ts` | 加 `getStrideZones(user)` + `getStrideTrainingLoad(user, days)` 两个 fetcher |
| `frontend/src/App.tsx` | 加 `<Route path="training-status" element={<TrainingStatusPage />} />` |
| `frontend/src/components/AppLayout.tsx` | "数据 / 分析" 组加 `<NavLink to="/training-status">训练状态（STRIDE）</NavLink>`，位置紧邻 `/ability` 下方 |

### 5.2 页面结构

遵循项目现有惯例（`BodyCompositionPage.tsx`、`HealthPage.tsx`）：**单页文件内联子组件 + Recharts**。

```tsx
function TrainingStatusPage() {
  const { user } = useUser()
  const [days, setDays] = useState<14|30|60|90>(30)

  // 4 个并行 SWR 请求
  const health = useSWR(['health', user], () => getHealth(user))             // 旧：RHR raw + rhr_baseline
  const hrv    = useSWR(['hrv', user], () => getHrv(user))                   // 旧：HRV
  const zones  = useSWR(['stride-zones', user], () => getStrideZones(user))  // 新
  const load   = useSWR(['stride-load', user, days], () => getStrideTrainingLoad(user, days))  // 新

  return (
    <>
      <PageHeader title="训练状态" subtitle="STRIDE 自研算法" />
      <TimeRangeToggle value={days} onChange={setDays} />  {/* 14|30|60|90 */}

      <MetricsRow>            {/* 4 卡片横排 */}
        <RhrCard data={health.data} />
        <HrvCard data={hrv.data} />
        <ThresholdPaceCard data={zones.data} />
        <ThresholdHrCard data={zones.data} />
      </MetricsRow>

      <TrendsRow>             {/* 2 趋势图各半行 */}
        <RhrTrendChart data={health.data} days={days} />
        <HrvTrendChart data={hrv.data} days={days} />
      </TrendsRow>

      <ZonesRow>              {/* 2 区间列表各半行 */}
        <PaceZonesList data={zones.data} />
        <HrZonesList data={zones.data} />
      </ZonesRow>

      <TrainingLoadSection data={load.data} days={days} />  {/* 整行 */}

      <DataStatusFooter zones={zones.data} load={load.data} />
    </>
  )
}
```

### 5.3 复用 / 样式

- 卡片：复用 `BodyCompositionPage.tsx` 的 MetricCard pattern（Tailwind utility class）
- 趋势图：复用 `HRChart.tsx` / `PaceChart.tsx` 的 `AXIS_TICK / TOOLTIP_STYLE / GRID_STYLE` 常量
- PMC 叠加面积图：从 `HealthPage.tsx` 现有 PMC 图改字段：`ati → acute_load`、`cti → chronic_load`、`tsb → form`
- 时间窗切换：用现有 `ToggleGroup` 组件（如存在）；否则新写一组按钮（约 20 行）

### 5.4 RHR / HRV 字段使用边界

**前端只从 `/api/{user}/health` 响应中读取**：

- `summary.rhr_baseline`（STRIDE 计算的 90d p10）
- `pmc[].date` + `pmc[].rhr`（手表 raw daily 值，用于趋势图）

**显式不读**：`summary.current_ati / current_cti / current_tsb / current_*`、`pmc[].ati / .cti / .tsb`、`stride_summary.*`、`stride_pmc[].*`。

这一点用代码审阅 + 测试 props 流向断言保护。

### 5.5 时间窗交互

- `days` 变化 → 重取 `/stride/training-load?days=N`
- RHR / HRV：一次取 90d，前端 slice 到选中窗口（不重取）
- Thresholds / zones：与时间窗无关，始终最新

### 5.6 加载 / 错误 / 空状态

- 4 个 SWR 请求独立 key，互不阻塞
- 任一请求挂掉时，该区块显示错误占位，其它区块正常渲染
- 无校准（`threshold === null`）→ 阈值卡片显示 "暂无 STRIDE 校准数据，需先完成一定次数的跑步活动"，区间列表显示空提示（具体所需跑步次数由 `running_calibration` 模块决定，实现时从代码常量读取，不在 UI 文案里硬编码）
- 无训练负荷数据 → 训练负荷区块显示 "暂无数据"

---

## 6. 测试

### 6.1 后端 — `tests/test_stride_routes.py`（新建）

| 测试 | 期望 |
|---|---|
| `GET /stride/zones`，用户有 calibration + zone 表已填 | 200，threshold + pace_zones + hr_zones 都非空且 Z1..Z5 严格递增 |
| `GET /stride/zones`，用户有 threshold 但 zone 表为空 | 200，zones 由 fallback 现场计算返回 |
| `GET /stride/zones`，用户无 calibration | 200，`{"threshold": null, "pace_zones": [], "hr_zones": []}` |
| `GET /stride/zones`，不存在的 user | 404 |
| `GET /stride/training-load?days=30`，有数据 | 200，`current + series` 字段类型 + series 长度 ≤ 30 |
| `GET /stride/training-load?days=30`，无数据 | 200，`{"current": null, "series": []}` |
| `GET /stride/training-load?days=6` | 422 |
| `GET /stride/training-load?days=400` | 422 |

参考 `tests/test_ability_routes.py` 的 in-memory SQLite fixture 模式。

### 6.2 前端 — `frontend/src/__tests__/TrainingStatusPage.test.tsx`（新建）

| 测试 | 期望 |
|---|---|
| 4 个 API mock 成功 | 4 卡片 + 2 趋势图 + 2 区间列表 + 训练负荷区块都渲染 |
| `/stride/zones` 返回 `threshold: null` | 阈值卡片显示"暂无校准"占位，区间列表空提示 |
| `/stride/training-load` mock fail | 训练负荷区块显示错误占位，其它区块正常 |
| 切换时间窗 30 → 90 | `getStrideTrainingLoad` 以 `days=90` 重新调用一次 |
| `/health` mock 返回带 `stride_summary` 字段 | 这些字段不被使用（断言前端只读 `rhr` / `rhr_baseline`） |

### 6.3 Lint / 类型

- `PYTHONPATH=src lint-imports` 通过（新 route 在 `stride_server`，可读 `stride_core.db` + 表）
- `frontend && tsc --noEmit` 通过
- 现有 pytest suite + vitest suite 全绿

### 6.4 手动验证（必跑，按 CLAUDE.md 节奏）

1. 在 worktree 里跑 `python -m coros_sync -P zhaochaoyi sync` 拿最新数据
2. 启 backend + frontend dev server
3. 浏览器打开 `/training-status`，截图确认：
   - 4 个卡片数字合理（RHR ∈ [40, 60]、阈值配速 ∈ [4:00, 5:00]、阈值心率 ∈ [160, 185]）
   - 趋势图 90d 数据连续，时间窗切换正常缩放
   - 区间列表 Z1 < Z2 < Z3 < Z4 < Z5 严格递增
   - PMC 图三条线分明
4. **核心价值对照**：与 `/health` 旧页比较，本页训练负荷数字应该**不同**（新页 STRIDE `acute_load` vs. 旧页 COROS `ati`）—— 这就是这次改造的存在意义

---

## 7. Out of scope（非本次范围）

以下事项不在本设计内，未来如需要单独提：

- 修改 `/api/{user}/health` 把 `stride_summary` / `stride_pmc` / `rhr_baseline` 剥离出去（彻底净化旧 endpoint）
- 修改 `/ability` 或 `/health` 旧页面
- 推训练状态到手表 / 推送通知
- 训练负荷的写入侧（per-activity TSS 由现有 sync hook 处理，不动）
- 历史 calibration 列表 / 回退到旧版校准
- 训练状态相关的 mobile app 端

---

## 8. 验收标准

- [ ] 后端两个新 endpoints 上线，pytest 全绿，lint-imports 通过
- [ ] 前端新页面挂上 sidebar，TypeScript 编译通过，vitest 全绿
- [ ] 浏览器打开页面，4 卡片 + 2 趋势图 + 2 区间表 + 训练负荷 + 脚注全部正确渲染
- [ ] 训练负荷数字与 `/health` 旧页不同（证明用的是 STRIDE 算法值而非 COROS pass-through）
- [ ] 无校准用户访问页面不崩，显示占位
- [ ] 旧 endpoints `/api/{user}/health` 与 `/api/{user}/hrv` 响应未变更（regression test）
