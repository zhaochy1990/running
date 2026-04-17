# zhaochaoyi — Athlete Profile

Loaded on demand when Claude touches any file under `data/zhaochaoyi/`.

## Goals & Baseline

- **Target**: Marathon 2:50 (4:02/km), Half 1:21 (3:50/km) — October 2026
- **PB**: Marathon 2:59:22 (March 2025), Half 1:27:42 (Nov 2024)
- **Fitness snapshot**: VO2max 57-58, LT pace ~3:50/km, RHR ~47, Running Level ~92.9
- **Equipment**: COROS PACE 4
- **Volume**: 5-6x/week, 60-80 km target (recovery weeks 32-34 km)

## Known Issues (Long-Term)

- **跟腱止点肌腱病** (Achilles insertional tendinopathy) — chronic, monitor with morning pain score; T1275 single-leg eccentric calf raise is gold standard but start light while flaring
- **髂胫束旧伤** (ITB syndrome history) — T1317 clamshell as standing prevention
- **Easy-day discipline**: tends to run too hard on easy days (~27% in Z4 historically, target <20%). When planning, reinforce Z1-Z2 discipline.

## Mobility / Stability Weaknesses (identified 2026-04-17)

1. **胸椎灵活性差** — limits arm swing, breathing depth, torso rotation
2. **脚踝稳定性差** — compounds Achilles issue, late-race foot arch collapse
3. **髋关节活动性差** — shortens stride, quad over-recruitment, likely contributor to the 30km+ late-race collapses in 2026 marathons (1/19, 3/29, 4/12)

These three + existing injuries form a connected动力链 risk chain. Fixing mobility/stability is prerequisite for 2:50.

### Preferred COROS built-in exercises (sportType=4)

| Target | Code | Exercise | Usage |
|--------|------|----------|-------|
| 胸椎 | T1248 | thoracic_spine_rotation | Daily, 3×10/side |
| 胸椎 | T1234 | cat_cow_stretch | Daily, 3×30s |
| 全身动态 | T1262 | greatest_stretch | Pre-run, 4×6/side |
| 髋 | T1244 | glute_stretch | Post-run, 4×30s/side |
| 髋 | T1274 | lunge_stretch / hip flexor | Post-run, 4×30s/side |
| 髋 | T1222 | leg_swing_front_and_back | Pre-run, 3×30s/side |
| 髋 | T1263 | lateral_leg_swings | Pre-run, 3×30s/side |
| 臀中肌 | T1317 | clamshell | Strength day, 3×15/side |
| 踝 | T1326 | banded_ankle_inversion | Daily, 3×12/side |
| 踝 | T1327 | banded_ankle_eversion | Daily, 3×12/side |
| 踝 | T1345 | bosu_single_leg_hold | Strength day, 3×30s/side |
| 小腿/跟腱 | T1275 | single_leg_calf_raise (eccentric) | Strength day, start 2×8/side |
| 胫骨前肌 | T1318 | tibialis_raise | Strength day, 3×15 |

### Weekly strength structure (from Week 0 / 2026-04-20 onward)

- **力量 A** = 下肢稳定性主场 (ankle + hip stability)
- **力量 B** = 核心 + 灵活性主场 (thoracic + hip mobility)
- Plus daily 8-10 min mobility routine (pre-run activation + post-run/bedtime static)

## Collaboration Rules (for this athlete)

- Always `PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync` before answering load/status/fatigue questions
- Easy runs generally 10 km+ (guideline, not hard rule) — avoid too-short runs
- Pushed workouts use `[STRIDE]` prefix, no warmup/cooldown segments
- When plan changes mid-week, check COROS watch state and re-push to stay consistent
- Feedback auto-sync: after each `sync`, scan activities with `sport_note` for the current week and append to `logs/{week}/feedback.md` verbatim
