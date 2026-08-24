# Screen

Name: `Interval 800m Workout Detail`
Route: `/v2/plan/weeks/:weekId/workouts/:workoutId`
State: `active structured 800m interval workout, watch connected`

## User Goal

Understand exactly how to execute the 800m interval workout, review Coach's pacing and recovery safeguards and fueling guidance, then sync it to the connected watch.

## Required Content

- Show a self-consistent summary: approximately `10.8 km`, `约 56 分钟`, and training load `130 TL`.
- Structure the workout as `2 km` 热身, `重复 6 次` of `800 m` intervals at `4:00–4:15 /km` plus `400 m` 慢跑恢复, then `2 km` 冷身. The five recoveries contribute `2.0 km`, making the displayed total `10.8 km`. Keep every pace and heart-rate requirement attached to its segment.
- Work intervals target pace zone `4:00–4:15 /km` with heart-rate cap `Z4–Z5`. Recovery jogs are easy at `Z1–Z2` pace with no time target — finish the 400 m and go again.
- Include Coach cautions, route, equipment, and COROS connection status.
- Execution details explicitly show route `田径场或平路`, equipment `Endorphin Pro 3`, and status `已连接 COROS · PACE 3`.
- Coach stop condition: `若第三组后心率无法在恢复段回落至 Z2 上限以下，立即终止剩余组数并转为冷身，不要硬顶。`
- Coach pacing note: `前两组按下限 4:15 /km 起跑找节奏，第三至五组推进到 4:05 /km 附近，最后一组尽力但不崩。`
- Use a full-width `补给建议` card that supports long Chinese guidance; do not reduce it to a metric tile.
- Fueling copy: `训练前 60–90 分钟补充 30–50g 碳水（如香蕉或能量胶），保证胃内无沉重感。训练中按口渴补水，携带 1 包能量胶备用，第 4 组后若感觉血糖下降可补半胶。训练后 30 分钟内补充 20–25g 蛋白质 + 40–60g 碳水。` Do not include a standalone liquid-volume range.

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
- In long-form guidance, wrap numeric spans such as `60–90 分钟`, `30–50g`, `4:00–4:15 /km`, `6 次`, `800 m`, `400 m`, and `Z4–Z5` with Geist Mono styling while keeping Chinese prose in Inter.
- Body copy uses Inter weight 500, muted text uses Foundation `#9C9C9D`, and reduced-motion preferences disable nonessential scale and motion.
- Use defined typography classes or explicit values: screen title `22px/28px`, labels `12px/16px`, body `16px/26px`, and tabular data `16px/24px`.
- Standard card borders use `rgba(255,255,255,0.06)`. Primary CTA includes the Foundation inset top highlight and dark inset bottom edge.
- Use opaque Foundation surfaces with safe-area environment variables. Do not use backdrop blur, translucent fixed chrome, `shadow-sm`, or a free-floating generic drop shadow.
- Every button and link, including back, overflow, Coach discussion, and watch sync, has a semantic hit area of at least 48 x 48 px.
- The shell uses width 100% and max-width 390 px with no horizontal overflow at 360 or 390 px.
- Repetition block should visually group one work interval + one recovery jog as a set, and clearly show `× 6` repeat count.
- The work-interval pace range `4:00–4:15 /km` should use coral accent color to emphasize the key prescription.
- Do not show estimated finish time or race prediction on this screen.

## Acceptance Checks

- Repetition count `6 组`, work distance `800 m`, recovery distance `400 m`, pace `4:00–4:15 /km`, and heart-rate zones are unambiguous.
- The repeat block visually pairs one work interval with one recovery jog and repeats six times.
- Coach stop condition is present and reads: `若第三组后心率无法在恢复段回落至 Z2 上限以下，立即终止剩余组数并转为冷身，不要硬顶。`
- `补给建议` spans the full content width and the obsolete `400–600ml` metric is absent.
- COROS connection status `已连接 COROS · PACE 3` and the sync action remain visible above the fold.
- The page has no horizontal overflow at 360 px or 390 px.
- Browser inspection reports zero interactive elements below 48 px and confirms top/bottom safe areas use environment variables.
- The top bar and main content use `env(safe-area-inset-top)`; bottom spacing uses `env(safe-area-inset-bottom)`.
- Geist Mono is used consistently for all pace, heart rate, distance, duration, load, set count, and zone range values.
