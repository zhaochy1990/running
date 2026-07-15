# Multi-model weekly plan variants

**何时读**：要用 Claude / Codex / Gemini A/B/C 同一周的 plan 时必读。

## 概念

Variants 是 append-only 的 side rows；选定某个只把完整 `WeeklyPlan` 提升到 canonical `WeeklyPlanStore`。不会写 SQLite `weekly_plan` / `planned_session` / `planned_nutrition`。手表执行状态独立保存在 `scheduled_workout`。

## Canonical happy path

```bash
# 1. 给下周生成 3 个模型 variant（经 omc-teams 并行）。
#    每个模型拿到相同 context（TRAINING_PLAN.md + 最近几周的 plan.md + feedback.md），
#    用 sentinel-anchored JSON 输出协议。解析失败的上传为 parse_failed
#   （可浏览但不可选）。需要 auth（无 anonymous fallback）。
coros-sync plan generate-variants -P zhaochaoyi --week 2026-05-04_05-10 \
    --models claude,codex,gemini --prod-url $STRIDE_PROD_URL

# 2. UI：打开 https://stride-app.../week/<folder> → "方案" tab
#    （只在 variants_summary.total > 0 时可见）
#    → 给每个 variant 评 4 个维度 + overall（slider，800ms 防抖；comment 同）
#    → 点 "选定" 提升 preferred variant
#    或 CLI：
coros-sync plan select -P zhaochaoyi --week 2026-05-04_05-10 --variant-id <N>
```

## Change-of-mind / 改选场景

如果已经把 variant A 的某个 session 推到了手表、然后改选 variant B，原来推过的 `scheduled_workout` 会按 `(week_folder, planned_date, session_index)` 被识别为旧执行状态：

- `coros-sync plan select`（或 UI 改选）在 force 为 false 时返回 **HTTP 409 selection_conflict**，带 `already_pushed_count`。
- 传 `--force`（UI 是确认 dialog）覆盖。response 给出 `dropped_scheduled_workout_ids: [...]` —— 这些行的 `scheduled_workout.abandoned_by_promote_at = now`。
- **手动清理必需**：打开 COROS App 删掉列出的 `[STRIDE]` watch 条目，然后再推 new variant 的 sessions，否则手表上重复。
- "训练计划" tab 显示红 banner 列出被遗弃的日期；相关 `ActivityDetailPage` 在关联 abandoned scheduled_workouts 的完成活动上显示警告卡片。

## Why no auto re-stitch

Step 0 spike 实测 `(date, session_index, kind)` 匹配键命中率在 12 个 directed pair（4 个 evaluation/variant）上是 **73.7%** —— 低于 90% gate。双峰分布（8/12 在 cluster 内 100% vs 4/12 跨 cluster ~45%）意味着不能假定键在模型 output 之间稳定（特别是 long-run cadence 分歧时）。Step 1 ships the FALLBACK design：每个旧 `scheduled_workout` 在改选时成孤儿；user 手动清 COROS。参见 `.omc/plans/multi-variant-weekly-plans.md` § Step 0 + `spike/restitch-findings.md`（local-only）。

## `coros-sync plan` subcommands

- `generate-variants` —— fan out 到 N 个 `omc ask <model>` workers（ThreadPoolExecutor，每个 180s 超时），用 3-tier sentinel/fenced/balanced-braces parser 解析每个输出，hard `schema='weekly-plan/v1'` anchor，每个 POST 到 `/api/{user}/plan/{folder}/variants`。
- `list-variants` —— GET active variants（或 `--include-superseded`），表格列出 model_id / status / sessions / overall rating / is_selected / selectable。
- `rate` —— UPSERT 各维度评分：`--overall N --suitability N --structure N --nutrition N --difficulty N --comment STR`（任意 dim 子集）。
- `select` —— 提升 variant；遇到 409 concurrent_select 时按 `Retry-After: 1` 自动重试一次。
- `delete-variants` —— 清掉某周的所有 variants + ratings（除非 `--yes` 否则提示确认）。
