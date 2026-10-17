# Workout contract unified: one coach_contract module, deterministic rendering, shared fixtures

Status: accepted

> Tracker: stride-devops#583（Map #520）；决策依据 #521 D1/D2。

## Context

"一次训练课"的 TS 契约此前有两个并行来源：weekly plan（`weekly_plan/schema.ts`，
flat strictObject、nullable 值）与 master plan（`master_plan/schemas.ts` 私有
`WorkoutStructureSchema`，discriminated union、正数约束，且 target 只有
`pace_s_km`/`hr_bpm`/`open`）。两处各自演化，字段约束已经漂移；步后休息只能用
`step_kind='rest'` 的 step 表达；没有步频 target；渲染逻辑散落在消费方，无法
确定性复现。Go 侧 `internal/provider` 的 `TargetKind` 候选清单里 `cadence_spm`
一直"暂不建模"。

## Decisions

1. **单一模块**：`src/coach_contract/src/workout/` 是 run-workout/v1 与
   strength-workout/v1 的唯一契约来源。`weekly_plan/schema.ts` 直接复用（外部
   形状不变）；`master_plan/schemas.ts` 删除私有 `WorkoutStructureSchema` 改用
   共享 schema（master 由此补上 `power_w`、`cadence_spm`）。

2. **严格形状**：duration/target 是 discriminated union——
   `{kind: distance_m|time_s, value>0} | {kind: open, value: null}`、
   `{kind: pace_s_km|hr_bpm|power_w|cadence_spm, low>0, high>0} | {kind: open,
   low: null, high: null}`（沿用 master 的正数/null 严格约束，weekly 收紧到
   同一形状）。

3. **步后休息第一公民**：step 可选 `rest {kind: time_s|hr_bpm|manual, value}`
   （COROS 借鉴：time_s=固定秒数；hr_bpm=心率降到 value 以下继续；manual 时
   value=null）。硬校验：`step_kind='rest'` 的步不得带 rest 字段。旧 idiom
   （block 尾部 rest step）仍然合法；渲染（`renderRunWorkoutSummary()`）与
   totals（`workoutTotals()`）对两种 idiom 输出等价——尾部 rest step 折叠成
   `（休X）`，与 `step.rest` 的输出一致，休息计入总时长。

4. **lenient/strict 双层**：`RunWorkoutLenientSchema` 容忍 LLM 直出（非 strict
   剥噪、`note`/`hr_cap_bpm`/schema 判别符可省略），`normalizeRunWorkout()` 补
   默认后必须通过严格层。master 生成路径（skeleton LLM call）按
   lenient → normalize → strict 走，缺省键不再烧掉整次生成。

5. **版本策略：v1 内追加可选字段**（step.rest、target 新枚举值 power_w/
   cadence_spm），不升 v2。旧文档仍是合法 v1；读方必须容忍新枚举值与新字段。

6. **防漂移资产**：`generate-weekly-plan-schema.mjs` 另生成独立的
   `run-workout.schema.json`、`strength-workout.schema.json` 写入
   `src/go/internal/api/`；verify 脚本覆盖全部三个 schema（CI workspace job
   已有）。权威样例放 `tests/fixtures/workout/`（用户例句双 idiom、easy run、
   心率恢复休息、步频 target、力量课、open 时长），TS/Go/mp 共用；Go 侧
   `internal/provider` 测试逐一解析。

7. **Go 侧**：`TargetKind` 增加 `cadence_spm`（12→13），绝对量纲、
   `ResolveTarget` 直通；适配器暂不翻译 cadence target（落到 open/no-target
   的既有默认行为），后续接入另票。

## Consequences

- weekly 内嵌 workout 的 JSON Schema（`weekly_plan_schema.json`）随 union
  收紧而变化：`{kind: distance_m, value: null}` 这类历史坏形状从"能过 schema"
  变为拒绝；已落库文档不做回填，读取路径不重校验，无迁移需求。
- 渲染文案是确定性 golden（`workout.test.ts` 钉死），消费方（小程序/Web）
  后续可直接复用 fixtures 自检，不再各自手写渲染。
