# 演进 v4 速度域估计器 rev2（SPEC #993 / 票 #996，2026-11-16）

本文件是 #996 交付的速度域拟合本体说明，从属并不得偏离 [estimation-contract-v2.md](estimation-contract-v2.md)（契约）与 [hour-capability-v1.md](hour-capability-v1.md)（历史 v4 行为存档）。可执行对应物：`src/go/internal/compute/calibration/evolved_speed.go`（纯拟合 seam `FitEvolvedSpeed`）、`evolved_estimator.go`（装配 + 快照 + HR 接缝）、`strategy.go`（`StrategyEvolvedCandidate` 分支）。行为由 `evolved_speed_test.go`、`contract_test.go`、`strategy_test.go` 锁定。

## 模型与求解

- 观测模型（契约 §2.1）：`log v_i = a - k*log(t_i/3600) - delta_g(i) + eps_i`，`a=log v60`，`k∈[0.02,0.10]`（冻结 v3 域），`delta≥0`。
- **delta 按 (活动根 × 课型) 分组共享**（契约 §2.3 的 `delta_root`）：同一活动同课型的多时长窗口共享一个努力余量（一次课的努力水平是会话级事实，best-effort 窗口族近似以同一余量缩放）；跨课型窗口（如验证过的全力测试窗口 + 普通窗口）分开各自的 delta。
- 鲁棒 MAP：Huber(1.5) 似然 + **契约全量先验项**（log v60、k、各课型 delta、历史快照——`contract_priors.go` 为唯一数值来源，未改任何先验数值，先验 IdentityHash 不变）。k 的截断二次先验（mean 0.06 / sd 0.03 / 域 [0.02,0.10]）进目标：弱可辨识的时长衰减会被先验从域边界拉回（评审 P1 修复）。>7200s 活动保留原时长，只进 `V(t)≤V(7200)` 单调软约束（额外 log 不确定度 0.15），不当无误差一小时换算。
- **确定性精确求解**：固定 k 时对 (a, {delta}) 联合凸；对 a 的剖面目标 `J*(a)=min_delta J(a,delta)` 用 Danskin 次梯度做 60 步二分（每次探测把所有组余量重解到该探测点，凸偏最小化保证次梯度单调），k 在固定粗网格（步长 0.001）+细网格（约 0.00005）上扫描。无随机性、无输入顺序依赖；同一输入位可复现。**大输入护栏（评审 P2-4）**：收纳观测数 > 400（生产 180 天窗 ~250 root 规模）时 k 网格确定性减半（粗 0.002 / 细 ~0.0002），报告以 `k_grid_coarsened_large_input` limitation 与实际 `solver_k_grid_resolution` 披露；实测 750 观测从 ~4.5s 降到 ~2.4s，中心差异 ~3e-5 m/s。
- 历史快照先验：`sd=hypot(0.15, 0.002*age)`，目标函数中恰好计入一次，中心不是速度上限；同源旧快照与原始输入不重复增信（先验项只有一项、原始证据按 root×duration 去重、root×day 预算）。

## 可辨识性与诚实范围

- 能力的**绝对水平只能经余量先验识别**（速度数据只钉住 `a-delta_g` 与 k 结构）；confirmed 全力窗口的紧先验（sd 0.02）与 `delta≥0` 硬界把 a 钉在观测附近——这是"近全力改先验、不当开关"的机制实现。
- 敏感性：对全剖面 `J*(a)` 与数据-only 剖面 `D(a)` 取**单侧**二阶差分（最优点常落在 `delta=0` kink 上，对称差分会低估）：范围用全剖面两侧中**较小**曲率（保守、更宽），主导份额用数据-only 两侧中**较大**曲率（数据真正说话的一侧）。
- **类相关先验封顶**：有效曲率 `eff = min(J*'' , D'' + a先验 + Σ_课型 1/s_c²)`——某课型的个人余量是一项研究事实，不是每个窗口一条，重复轻松课不能把范围缩到伪造的高支持（全 easy 的 sd 下限 ≈ `1/sqrt(1/0.40² + 1/0.10²)` ≈ 0.097 log 单位，约 ±10%）。
- `prior_curvature_share = 1 - D''/eff`，≥0.5 时 reasons 追加 `prior_share_at_least_half_effective_curvature`（与契约五态的 `identifiability_limited_prior_dominated` 互补，可复算：先验 IdentityHash + 输入 IdentityHash + 曲率数值全在报告里）。

## 贡献预算与去重

