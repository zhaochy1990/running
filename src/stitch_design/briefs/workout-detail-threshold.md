# Screen

Name: `Threshold Workout Detail`
Route: `/v2/plan/weeks/:weekId/workouts/:workoutId`
State: `active structured threshold workout, watch connected`

## User Goal

Understand exactly how to execute the threshold workout, review Coach's safeguards and fueling guidance, then sync it to the connected watch.

## Required Content

- Show a self-consistent summary: approximately `14.0 km`, `约 1:08`, and training load `230 TL`.
- Structure the workout as `2 km` warm-up, `重复 4 次` of `2 km` threshold plus approximately `500 m / 3 min` recovery, then `2 km` cooldown. The four recoveries contribute approximately `2 km`, making the displayed total `14 km`. Keep every pace and heart-rate requirement attached to its segment; recovery is easy jog at `Z1–Z2`.
- Include Coach cautions, route, equipment, and COROS connection status.
- Execution details explicitly show route `城市平路`, equipment `Endorphin Speed 3`, and status `已连接 COROS`.
- Use a full-width `补给建议` card that supports long Chinese guidance; do not reduce it to a metric tile.
- Fueling copy: `训练前 60–90 分钟补充 40–60g 碳水；若天气炎热或出汗较多，提前补充水和电解质。训练中按口渴和出汗情况小口补水，并携带 1 包能量胶备用。` Do not include a standalone liquid-volume range.

## Actions

- Primary: `同步到运动手表`.
- Secondary: return to the current week and discuss the workout with Coach.

## Navigation

- This is a focused detail screen with a back action and no bottom navigation.
- Back returns to the current weekly-plan detail.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation without preserving legacy Ember styling.
- The fueling card must retain natural wrapping and comfortable line height.
- Use Inter for interface text and Geist Mono with tabular numerals for every pace, heart rate, distance, duration, load, and repetition count.
- In long-form guidance, wrap numeric spans such as `60–90 分钟`, `40–60g`, and `1 包` with Geist Mono styling while keeping Chinese prose in Inter.
- Body copy uses Inter weight 500, muted text uses Foundation `#9C9C9D`, and reduced-motion preferences disable nonessential scale and motion.
- Use defined typography classes or explicit values: screen title `22px/28px`, labels `12px/16px`, body `16px/26px`, and tabular data `16px/24px`.
- Standard card borders use `rgba(255,255,255,0.06)`. Primary CTA includes the Foundation inset top highlight and dark inset bottom edge.
- Use opaque Foundation surfaces with safe-area environment variables. Do not use backdrop blur, translucent fixed chrome, `shadow-sm`, or a free-floating generic drop shadow.
- Every button and link, including back, overflow, Coach discussion, and watch sync, has a semantic hit area of at least 48 x 48 px.
- The shell uses width 100% and max-width 390 px with no horizontal overflow at 360 or 390 px.

## Acceptance Checks

- Repetition count, pace, heart-rate zones, and stop conditions are unambiguous.
- Coach stop condition: `若第三组后呼吸无法在恢复段稳定，立即停止第四组并转为冷身，不要硬顶。`
- `补给建议` spans the content width and the obsolete `400–600ml` metric is absent.
- COROS status and the sync action remain visible.
- The page has no horizontal overflow at 360 px or 390 px.
- Browser inspection reports zero interactive elements below 48 px and confirms top/bottom safe areas use environment variables.
- The top bar and main content use `env(safe-area-inset-top)`; bottom spacing uses `env(safe-area-inset-bottom)`.
