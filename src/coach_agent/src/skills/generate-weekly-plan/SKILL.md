---
name: generate-weekly-plan
description: Use this skill when the user wants to generate a new weekly training plan. The skill will generate a weekly training plan based on the user's season goal, season training plan, current training phase, and recent training activities. The plan should include the daily training schedule for the target week, specific content for each training session (including training type, volume, intensity, etc.), as well as dietary and recovery recommendations.
---

# How to generate a weekly training plan

## Step 1: Look up the user's master training plan and current training status

call `get_master_plan` to retrieve the user's season goal and current active training plan. If the user does not have a season goal or training plan, reject the request and ask the user to set a season goal and training plan first.

next, call `get_weekly_plan_context` to retrieve the user's current training status, the response includes the following information:
- current training phase and stage
- recent training activities and feedback
- current fitness state and training load
- injury status and recovery status
- user's running calibration data (lactate threshold heart rate, threshold pace, heart rate zones, pace zones)

## Step 2: Generate the weekly training plan

Based on the user's season goal, current training phase and stage, recent training activities and feedback, and current fitness state, generate a weekly training plan for the target week. The plan should include the following information:
- daily training schedule for the target week
- specific content for each training session (including training type, volume, intensity, etc.)

We need to use different training types and training intensities for different training phases. You need reference the instructions from "references" folder to understand how to organize the trainings for each phase. Currently, the training phases include: 基础期(base.md)、提升期(build.md)、专项速度周期(speed.md)、马拉松专项期(marathon.md)、赛前减量期(taper.md)、赛后恢复期(recovery.md).

## Step 3: 输出 Coach Agent WeeklyPlan

运行时会依据结构化输出 schema 验证返回值。最终返回 `{ "disposition": "return_direct", "content": WeeklyPlan }`，其中 `content` 是下面定义的完整 WeeklyPlan；不要输出 Markdown。所有面向用户的文本字段使用中文；字段名和枚举值使用英文/ASCII。
