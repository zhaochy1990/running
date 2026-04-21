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

### Baseline assessment 2026-04-20 (11-item test)

| # | 项目 | 左 | 右 | 标准 | 评级 |
|---|------|-----|-----|------|------|
| 1 | 单腿靠墙静蹲 | 46 s | 30 s | 60s+ | 🔴 右腿弱35% |
| 2 | 单腿提踵 (2s tempo) | 19 | 18 | 20-25+ | 🟡 偏弱 |
| 3 | 单腿枪式深蹲 | 0 | 0 | — | ⚫ 预期内 |
| 4 | 单腿臀桥保持 | 20 s | 20 s | 45-60s+ | 🔴 严重弱 |
| 5 | 平板支撑 | 1:36 | — | 2:00+ | 🟡 偏弱 |
| 6 | 侧平板 | 59 s | 63 s | 60s+ | 🟢 合格 |
| 7 | Dead Bug | 8 (L手R脚) | 10 (R手L脚) | 15-20 | 🟡 偏弱 |
| 8 | 哥本哈根侧平板 | 15 s | 19 s | 30-45s+ | 🔴 严重弱 |
| 9 | 单腿闭眼站 | 34 s 不稳 | 43.5 s | 30s+ | 🟡 左侧差 |
| 10 | 踝背屈 | 11.8 cm | 12.3 cm | 10cm+ | 🟢 活动度正常 |
| 11 | Thomas 测试 | 大腿不能低于水平，膝盖可自然弯曲（两侧） | | | 🟡 髋屈肌紧、股直肌不紧 |

**关键结论**：
- **踝活动度正常**（>10cm）→ 跟腱/脚踝康复重心是 **stability**，不是 mobility
- **三大短板**（按优先级）：
  1. 臀肌耐力（20s 臀桥）— 30km+ 跑崩最直接的力学源头
  2. 内收肌（15-19s 哥本哈根）— 单腿支撑稳定的缺失环节
  3. 右腿稳定力量（单腿靠墙静蹲 30s vs 46s，L/R 差 35%）
- **髋屈肌紧**（Thomas 阳性）但 股直肌不紧（膝可弯）→ 重点拉 髂腰肌，不用强调股四头肌
- 左脚踝稳定性差 + 左腿闭眼站不稳，建议确认是否与跟腱止点肌腱病同侧

**Phase 1 力量训练重点**：臀桥等长递增 + 哥本哈根递增 + 右腿单侧补差 + 左踝稳定性 + 髂腰肌拉伸

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
