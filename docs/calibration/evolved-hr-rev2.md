# 演进 v4 个人心率动态拟合 rev2（SPEC #993 / 票 #997，2026-11-16）

本文件是 #997 交付的心率域联合拟合本体说明，从属并不得偏离 [estimation-contract-v2.md](estimation-contract-v2.md)（契约）；速度域本体见 [evolved-speed-rev2.md](evolved-speed-rev2.md)。可执行对应物：`src/go/internal/compute/calibration/evolved_hr.go`（纯联合 seam `FitEvolvedJoint`）、`evolved_estimator.go`（装配 + 快照 + `EvolvedReport.HR` 落点）。行为由 `evolved_hr_test.go`、`evolved_hr_internal_test.go` 锁定。先验数值与 IdentityHash 未改一字（`contract_priors.go` 唯一来源）。

## 模型（契约 §2.2 原样实现）

- 稳态：`Hsteady(v) = Hrest + (Hmax − Hrest)·F(v/v60) + 日效应 + drift·age`，`F` 为契约 knots 的分段线性单调插值（外侧按外段斜率外推，分数钳制 [0,1.05]：静止即 Hrest、稳态不超 ~Hmax）。
- 动态：一阶响应 `dH/dt = (Hsteady − H)/tau`。离散实现：30s 块内解析演化，块均值预测 `ŷ = HSS + (S − HSS)·m(Δ/tau)`（`m(u)=(1−e^{−u})/u` 为块内时间平均因子），块间状态推进 `S ← HSS + (S − HSS)·e^{−Δactual/tau}`（`Δactual` 用相邻收纳块的真实起点差，稳速跨空洞携带）。慢漂移（drift，bpm/天，先验 0±0.5）与日效应（先验 0±2 bpm，[−15,15]）显式分离，不混入 tau。
- 滤波初始化：每条序列首块（或 >60s 覆盖空洞后的首块）为 **init 块**——其观测值设定滤波状态，**不计残差**（每条观测只进联合目标一次：init 块经初始化进入，其余块经残差进入）。

## 联合目标与软反馈（反单向、反循环）

- 联合目标 = T2 速度目标（`evolvedProfile`）**加上** HR 项：`Σ w_k·Huber((y_k − ŷ_k(a,θ))/4bpm)` 及全部 HR 先验项——同一目标、分阶段块状交替优化（`theta | (a,k,delta)`，最多 3 轮，收敛判据 Δa<1e-4 且水平对 <0.01 bpm）。速度侧剖面求解器/曲率/包络机制原样复用（`evolvedFinalizeSpeedReport` 共享），HR 项经 `evolvedFit.hr` 注入剖面目标与 dJ/da（解析灵敏度递推：`dHSS/da = (Hmax−Hrest)·F′(r)·(−r)`）。联合重解在速度 MAP k 附近做**确定性局部 k 精化**（±0.006 粗 0.001 + 细 0.001/21，`evolvedSolveJointK`）：HR 项不含 k，联合最优 k 只能经 a 的小位移耦合漂移，k 的不确定性本就由冻结两端 envelope 承担（实测 200 活动规模与全网格位级同中心）。
- **HR→能力软反馈的通道与界限**：HR 观测在观测速度 `v_k` 处约束 `F(v_k/e^a)`；因 F(1.0)=0.92±0.04 桥接与各 knot 先验（sd 0.04），HR 只能经该有限宽度通道移动 `a`，且 `Hrest/Hmax`（先验 10/12 bpm）会吸收大部分水平差——反馈是**软的、有界的、方向正确的**（合成对照：同速度输入、更高可信 HR → 联合 v60 下移，速度-only 拟合逐位相同）。报告以 `DataCurvature/PriorCurvatureShare` 可复算解释反馈强度；速度报告盖 `joint_hr_refit` 标记。
- **每条观测恰好一次**：HR 块只进 HR 残差项（init 块只进初始化）；verified 参考协议值**不进目标函数**（它作为 measured_reference 中心另行发布，模型预测单独出 `model_center_bpm`）；活动按 LabelID 去重、预算与速度侧同构（**同 root 多活动分摊一个 root 单位 × 同日多 root 分摊一个日单位**，评审 P1-1 修复——换 LabelID 重传共享 root 的同内容不能倍增支持；块间再分摊），重复输入同结果、`InputIdentityHash` 不变。
- **范围传播（单向）**：`HRsteady(v60)` 中心 = `Ĥrest + (Ĥmax−Ĥrest)·F̂(1.0)`；范围 = ①（Hrest,Hmax）信息矩阵（IRLS 权重+先验）在输出方向的 sd 与桥接宽度 `Δ·0.04` 合成，∪ ② v60 范围两端点的条件水平重解（`speed_envelope_low/high_bpm`，公开可查），钳制 [80,230]。速度侧不确定性只会**放大** HR 范围，无反向独立增信。

## θ 条件求解（确定性）

tau 在冻结截断域 [10,180] 上 5s 网格（大输入 >4000 块时 10s 网格并披露 `HR_tau_grid_coarsened_large_input`）；每个 tau 候选下交替：`(Hrest,Hmax)` 精确 Huber-IRLS（预测对水平对仿射：`ŷ = α·Hrest + β·Hmax + γ`，滤波系数精确递推，2×2 闭式解，15 轮封顶，解钳制先验截断域）；日效应/drift 各自单调次梯度 45 步二分（先验收缩内建）；knots 升序坐标搜索（候选 = 先验均值 ±2sd 步长 0.5sd；大输入 ±2sd 步长 2sd），搜索域 `[f_{i−1}, min(m_i+2sd, f_{i+1})`] 保证严格单调。选全目标（数据+全部 HR 先验）最小者。HR 先验常数项对 a 无梯度，只在完整目标口径计入。

