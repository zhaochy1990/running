# Screen

Name: `Runner Home Active Week`
Route: `/v2/home`
State: `season_state=active, week_state=active, today's workout pending`

## User Goal

The runner opens STRIDE in the morning and should understand within five seconds: how recovered they are, what happened today, and what they should train today. Full-week progress and management belong to the `训练` tab.

## Required Content

- Fixed solid-surface top bar with a menu icon on the left, `STRIDE` wordmark, and a compact watch-sync action on the right using a sync icon, never a bell or notification icon. Show Shanghai-local date `7月14日 周二` and freshness text `08:12 已同步` directly below the top bar.
- A compact greeting and decision line: `早上好，朝毅` and `恢复正常，可以按计划完成节奏跑`.
- A restrained evidence strip directly under the decision. Show three supporting metrics with monospace numbers:
  - `HRV 52 ms` with `较基线 +4%`;
  - `静息心率 48 bpm` with `正常`;
  - `当前状态 -8%` with `维持区`.
- At 360 px and with larger system text, the three evidence items use a shrink-safe grid or responsive stack; values and statuses do not overlap or clip.
- `今日活动` section only, positioned above `今日训练`. For this pending-workout screen, use the compact text-only zero state `今天暂无活动`. Do not place a sync action in this section; watch sync remains available only in the top bar.
- A visible `全部活动` text action.
- The strongest section is `今日训练`, directly displaying `节奏跑 · 8 km`, scheduled `18:30`, estimated `48 min`, target `5:15–5:25 /km`, heart-rate target `Z3 · 150–162 bpm`. Include a small `关键课` marker and a concise coach reason: `安排在今晚：恢复正常，且距周日长跑超过 72 小时。`
- Primary CTA: `查看训练详情`. Secondary text action: `调整今天安排`. Do not use a phone-based start-run action.
- Four-item bottom navigation in this exact order: `跑者`, `训练`, `数据`, `教练`. `跑者` is active. Do not show `发现` or `我` in bottom navigation.

## Actions

- Primary: `查看训练详情` opens the immutable current session.
- Secondary: sync watch data, adjust today's arrangement through Coach, open an activity, and open all activities.

## Navigation

- The menu icon opens the account drawer, which contains personal center and Discover.
- Bottom navigation remains visible because this is a root tab screen.
- When present, today's activity rows enter activity detail. `今日训练` enters session detail. Full-week management is reached through the `训练` tab.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation without page-specific color or font overrides.
- Do not show legacy terms such as `训练总纲`, `单周计划`, `TSB`, `ATL`, `CTL`, `Draft`, or English dashboard labels.
- Do not use status rings, circular gauges, large hero charts, gradients, generic runner illustrations, glass effects, or a grid of equal metric cards.
- The top bar uses a solid Foundation surface with a quiet divider; no backdrop blur, translucent surface, or frosted-glass treatment.
- `全部活动` is a semantic control with a minimum 48 px hit area even when its visible label remains compact.
- Buttons and raised surfaces use the Foundation ring/raised elevation; do not use a standalone generic `shadow-sm`.
- Do not use `shadow-xl`, `shadow-black/*`, or any free-floating card drop shadow. The training card uses the exact paired ring/raised elevation from Foundation.
- Apply `env(safe-area-inset-top)` to the fixed header and `env(safe-area-inset-bottom)` to the bottom navigation; do not substitute hard-coded safe-area pixels.
- Enable Inter OpenType features `calt`, `kern`, `liga`, and `ss03` globally. Geist Mono athletic values use tabular numerals.
- Avoid stacking every section in a separate oversized rounded card. Use typography, thin rules, whitespace, and at most one subtle elevated surface for today's training.
- Do not expose `发现` as a bottom tab.
- Do not add promotional banners, subscription upsells, social feed, weather decoration, or nutrition logging to this screen.
- Keep the primary training decision and today's training above the fold at a 390 x 844 viewport.

## Acceptance Checks

- At first glance, the hierarchy reads: decision → today's activity state → today's workout.
- The recommendation is visibly supported by HRV, resting HR, and status reserve evidence.
- Athletic numbers use monospace typography and align cleanly.
- The page remains usable at 360 px width and with larger system text.
- Every tap target is at least 48 logical px, and bottom safe-area spacing is present.
- The page canvas and fixed shell use `width: 100%` with a 390 px maximum so the page does not overflow at 360 px.
- Browser review confirms the evidence strip remains readable at 360 px and with enlarged text, and both safe areas are derived from environment variables.
- Status remains understandable in grayscale and does not depend on color alone.
