---
name: generate-weekly-plan
description: Use this skill when the user wants to generate a new weekly training plan. The skill will generate a weekly training plan based on the user's season goal, season training plan, current training phase, and recent training activities. The plan should include the daily training schedule for the target week, specific content for each training session (including training type, volume, intensity, etc.), as well as dietary and recovery recommendations.
---

# How to generate a weekly training plan

## Step 1: Look up the user's master training plan and current training status

call `get_master_plan` to retrieve the user's season goal and current active training plan. If the user does not have a season goal or training plan, reject the request and ask the user to set a season goal and training plan first.

next, call `get_weekly_plan_context` to retrieve the user's current training status, the response includes the following information:
- `as_of`: the inclusive training-data cutoff date
- `plan_start`: the authoritative Monday for the target week
- `week_folder`: the authoritative canonical folder identity for the target week
- current training phase and stage
- recent training activities and feedback
- current fitness state and training load
- injury status and recovery status
- user's running calibration data (lactate threshold heart rate, threshold pace, heart rate zones, pace zones)

## Step 2: Generate the weekly training plan

Based on the user's season goal, current training phase and stage, recent training activities and feedback, and current fitness state, generate a weekly training plan for the target week. The plan should include the following information:
- daily training schedule for the target week
- specific content for each training session (including training type, volume, intensity, etc.)

- take references/8weeks.md for an example traning plan for users that are in the 8 weeks before their race.

我们要保证用户的周训练计划遵循1Q1L或者2Q1L的典型结构。
注意，我们需要根据用户前面4周的负荷来规划下一周的训练负荷。举例如下，
1. example1，用户前一周的训练完成程度不高而下一周是恢复周，那么下一周就不用完全按照恢复周来训练，负荷可以适当提高
2. example2，用户前一周的训练强度超过了计划的强度，而下一周计划继续加强度，这时候需要根据用户的恢复情况（采用静息心率，RHV等健康指标来进行判断）来调整下一周的训练负荷，如果恢复的好，那么可以按照训练计划继续加量，如果恢复的不好，需要适当减量，避免过度训练导致受伤

The target week is exactly `plan_start` through six days after `plan_start`. Do not
use the system date or independently reinterpret “this week” or “next week”. Every
session and nutrition date must fall within that target week, and nutrition must
cover all seven dates.
Set the WeeklyPlan top-level `week_folder` exactly to the context `week_folder`;
do not derive or invent it. Include every canonical schema stamp required by the
structured output contract.
For catalogued strength exercises, set both `canonical_id` and `provider_id` to
the same real COROS T-code (for example `T1262`). When no catalog exercise
accurately represents the movement, use a stable descriptive `canonical_id` and
set `provider_id` to null so the adapter creates a custom exercise; never invent
or approximate a T-code.
Use only verified catalog mappings, including: squat `T1061`, single-leg
deadlift `T1187`, side plank `T1185`, dead bug `T1243`, single-leg calf raise
`T1275`, step-up `T1296`, goblet squat `T1301`, and dumbbell Romanian deadlift
`T1305`.

We need to use different training types and training intensities for different training phases. You need reference the instructions from "references" folder to understand how to organize the trainings for each phase. Currently, the training phases include: 基础期(base.md)、提升期(build.md)、专项速度周期(speed.md)、马拉松专项期(marathon.md)、赛前减量期(taper.md)、赛后恢复期(recovery.md).

## Step 3: 输出 Coach Agent WeeklyPlan

运行时会依据结构化输出 schema 验证返回值。最终返回 `{ "disposition": "return_direct", "content": WeeklyPlan }`，其中 `content` 是下面定义的完整 WeeklyPlan；不要输出 Markdown。所有面向用户的文本字段使用中文；字段名和枚举值使用英文/ASCII。