- 复用 `buildCandidateEvidence` 的清洗/暂停/恢复/全活动 elapsed 判定（[candidate-segments-v1.md](candidate-segments-v1.md)）；连续窗口保留真实时间分母。
- 权重 = `2^(-age/90)`，再按 `(root 内窗口数 × 该 root 所在日的 root 数)` 分摊：同活动多时长共享一个 root 单位、同日多活动共享一个日单位；贡献份额 `weight/Σweight` 逐观测入报告。重复 root+duration 窗口丢弃（`duplicate_root_duration`），root 跨日冲突整根剔除。
- 同样本重复输入 → 位级同结果；未来日期证据不进入（时间机器保证）。

## 状态、输出与失败

- 状态由契约 `AdjudicateEstimationContract(DeriveAdjudicationInput(...))` 决定（fitter 不自造状态）：`measured_reference`（有 confirmed/probable 锚）/ `model_estimated`（≥2 根 ≥2 日 时长比 ≥1.5）/ `prior_dominated` / `stale`（90 天）/ `unavailable`。
- 快照 legacy 置信映射：measured_reference→high、model_estimated→medium、prior_dominated/stale→low、unavailable→none；未收敛解 high 降 low。缺锚点结构性到不了 high。
- 输出：中心（m/s 与 s/km=1000/v60）、范围（先验支撑域 [ln1.5, ln8.5] 内钳制）、MAP k 与（可辨识时）RiegelK、剖面 sd、三档曲率与份额、先验/输入 IdentityHash、逐观测角色/权重/份额/余量/残差、求解探针数。
- **RiegelK 发布判据与五态判据的时长口径差（披露，代码不动）**：RiegelK 发布判据用 fitter 侧时长口径——>7200 s 行只作 `V(t)≤V(7200)` 单调软约束、不计入 Min/MaxDurationS（`evolved_speed.go`）；裁决五态（`AdjudicateEstimationContract`）时长口径计入全部连续行（含 >7200 s，`contract.go`）。长活动独占最大时长时可出现 state=`model_estimated` 而 RiegelK 不发布（保守少发布方向，无诚实性伤害）；两口径对齐会扩大 RiegelK 发布面、属行为变化，留后续票+行为测试收口。
- 数值失败（非有限、非正曲率、先验集损坏）= `unavailable` + `solver_numerical_failure`，中心为 nil，不伪称证据不足。

## T3（#997）接缝——已落地

- `OfflineResult.Evolved.HR`（`EvolvedHRReport`）由 #997 的联合拟合（`evolved_hr.go` / [evolved-hr-rev2.md](evolved-hr-rev2.md)）填充：普通光电 HR 序列进入**同一**联合目标（速度剖面目标经 `evolvedFit.hr` 注入 HR 项与 dJ/da），HR→能力软反馈经 `joint_hr_refit` 标记与联合曲率披露；快照 `ThresholdHR` 携带联合中心。`estimator_implementation_pending_t2` 语义随实现落地移除。
- 速度侧的 `PosteriorSDLogV60`/范围经 `speed_envelope_low/high_bpm` 条件重解传入 HR 范围（单向传播）；`FitEvolvedSpeed` 仍是纯 seam 且无 HR 时位级不变，求解/曲率/包络段抽为 `evolvedFinalizeSpeedReport` 供联合重解共享（行为不变，T2 测试全绿）。
- #996 评审 P2 顺手清理落在本票：k 先验失败路径披露实际网格（`evolvedSolveMAP` 失败返回携带 `gridResolution/gridCoarsened`）、adjudication/准入质量口径差以 `all_admitted_rows_rejected_measurement_quality` 双原因显式化、metadata 派生标签替换硬编码、PriorOnce 数值断言（先验-only 中心=闭式精度加权组合）。

## T4（#998）接缝——已落地

- 联合装配（`FitEvolvedJoint`）内每条观测使用活动时点有效能力 `a_i = a_now − trend·age_i + dayShift[d_i]`；纯 `FitEvolvedSpeed` seam 保持标量 a **位级不变**（`evolvedAdmitObservationsMode` 的 allValid 模式仅状态路径使用——v1 top-3/时长池选拔是「挑快挑新」平台机制，状态路径改用全有效池 + fitter 自身去重/预算）。时间结构、求解器、研究先验与诚实边界见 [evolved-state-rev2.md](evolved-state-rev2.md)。
- `HistoricalCapabilityPrior` 增加可选 `TrendPerDay/AsOfDate/InputFingerprint`（预测通道 + lineage，零值位级不变）；prior-only 分支输出 predict-only 状态 stamp。
- `evolvedFinalizeSpeedReport` 共享路径增加状态 stamp（`CapabilityState`）并在敏感性/包络探针前后保存-恢复状态；`evolvedSolution` 携带 trend/dayShift/classShift 快照供 keep-best 恢复。
