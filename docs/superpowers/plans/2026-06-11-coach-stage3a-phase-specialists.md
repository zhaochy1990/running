# Coach Stage-3a — Phase-Specialist Weekly Generator (Design)

> Design-forward doc. The implementation task list at the end is intentionally code-light — it names modules, interfaces, and test intent; the actual code is written at execution time. The substance to review is the **specialist catalog** (§3) and the **tool catalog** (§4).

**Goal:** LLM **phase specialists** (one per `PhaseType`) that each generate a full `WeeklyPlan` (plan.json) for a given phase + week, anchored to the athlete's real paces and validated by the existing S2 `run_rule_filter`. Single-phase-capable: given a `Phase` + its weeks + context, emit one `WeeklyPlan` per week.

**Deferred to Plan 3b:** the structure→all-phases orchestrator, `SeasonPlanBundle`, cross-week season-aggregate rules, real per-phase reviewer, dropping `weekly_key_sessions`, and pushable `NormalizedRunWorkout` specs (3a emits aspirational `spec=None` sessions).

---

## 1. Design principles

- **Specialist = phase-specific coaching expertise, not a label.** Each specialist's prompt carries a phase's full session-design doctrine (§3). A generic 2-sentence blurb is a failure.
- **Reuse, don't reinvent.** Per-week generation reuses `build_generation_graph` (generate → rule_filter → retry-on-violation → reviewer → verdict); per-week validation reuses `run_rule_filter` (7 S2 rules). 3a writes zero new rule logic.
- **Paces are computed, not invented.** The athlete's target paces (z2 / MP / threshold / interval) are derived deterministically from the canonical `running_calibration` snapshot and given to every specialist. The LLM never makes up "5:30/km" — it's told the athlete's actual numbers (§4 `pace_targets`).
- **Aspirational first.** 3a sessions carry summary / date / kind / distance / duration / notes + nutrition, with `spec=None` (not push-to-watch). Structured pushable workouts are a later increment.
- **Specialist designs sessions; it does not do behavioral correction.** Phase-appropriate session design only. Per-athlete habit-coaching (e.g. "this runner drifts into Z4 on easy days") is an in-week feedback concern, out of scope here. The 80/20 *intensity target* stays (it's a design constraint the rule_filter enforces).

---

## 2. Layering

| Concern | Layer | Module |
|---|---|---|
| Specialist prompts + registry; per-week graph wiring | coach **core** (`src/coach/`) | `coach/graphs/generation/phase_specialists.py`, `…/week_graph.py` |
| Tool implementations (DB reads, calibration math, exercise catalog) | **adapter** (`src/stride_server/coach_adapters/`) | `coach_adapters/specialist_tools.py` |
| Per-week LLM call + WeeklyPlan parse; per-phase loop | adapter | `coach_adapters/week_specialist_adapter.py` |

Core holds prompt strings + the closed registry; adapter holds everything that touches the DB / calibration / LLM. `lint-imports` enforced.

---

## 3. Specialist catalog

### 周期化序列（18-23 周系统周期）

```
基础期 6-8wk（有氧耐力 + 力量打底）
 ├─ 冬训：→ 专项期
 └─ 夏训：→ 速度周期（短，提升 5k/10k 绝对速度）→ 专项期
专项期 6-7wk（把有氧转化为马拉松专项：提高 MP，引入 tempo/间歇/MP，周 1 次长距离 30-36km）
巅峰期 2-4wk（推到赛季峰值，无限贴近实战，MP 为主，典型 30-35km @ MP）
减量期 1-3wk（消疲劳 + 修复肌肉 + 储备糖原，race-day 最佳状态）
[恢复期]（赛后 / 周期间过渡）
```

`speed`（速度周期）**仅夏训插入**（base 与专项期之间）；冬训 base 后直接进专项期。`structure_planner`（Plan 2 macro-cycle 模板）据此选阶段序列。
**专项期(build) vs 巅峰期(peak) 的区别**：专项期**发展**马拉松能力（MP/tempo/间歇混合、长跑堆到 30-36km）；巅峰期**巩固/拔高**到峰值（以 MP 为主、贴近实战的 30-35km MP 长跑），不再引入新刺激。English enum 仍是 `build`/`peak`，中文名为专项期/巅峰期。

Every specialist's prompt covers 7 blocks: **①生理目标 ②课程调色板+处方 ③周内骨架 ④强度分布 ⑤周内进展 ⑥配速+volume 锚定(用 §4 的 pace_targets + volume_targets) ⑦伤病感知+反模式.** Summaries below are the *design intent*; the executor writes the full Chinese prompt to this depth.

> **典型训练以「全马目标 300」选手为参照样例**（~90km/wk；配速 min/km：易/z2 ≈ 5:00-5:20、MP ≈ 4:16、阈值/LTHR ≈ 4:00、10k/CV ≈ 3:45、5k/VO2max ≈ 3:35、速度(400m) ≈ 3:15-3:25）。表中的组数/距离是这个参照的值；**其他水平由 `volume_targets`(量) + `pace_targets`(配速) 缩放**——如全马 400(~55km/wk)：VO2max 1km 间歇 `6 组 → ~4 组`、长跑 `35km → ~24km`，配速整体放慢。specialist 拿到一个 *质量 km 预算 + 长跑 km* 后在该预算内填充课程；长跑 = 周量 × 25-33%（受 §5 ≤35% 与 FM 距离下限约束）。

三区时间占比：**易 = Z1-Z2 轻松/长跑**，**中 = Z3 MP/tempo/阈下**，**高 = Z4-Z5 VO2max/间歇**。关键在 build 涨"中区"、speed 涨"高区"、peak 由 MP 主导。

> 这些是面向**通用人群**（进阶业余→竞技）的总体默认占比，依据是训练学（专项化 + polarized/pyramidal 模型），**不针对任何个体**。伤病是**每人适配层**——specialist 读 `context.injuries` 调整动作/坡度/配速，但它**不改变**上面的阶段占比设计。build 增长落在中区(MP/阈值)而非高区(VO2max)，理由是马拉松瓶颈在阈值/专项耐力、VO2max 对马拉松边际收益递减——与个体伤病无关。

所有 specialist 都**必传** `pace_targets` + `volume_targets`（运动员身体状态，注入 prompt，见 §4）；下表 Tools 列只列**按需调用**的 tool。

| Specialist | 中文名 | 生理目标 | 典型训练（节选） | 强度模型（易/中/高 时间占比 + 关键区别） | Tools(按需) |
|---|---|---|---|---|---|
| **base** | 基础期 | 有氧容量 + 力量打底，chronic 缓慢上行 | • z2 长跑渐进至 28-30km<br>• 阈值"引入" 2km * (3-4) @ 阈值配速<br>• 力量 1-2 次(下肢稳定+核心)<br>• 可选短坡技术 | **金字塔**；易~85 / 中~12 / 高~3；质量只到 **Z3 阈值引入**，**无 Z5** | `strength_library`, `recent_training` |
| **build** | 专项期 (6-7wk) | 把有氧转化为马拉松专项能力，提高 MP，chronic 明显上行 | • 长距离 32km(后段 12-16km @ MP)<br>• 阈值巡航间歇 2km * (4-5) @ LTHR / 组间 90s<br>• tempo 40-50min 连续<br>• MP 16-20km @ MP<br>• CV 间歇 1km * (10-12) @ 10k 配速 / 组间 200m | **金字塔偏阈值（混合质量）**；易~68 / 中~25 / 高~7；质量明显高于 base，**MP/tempo/间歇并用发展专项**（区别于巅峰期的 MP 单一主导） | `recent_training` |
| **speed** | 速度周期 | VO2max/经济性/速度储备，夏训发展速度 | • VO2max 1km * (6-8) @ 5k 配速 / 组间 2-3min<br>• 短间歇 400m * (16-20) @ 速度配速(快于5k) / 组间 200m 慢跑<br>• 短坡 60-90s * (8-12) 控制<br>• 中长 18-22km z2 维持有氧 | **两极化(polarized)**；易~75 / 中~8 / 高~17；增长在**高区(真正 Z5 VO2max)**——与 base/build 的**本质区别** | `strength_library`, `recent_training` |
| **peak** | 巅峰期 (2-4wk) | 推到赛季峰值，贴近实战，MP 耐力 + 比赛执行 | • 实战长跑 35km(含 25km @ MP)<br>• 中周 MP 课 16-20km @ MP<br>• 阈值保鲜课 2km * (4-5) @ LTHR（维持，非重点）<br>• 不引入新刺激 | **MP 主导**（赛季最专项）；**MP/race-pace 占周跑量 ~50-65%**（advanced 可达 70%），其余易跑 + 极少高区刺激 | `recent_training` |
| **taper** | 减量期 | 清疲劳保适应，acute 主动下降 | • 周量较 peak 降 ≥25%(分周 -25→-45%)<br>• 短马配唤醒 12-15km(含 6-8km @ MP)<br>• 取消大长跑 | **比赛就绪**；总量大降；保留少量中区(短马配) + 极少高区刺激，无大容量质量 | — |
| **recovery** | 恢复期 | 主动恢复，chronic 主动下行 | • z1-z2 轻松 8-12km<br>• mobility/力量维护<br>• 无质量课<br>• 赛后首周可交叉训练 | 几乎全 **Z1-Z2**(易~98)，中/高 ≈0，无质量课 | `strength_library`, `recent_training` |

> **组数随强度耦合**：同样 1km，10k/CV 配速可 10-12 组、5k/VO2max 配速只 5-8 组（每组更狠）——所以 speed 期 VO2max 组数反而**少于**专项期 CV 间歇。specialist 据 `pace_targets` 的配速决定组数。

> **记号 & 缩写**：训练统一记为 **`单组量 * 组数`**（组数为区间时加括号，`*` 两侧留空格）——如 `4k * 3` = 3 个 4k 长间歇，`1k * (5-6)` = 5-6 个 1000m，`8-10min * (4-6)` = 4-6 组、每组 8-10 分钟。时间制(阈值/tempo)随水平自动缩放；距离制(VO2max/速度)按 `pace_targets` 配速跑。**LTHR** = 乳酸阈值心率；**MP** = 马拉松目标配速；**z1-z5 / 阈值配速** 取自 `pace_targets`。

Common anti-patterns each prompt encodes: 不连续两个硬日；单日长跑 ≤ 周量 35%；recovery/taper 周取消质量课；伤病(跟腱→避陡坡冲刺/下坡/硬地全力、阈值走平路、离心提踵；ITB→臀中肌/髋稳定)以疼痛 ≤3/10 且次日不加重为前提。

**Open design question for you:** is this the right *set* of 6 specialists, or do you want finer types (e.g. a distinct `marathon_specific` separate from `peak`, or a `hill` block)? The registry is a closed enum so adding one = adding a specialist.

---

## 4. 必传上下文 + Tools

两类：**4a 必传上下文**——每次生成都由代码确定性算好、**直接写进 system prompt** 的运动员身体状态（不走 tool-call，让 LLM 清楚看到这个运动员"能跑多快 + 这周该跑多少"）；**4b Tools**——LLM **按需调用**的工具。

### 4a 必传上下文（注入 prompt，每次必传）

#### `pace_targets`（配速表）
- **Function:** turn the athlete's canonical fitness into the concrete target paces a specialist must use, so the LLM never invents paces.
- **Source:** `running_calibration` snapshot (canonical: `RunningCalibrationRepository.fetch_latest()` → threshold_speed_mps / LTHR / pace zones) + the goal race (for goal MP).
- **Computes:** easy/z2 range, MP (from goal time, or derived), threshold/LTHR pace, interval/VO2max (≈5k) pace, rep paces (400/800/1000m). One table per athlete.
- **Output (injected block):** e.g. `z2 5:25-5:50 · MP 4:02 · 阈值 3:48 · VO2max(5k) 3:32 · 1km rep 3:30`.
- **为什么必传而非 tool:** 确定性、可测、每周都要——做成 tool-call 只增加非确定性、无收益。让运动员的配速能力始终在 prompt 里，LLM 决策更清楚。(Eval：同 calibration → 同表，可复现。)

#### `volume_targets`（本周量预算）
- **Function:** turn the week's volume budget + the athlete's level into concrete **session-volume allowances**, so prescriptions scale (全马 250 vs 400 get different rep counts / long-run km) instead of a hardcoded one-size-fits-all.
- **Source:** the week's `target_weekly_km` (from Stage-1's phase band, which already reflects the athlete's capacity) + level signal (CTL / recent weekly km / target time).
- **Computes:** `long_run_km` (≈25-33% of weekly, bounded by the §5 long-run ≤35% rule and the FM peak-distance floor where the week allows), `quality_km_budget` (phase-dependent: base小 / build 中 / speed 中-高区 / peak MP-dominant / taper 少), `easy_km` remainder.
- **Output (injected block):** e.g. `周量 100km · 长跑 30km · 质量预算 18km · easy 52km`. The specialist *fills* the quality budget with phase-appropriate sessions (chooses 10×1000m vs 5×1600m to spend ~quality_km), so rep counts/distances derive from the budget — they're never hardcoded.
- **为什么必传而非 tool:** 同 pace_targets——确定性、每周必用；pace_targets = 配速、volume_targets = 量，两者共同定义运动员当前身体状态。

### 4b Tools（LLM 按需调用）

#### `strength_library`（base / speed / peak / recovery）
- **Function:** return injury-safe strength/mobility exercises (with COROS T-codes) for a requested target, so strength prescriptions are concrete and contraindication-aware.
- **Source:** the COROS built-in exercise catalog (T-codes) + the athlete's preferred-exercise set if present.
- **Inputs:** target group(s) (e.g. `calf_eccentric`, `glute_med`, `hip_stability`, `core`, `thoracic_mobility`) + `injuries`.
- **Output:** list of `{code, name, sets×reps, note}`, with injury-conflicting moves filtered (knee↔深蹲/弓步, back↔硬拉, ankle↔跳跃 — same map as `run_rule_filter.check_injury_conflict`).
- **Why pull:** only strength-prescribing specialists need it, on demand, and the catalog is large — injecting it all into every prompt would be wasteful.

#### `recent_training`（all except taper）
- **Function:** let a specialist drill into what the athlete actually did recently (beyond the injected continuity summary) — e.g. last few weeks' session types, volumes, achieved paces — to sequence the next week sensibly.
- **Source:** `coros.db` activities (reuses the corrected `RUN_SPORT_SQL_LIST` + km-normalization).
- **Inputs:** lookback weeks, optional filter (long runs only / quality only).
- **Output:** compact per-week summary rows.
- **Why pull:** optional drill-down; most weeks the injected continuity block suffices.

**Eval note (carried from spec §9):** tools stay ON in eval, backed by the committed real DB / calibration — the real tool path runs, data is frozen, reproducibility comes from the frozen DB + judge.

**已定**：`pace_targets` / `volume_targets` 为**必传上下文**（注入 prompt，非 tool）。夏训 heat 不做独立 tool，放进 speed/macro-cycle prompt 即可。

**已定（不加 `nutrition_targets`）**：specialist 保持**纯训练**职责，不注入饮食上下文。理由：S1 是**赛季级**计划，细粒度饮食指导（kcal/宏量/餐时机）依赖运动员**近期**身高体重/BMI/体脂等状态，应在 **S2 周计划生成**时按当周身体状态动态给出——那一层能拿到最新体测、可逐周调整。S1 该承载的是**可量化的身体成分 milestone**（见下），不是周级饮食处方。

**已定（S1 每个 phase 设可量化 milestone，锚定运动员实际基线）**：赛季计划在每个 phase 出口设**可量化目标**，两类，都基于运动员**当前基线 + 周期长度**算出**现实**目标值（不堆不切实际的指标）：

- **性能型**——如「当前 5k PB 21:00 → speed 6 周后 5k ≤ 19:30」「专项期末 30km @ MP 达标」。`MilestoneType` 用现有 `TEST_RUN`/`RACE`，`metric="race_time_s_5k"` / `target_value=1170` / `comparator="<="`。
- **体成分型**——如「基础期末体重 ≤ X kg」「专项期末体脂 ≤ Y%」。需 `MilestoneType` 加 `BODY_COMPOSITION`。

这是 **planner（S1）职责**，不经 specialist，复用现有 `Milestone` schema（`metric/target_value/comparator`）。落地见 §6 Task（planner addendum）：① `MilestoneType` 加 `BODY_COMPOSITION`；② planner 上下文注入**双基线**——性能基线（当前 5k/10k/HM/FM PB 或能力预测，源自 race predictions / `running_calibration`）+ 体测基线（`latest_body_composition_scan` → weight_kg / body_fat_pct / smm_kg，身高取 onboarding profile 派生 BMI）；③ planner prompt 指示按 phase 类型与时长设**现实改善速率**的目标（如 speed 期才设 5k 提速目标、base 期设有氧/体重目标；提速/减脂速率符合生理上限）。

---

## 5. Per-week generation flow

```
per week:
  system prompt = WeeklyPlan-JSON-contract           (shared; aspirational spec=null)
                + specialist.guidance[phase_type]      (§3)
                + 必传上下文: pace_targets + volume_targets (§4a) + continuity + prior-week tail + injuries
  → build_generation_graph(generator=specialist_LLM, rule_filter=run_rule_filter, reviewer=stub)
      → LLM → WeeklyPlan.from_dict → run_rule_filter(prev_week_km, injuries)
        → violation? feed back, regenerate (≤3) ; pass? → draft
per phase:
  loop weeks sequentially, threading prev_week_km (weekly_progression) + prior-week tail summary
```

`run_rule_filter` already enforces: weekly progression ≤1.10×, long-run ≤35%, 80/20 intensity, ≥1 rest day, injury conflicts, CTL ramp. The specialist's job is to produce a week that passes these *and* fits the phase doctrine.

**⚠️ Dependency (rule re-tune, fold into 3a):** `check_intensity_distribution` flags "Z4-Z5" via a hardcoded `pace ≤ 270 s/km (4:30/km)` threshold. For a fast runner that miscounts **MP / tempo (Z3)** as high-intensity — e.g. 2:50 MP = 4:02 = 242 s/km would count as "hot", so a build/peak week with the designed ~25% 中区 MP could falsely exceed the 20% cap and be blocked. Fix: make the Z4-Z5 threshold **athlete-relative** — derive it from `pace_targets` (Z4-Z5 = faster than the athlete's threshold pace), not a constant. Without this, the 3-zone design (build/peak heavy in MP) collides with the rule. Added as Task 0 below.

---

## 6. Implementation tasks (code-light; written at execution)

Each task: TDD (failing test → implement → pass → lint → commit). Interfaces named; full code authored during execution.

0. **Re-tune `check_intensity_distribution` to athlete-relative threshold** — `coach/graphs/generation/rule_filter.py`: replace the hardcoded `pace ≤ 270 s/km` Z4-Z5 marker with one derived from the athlete's threshold pace (passed via `rule_filter_kwargs` from `pace_targets`), so MP/tempo (Z3) isn't miscounted as high-intensity. Test: a 2:50-runner build week with ~25% MP passes; a genuine VO2max-heavy week still trips >20%. (Backward-compatible: fall back to the 270 constant when no threshold is supplied.)
1. **Specialist registry + prompts** — `phase_specialists.py`: `Specialist{phase_type, name(中文), guidance, tools}`, `SPECIALIST_REGISTRY`, `get_specialist(pt)`. Test: all 6 `PhaseType`s present; each guidance covers the 7 blocks (depth assertion: contains 生理目标/处方/强度分布/进展/锚定/伤病/反模式 markers, >300 chars).
2. **Weekly JSON contract + prompt composer** — `build_weekly_system_prompt(phase, week_meta, pace_targets, volume_targets, context_block)`（`pace_targets` + `volume_targets` 为**必传参数**）→ shared contract + specialist guidance + 必传上下文. Test: composed prompt carries the contract sentinel, the phase emphasis, **both the pace table and the volume budget**, and the week framing.
3. **必传上下文计算 + Tools** — `specialist_tools.py`: 必传上下文 `pace_targets(user_id, goal, as_of)` (calibration→pace table) 与 `volume_targets(target_weekly_km, phase_type, level)` (周量预算→{long_run_km, quality_km_budget, easy_km}，按水平缩放)；按需 tool `strength_library(targets, injuries)`、`recent_training(user_id, weeks)`. Test each against seeded DB / calibration: pace table derives from threshold; **volume_targets 缩放正确——100km/wk 与 55km/wk 给出不同的质量预算/长跑 km**；strength filters injury conflicts; recent_training aggregates running rows.
4. **Per-week generator adapter** — `generate_specialist_week(state)`: 算好 `pace_targets`+`volume_targets` 并作为必传参数 compose prompt, LLM call, 3-tier parse, `WeeklyPlan.from_dict` validate → `{current_draft}`. Test with fake LLM: valid → parses; garbage → `parse_failed`.
5. **Per-week graph wrapper** — `build_week_specialist_graph(generator, reviewer, rule_filter_kwargs)` over `build_generation_graph` + `run_rule_filter`. Test: generate→rule_filter→verdict wired; violation routes back.
6. **Per-phase loop** — `generate_phase_weeks(phase, weeks, context, injuries)`: sequential weeks, thread `prev_week_km` + prior-week tail; stub reviewer (3a). Test: N weeks → N plans; a rule-violating fake week is blocked (0 results).
7. **Integration smoke** (fake LLM): one phase end-to-end, all weeks `run_rule_filter`-clean; pace table present in the prompt.

**Layering / non-breaking:** Tasks 1-7 are all new modules; no existing file modified; `weekly_key_sessions` untouched (3b). `lint-imports` after each task.

### Planner addendum (S1 milestones — separate layer from specialists)

> 这是 **planner（S1）侧**改动，不属于 specialist 新模块，会改既有 planner 文件（Plan 2 territory）。可在 3a 批次内单独提交，或拆成独立 Plan 2 增量——**待你定**（见 §7.4）。

P1. **`MilestoneType.BODY_COMPOSITION`** — `stride_core/master_plan.py` 加枚举值（additive，diff/legacy 不破）。Test: 枚举存在；带 `metric="body_fat_pct"` 的 Milestone 可构造 + round-trip。
P2. **Planner 双基线上下文** — master context loader 注入性能基线（current 5k/10k/HM/FM PB 或能力预测，源 race predictions / `running_calibration`，**经 reader 不 inline 重算**）+ 体测基线（`latest_body_composition_scan`，身高取 onboarding profile）。Test: seeded DB → 上下文含两基线；缺体测时优雅降级（只设性能 milestone）。
P3. **Planner prompt 指示设现实 milestone** — 按 phase 类型/时长，基于基线设可量化目标（speed→5k 提速、base→有氧/体重、专项→MP 耐力），改善速率符合生理上限。Test（fake LLM 或 rule 校验）：speed phase 产出带 `metric`/`target_value`/`comparator` 的性能 milestone；目标值落在基线的合理改善带内（如 5k 6 周提升 ≤ ~5-8%）。

---

## 7. What to review

1. **§3 specialist catalog** — is the set of 6 right, and is each specialist's doctrine what you'd coach?
2. **§4 必传上下文 + tools** — pace_targets/volume_targets 必传、nutrition 推到 S2、3 个 tool 的 push/pull 划分——对吗？
3. ~~**§1 aspirational-vs-pushable**~~ → **已定：3a 产 `spec=None`（aspirational）**，日历可见/人可执行，push-to-watch 降解延到 3b。
4. ~~**Planner addendum 归属**~~ → **已定：P1-P3 与 specialist 任务一起在 3a 批次内执行**（提交时按层分开 commit：planner 文件改动 vs specialist 新模块）。
