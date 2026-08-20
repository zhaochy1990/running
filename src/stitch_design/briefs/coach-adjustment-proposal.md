# Screen

Name: `Coach Adjustment Proposal`
Route: `/v2/coach/:sessionId`
State: `active conversation with weekly-plan adjustment proposal`

## User Goal

Understand why Coach recommends reducing Thursday's workout and either inspect or apply the proposed change.

## Required Content

- Show the athlete's fatigue question and Coach's evidence-based response.
- Include exactly four evidence items: `HRV 较基线 -8%`, `静息心率 52 bpm`, `昨晚睡眠 6h 12m`, and `近 7 天负荷 +12%`.
- Present the proposed change from `节奏跑 · 3 × 10分钟` to `轻松跑 · 45分钟`.
- Keep the conversation composer visible above the navigation.

## Actions

- Primary: `应用到计划`.
- Secondary: `查看详情`, send a follow-up message, and open conversation history.

## Navigation

- Use the four-item navigation `跑者 / 训练 / 数据 / 教练`, with `教练` active.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation without preserving legacy Ember styling.
- Applying a proposal remains an explicit confirmation action.
- Use Inter weight 500 for interface copy and Geist Mono with tabular numerals for HRV, heart rate, percentages, durations, and repetition counts.
- Import Geist Mono; do not use JetBrains Mono. Canvas is `#07080A`, standard surface/background is `#101111` rather than `#121316`.
- Use exact Foundation tokens: primary `#F9F9F9`, secondary `#CECECE`, muted `#9C9C9D`, raised `#1B1C1E`, success `#5FC992`, and translucent `rgba(255,255,255,0.06)` borders.
- Use opaque Foundation surfaces with safe-area environment variables. Do not use backdrop blur, translucent fixed chrome, `shadow-sm`, or free-floating generic shadows.
- Every semantic button and link, including history, attachment, send, proposal actions, and each bottom-navigation destination, has a hit area of at least 48 x 48 px.
- The actual history, attachment, send, `查看详情`, and `应用到计划` button elements each have minimum height 48 px; icon-only buttons also have minimum width 48 px.
- The shell uses width 100% and max-width 390 px with no horizontal overflow at 360 or 390 px.
- Enable Inter `calt`, `kern`, `liga`, and `ss03`; respect reduced-motion preferences.
- All controls use the Foundation blue dual `focus-visible` ring. Reduced-motion disables online pulse and navigation scale.
- Primary `应用到计划` uses a near-white surface with dark text and coral only as a small proposal marker; do not use a full coral button.
- Screen title uses `22px/28px`, body uses `16px/26px` at weight 500 with positive tracking, and long Chinese guidance has at least 1.6 line height. Training repetition and duration values use Geist Mono.
- Cards and secondary controls use the Foundation paired outer/inset elevation. The primary CTA is full pill with inset top highlight and dark inset bottom edge.
- The focus ring is exactly a 1 px solid blue edge plus a 4 px outer translucent blue ring.

## Acceptance Checks

- Evidence and recommendation are readable without relying on color alone.
- The old and proposed workouts are both explicit.
- Composer and actions meet mobile touch-target requirements.
- Browser inspection reports zero interactive elements below 48 px and confirms the exact navigation labels `跑者 / 训练 / 数据 / 教练`.
- No visible navigation label uses `首页`, `计划`, `记录`, `分析`, or `Coach`.