## 序列准入与传感器质量

- 活动循环、排序、去重与 `buildCandidateHR` 同构（LabelID/sport/180 天窗）；每活动继承其质量判定：时钟非递增、疑似步频锁定（metadata 标记或步频检测）→ 整根排除（role 记录），root 跨日冲突排除。
- 块准入：HR 覆盖 ≥15s/30s 且速度覆盖 ≥7.5s/30s，块均值 HR ∈ [80,230]、速度 ∈ (0,8.5]；尖峰经 30s 块均值稀释 + Huber(1.5σ) 鲁棒吸收（±9bpm 块级噪声只放大敏感性不动中心）。
- 传感器权重：chest_strap=1，其余（光电/未知）= `OpticalHRWeight`(0.5)，**不拒光电**（reason `optical_HR_downweighted_not_excluded`）。
- 成本护栏：每活动块数确定性封顶 **~40**（保 init 块可略超，均匀跨步，预算单位不变；块间转移用真实 Δt）；总块 >4000 时 tau 网格减半披露；联合重解局部 k 精化 + θ 求解器仿射系数在 IRLS 外一次计算 + **跨轮 keep-best 守卫**（联合目标不变差才接受该轮，把交替下降从实证升级为结构保证，评审 P2-2）。实测 200 活动（8000 块、护栏全开）端到端 ~10s（离线 seam 可接受；速度-only 基线 ~2.4s）。

## 状态、输出与失败

- 状态一律出自 `AdjudicateEstimationContract(DeriveAdjudicationInput(...))`：有域合法序列（光电可）→ `model_estimated`；verified 协议/lab 报告新鲜 → `measured_reference`（中心=参考中位数，模型预测另发）；无序列有 RHR 合格先验 → `prior_dominated`（RHR 经桥接组合中心）；序列全被质量门排除 → 先验组成 + `HR_series_all_excluded_quality_gates`；两者皆无 → `unavailable` + `no_HR_series_or_qualified_physiological_prior`；序列全陈旧（>60 天）→ `stale` 保中心。
- 无速度基准（速度侧 unavailable）时：a 锚定人群先验均值**不**经 HR 单独重优化，reason `speed_basis_absent_v60_prior_only` 如实盖章；v60 先验展宽以「锚点 ±1 个 log-v60 先验 sd 的两端条件水平重解」进 envelope 并入 HR 范围（契约 §2.3/§6，评审 P1-3 修复——此前该分支 envelope 退化为 {center,center}、HR 范围仅剩水平项 ~14 bpm，属失实现已纠正）。
- measured_reference 时中心是协议中位数而 `target_type` 保持模型语义串，以 `measurement_source=measured_reference_median_verified_protocol` 与另发的 `model_center_bpm` 区分（消费端不得把参考中位数读成模型预测，评审 P2-5 注记）。
- 输出（`EvolvedHRReport`）：中心/范围（`model_sensitivity_range_not_probability_interval`）、`target_type=model_HRsteady_at_v60_declared_reference_conditions`（永不称 lab LTHR）、参考条件串（平地/无风/温带不热修正/恒速稳态 ≥6×tau/末 20 分钟 |首末5分钟均值差|≤8bpm/剔除恢复掉点）、fitted `HRmax/Hrest/tau/drift/bridge/knots`、先验+输入 IdentityHash、三档曲率与份额、逐活动 role/sensor/权重/块数、`evidence_date` 与 `latest_rejected_evidence_date` 分离（历史拒绝协议不污染当前理由）。
- 数值失败 = `unavailable` + `solver_numerical_failure`（速度侧求解失败时 HR 不发布中心，速度报告保持 T2 失败语义）。
- 快照 legacy 置信映射（沿 v1 原则：HR 无独立校准不到 high）：measured_reference/model_estimated→medium，prior_dominated/stale→low，unavailable→none。
- 传感器观测尺度等实现参数（σ=4bpm、30s 块、60s 空洞阈、40 块/活动）是 #997 的研究选择，冻结于 `evolved_hr.go` 常量并在此声明；契约先验数值一律读 `contract_priors.go`。

## 真实数据验证边界（票面如实记录）

票面「拿真实留出 HR 序列验证动态预测误差」：T3 只用仓内/合成数据（上列测试）；真实序列验证**推迟到 T7 个人重测**（届时按用户授权走生产只读配方），本票连生产只读访问都未发生。合成参数恢复≠阈值准确率，心率预测误差不是阈值准确率（契约 §8 门槛分离不变）。

## T4（#998）联合条件化——已落地

- 含 HR 序列时，联合拟合**条件化慢结构**：每活动锚 `a_now − trend·age`（trend 来自速度域状态解，冻结），θ 块/keep-best/末轮 polish 重解照 #997 机制原样运行——HR 桥接反馈保持通道；日级偏移留在速度域（与 θ.day 两通道互不折算，契约 §2.3）。末轮 polish 重解使发布锚是发布对的剖面 argmin（#997 潜伏的不对称修复，测试覆盖）。
- `evolvedHRTerm.evaluateFull`/`rowGradients` 暴露对 trend/日效应的解析链（状态求解器使用；联合装配不挂课型分层——它与共享锚共线会吞掉 HR 反馈）。速度报告的 `CapabilityState` stamp 描述速度域解出的完整状态。
