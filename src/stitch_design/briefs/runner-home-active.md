# Screen

Name: `Runner Home Active Week`
Route: `/v2/home`
State: `season_state=active, week_state=active, today's workout pending`

## User Goal

The runner opens STRIDE in the morning and should understand within five seconds: how recovered they are, what happened today, and what they should train today. Full-week progress and management belong to the `训练` tab.

## Required Content

- Fixed solid-surface top bar with a menu icon on the left, `STRIDE` wordmark, and a compact watch-sync action on the right using a sync icon, never a bell or notification icon. Show Shanghai-local date `7月14日 周二` and freshness text `08:12 已同步` directly below the top bar.
- The menu and watch-sync controls are real `48 x 48` logical-pixel buttons in the rendered DOM, with the 24 px icons centered inside those hit targets. Do not make only the icon itself clickable.
- A compact greeting and decision line: `早上好，朝毅` and `恢复正常，可以按计划完成节奏跑`.
- A restrained evidence strip directly under the decision. Show three supporting metrics with monospace numbers:
  - `HRV 52 ms` with `较基线 +4%`;
  - `静息心率 48 bpm` with `正常`;
  - `当前状态 -8%` with `维持区`.
- At 360 px and with larger system text, the three evidence items use a shrink-safe grid or responsive stack; values and statuses do not overlap or clip.
- The evidence strip is one flat compact row with quiet vertical dividers, not three square cards, not an `aspect-square` grid, and not a bento layout. Its visible labels are exactly `HRV`, `静息心率`, and `当前状态`; do not translate them to `RESTING HR`, `STATUS`, or other English dashboard labels. Show the full supporting status `较基线 +4%`, not only `+4%`.
- `今日活动` section only, positioned above `今日训练`. For this pending-workout screen, use the compact text-only zero state `今天暂无活动`. Do not place a sync action in this section; watch sync remains available only in the top bar.
- A visible `全部活动` text action.
- The strongest section is `今日训练`, directly displaying `节奏跑 · 8 km`, scheduled `18:30`, estimated `48 min`, target `5:15–5:25 /km`, heart-rate target `Z3 · 150–162 bpm`. Include a small `关键课` marker and a concise coach reason: `安排在今晚：恢复正常，且距周日长跑超过 72 小时。`
- Primary CTA: `查看训练详情`. Secondary text action: `调整今天安排`. Do not use a phone-based start-run action.
- Render the actual semantic `查看训练详情` button at exactly 52 logical px high with both `height: 52px` and `min-height: 52px`; do not reduce it to 48 px. Render `调整今天安排` at 48 logical px high. At both `390 x 844` and `360 x 800`, the entire secondary action, including its bottom edge, sits at least 12 logical px above the top border edge of the fixed bottom navigation without overlap.
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
- The bottom navigation also uses a fully opaque Foundation surface with only a quiet top divider. Its rendered classes and styles must not contain `backdrop-blur`, `backdrop-filter`, translucent `bg-*/95`, `shadow-sm`, or another generic drop shadow.
- `全部活动` is a semantic control with a minimum 48 px hit area even when its visible label remains compact.
- Buttons and raised surfaces use the Foundation ring/raised elevation; do not use a standalone generic `shadow-sm`.
- Do not use `shadow-xl`, `shadow-black/*`, or any free-floating card drop shadow. The training card uses the exact paired ring/raised elevation from Foundation.
- Apply `env(safe-area-inset-top)` to the fixed header and `env(safe-area-inset-bottom)` to the bottom navigation; do not substitute hard-coded safe-area pixels.
- The top app-bar content is 48 logical px high before `env(safe-area-inset-top)` padding. The page uses `min-height: 100dvh`; do not force a hard-coded `884px` minimum. Main content padding accounts for the fixed bars and safe areas without adding an unconditional 80 px body spacer.
- The responsive root canvas must not impose a positive minimum width. In exported HTML, `getComputedStyle(document.body).minWidth` is exactly `0px`; `html`, `body`, the fixed header, main content, and fixed bottom navigation contain no positive `min-width` rule or utility. The body is `width: 100%`, capped at `390px`, and remains centered.
- Enable Inter OpenType features `calt`, `kern`, `liga`, and `ss03` globally. Geist Mono athletic values use tabular numerals.
- Avoid stacking every section in a separate oversized rounded card. Use typography, thin rules, whitespace, and at most one subtle elevated surface for today's training.
- Do not expose `发现` as a bottom tab.
- Do not add promotional banners, subscription upsells, social feed, weather decoration, or nutrition logging to this screen.
- Keep the primary training decision and today's training above the fold at a 390 x 844 viewport.
- Compact the decision, evidence strip, section gaps, and workout surface as needed so the complete `调整今天安排` control ends at least 12 logical px above the bottom navigation at both `390 x 844` and `360 x 800` with `scrollY = 0`. Do not solve this by hiding, clipping, scaling, overlapping, moving main content under the 48 px top app bar, or using a hard-coded screen-height minimum.
- The bottom navigation is exactly 56 logical px tall before `env(safe-area-inset-bottom)` padding; do not substitute a taller 64 or 80 px shell.

## Acceptance Checks

- At first glance, the hierarchy reads: decision → today's activity state → today's workout.
- The recommendation is visibly supported by HRV, resting HR, and status reserve evidence.
- Athletic numbers use monospace typography and align cleanly.
- The page remains usable at 360 px width and with larger system text.
- Every tap target is at least 48 logical px, the primary CTA is exactly 52 px high, and bottom safe-area spacing is present.
- The page canvas and fixed shell use `width: 100%` with a 390 px maximum so the page does not overflow at 360 px.
- Browser review at 320 px confirms the root canvas remains fluid, has no horizontal overflow, and the evidence strip does not overlap or clip. This compact-width support must not change the 360 px or 390 px layouts.
- Browser review confirms the evidence strip remains readable at 360 px and with enlarged text, both safe areas are derived from environment variables, and the secondary action has at least 12 px clearance above the fixed bottom navigation at both target viewports.
- Status remains understandable in grayscale and does not depend on color alone.
