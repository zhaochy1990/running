# Screen

Name: `Coach Adjustment Proposal`
Route: `/v2/coach/:sessionId`
State: `active conversation with weekly-plan adjustment proposal`

## User Goal

Understand why Coach recommends reducing Thursday's workout and either inspect or apply the proposed change.

## Required Content

- Show the athlete's fatigue question and Coach's evidence-based response.
- Include HRV, resting heart rate, sleep, and recent training-load evidence.
- Present the proposed change from `节奏跑 · 3 × 10分钟` to `轻松跑 · 45分钟`.
- Keep the conversation composer visible above the navigation.

## Actions

- Primary: `应用到计划`.
- Secondary: `查看详情`, send a follow-up message, and open conversation history.

## Navigation

- This archived screen uses the legacy five-item navigation with Coach active.
- A future Foundation-aligned revision must use `跑者 / 训练 / 数据 / 教练`.

## Constraints

- Preserve this HTML as an approved legacy Ember snapshot; do not treat it as the current visual baseline.
- Any future visual edit must use the current white, green, four-tab STRIDE Mobile Foundation.
- Applying a proposal remains an explicit confirmation action.

## Acceptance Checks

- Evidence and recommendation are readable without relying on coral alone.
- The old and proposed workouts are both explicit.
- Composer and actions meet mobile touch-target requirements.
