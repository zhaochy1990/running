# 演进 v4 时间结构化能力状态 rev2（SPEC #993 / 票 #998，2026-11-16）

本文件是 #998 交付的能力状态时间更新本体说明，从属并不得偏离 [estimation-contract-v2.md](estimation-contract-v2.md)（契约）；速度域本体见 [evolved-speed-rev2.md](evolved-speed-rev2.md)，心率域联合拟合见 [evolved-hr-rev2.md](evolved-hr-rev2.md)。可执行对应物：`src/go/internal/compute/calibration/evolved_state.go`（状态求解/装配/stamp）、`evolved_speed.go`（剖面目标的每观测有效能力、按模式准入）、`evolved_hr.go`（联合装配的条件化）。行为由 `evolved_state_test.go` 锁定。先验数值与 IdentityHash 未改一字（`contract_priors.go` 唯一契约来源；状态研究先验冻结于 `evolved_state.go` 常量并在此声明）。

## 模型与目标（同一联合目标内）

- 每条速度观测使用其活动时点的有效能力：`a_i = a_now − trend·age_i + dayShift[d_i]`；HR 观测的相对强度 `r = v·exp(−a_i)` 同源（近期可比 HR-速度证据更新状态）。`a_now` 为 as-of 时点锚（报告中心）。
- **先验尺度分离**承担 R3「基线变化与日间噪声分离」：多周平滑漂移对 trend 先验（0±0.0005 log/天，钳 ±0.003）便宜、对日先验（0±0.02 each，钳 ±0.15）昂贵；单日天气/疲劳/传感器偏移是一条便宜日效应。日效应粒度：不同证据日 ≤60 按日、超过按 ISO 周（确定性成本护栏，stamp 的 `effect_resolution` 披露）。
- **状态研究先验在两种目标模式恒开**（与 `delta ≥ 0` 同类的结构正则：没有它们 (trend, dayShift) 脊线不可辨识）；`contract_priors.go` 的契约先验集与其 IdentityHash 不变。

## 求解（确定性，两级装配）

1. **速度域全池一次求解**（`evolvedSpeedStateResolve`，`FitEvolvedJoint` 内先于 HR 分支）：准入采用**全部有效连续窗口**（v1 每-时长-池 top-3 选拔正是本票要移除的「挑快挑新」平台机制的证据层来源；fitter 自身 root×duration 去重 + root/day 贡献预算防增信）+ **状态权重策略**（除掉平稳准入的按龄时效因子 `2^(−age/90)` 权重衰减与 `age×0.001` sigma 膨胀——它们以「测量陈旧」建模能力漂移，显式 trend 状态下双计会抹掉趋势信号并重新引入滞后；预算语义不变，stamp `weight_policy` 披露）。求解 = (a_now, trend, dayShift[, 课型共同余量 s_c]) 一个线性-高斯 IRLS 系统（Huber/铰链行 + 余量响应（Schur）因子 + 全部状态先验；步进减半线搜索阻尼）对每组余量二分的交替——共线方向在**一次线性解内**解决（先后尝试过的纯标量块交替会在 a↔s_c、trend↔day 共线上停滞）。k 在平稳 MAP k 附近局部确定性精化（`evolvedSolveJointK`）。**分层课型余量 s_c 仅在此速度域解装配**：它与共享能力锚对一切共模信号共线——包括 #997 HR 桥接反馈——含 HR 时不得挂（见下）。`s_c` 的意义：N 条同类窗口对能力水平的拉力按一个课型先验精度计（T2 曲率封顶的点估计延伸）——**仅 easy 不强制下调**的机制。
2. **含 HR 的联合重解条件化慢结构**（`evolvedHRJointSolve`）：联合交替按 #997 机制原样跑（θ 块 vs (a,k,δ) 块，keep-best，**末轮 polish 重解**使发布锚是发布对的剖面 argmin——趋势耦合暴露并修复了 #997 潜伏的「上一轮 θ 的解」不对称），每活动锚为 `a_now − trend·age`（`trendOnlyFrozen`）：HR 桥接反馈保持其通道；**日级偏移不进联合**（与 θ.day 两通道互不折算）。速度报告的 CapabilityState stamp 描述速度域解出的完整状态（trend+日效应+预测通道）。
3. **失败回退**：状态扩展数值失败 → 保留平稳中心 + limitation `capability_state_solve_failed_stationary_center_retained`（不销毁估计、不伪造状态）；联合本体失败仍按 #997 语义报 `solver_numerical_failure`。

## 敏感性与范围

- 曲率探针在**钉住 a 的探针点上重最小化状态**（trend/日/课型与余量，`evolvedStateProfileJ`）——对慢方向边际化而非条件化；冻结（联合）态则按 #997 剖面条件化（速度域报告已经边际化过自己的解）。类先验封顶公式不变；同源 prior 双计防护：先验恰一次、有效曲率增量 ≤ 1/sd_aged²、数据曲率不变（测试锁定）。
- k 包络、范围语义（model_sensitivity）、五态判定（`AdjudicateEstimationContract` 不变）、快照置信映射全部沿用。

## 固定顺序更新与 lineage（可审计）

- `HistoricalCapabilityPrior{TrendPerDay, AsOfDate, InputFingerprint}`（全部可选，零值=位级 #996 语义）：预测中心 `log(V60)+clamp(TrendPerDay)·AgeDays`，恰入目标一次；stamp 的 `prior_prediction` 回显（中心/sd/年龄/使用趋势/来源 as-of/输入指纹）。
- 无新增可比证据 → predict-only stamp（`prior_predict_only` + reason `no_new_comparable_evidence_capability_predict_only`，DistinctDays=0）。
- 重建 = (事件集, as-of) 的纯函数：同输入位级幂等、乱序/拆批/迟到输入按事件时序重建一致、未来输入不影响过去（时间机器，测试锁定）。重复输入不越算越确信：root×duration 去重、root/day 预算、类先验封顶、同源 prior 单计。

## 诚实边界（如实记录，不假称精准）

- 单活动日上「日效应 vs 课型余量」的切分本质不可辨识（日先验 0.02 比余量先验 0.10 更紧，±2-3% 的日偏移由余量吸收）；可观测保证是**偏移不进 trend/能力**（天气/疲劳 fixtures 锁定 trend≈0、中心在真值、范围较无偏移窗口变宽）。持续性来源系统偏移（设备/场地）与 trend 部分不可分，无校准证据时不做精准修正，只经状态不确定性放大范围。
- 状态权重策略改变的是估计的时序语义（趋势可辨识）；报告的 `InputIdentityHash` 仍是准入身份（与状态权重策略共同构成可复算配方，`weight_policy` 披露）。
- 联合解的成本护栏基线：200 活动（8000 HR 块、护栏全开）联合+状态端到端 ~10-11s（T3 基线 ~10.4s；速度域状态解为纯速度剖面，成本低）。

## 留给 T5（#999）的接缝

- `EvolvedSpeedReport.CapabilityState`（`*EvolvedCapabilityStateStamp`）是策略/预览/发布入口应携带的时间结构块；`prior_prediction` 的 lineage 字段（`SourceAsOfDay`/`SourceInputFingerprint`）供 T5 组装状态链（上一状态 → 预测 → 更新）。
- `HistoricalCapabilityPrior` 新字段由调用方（T5 的重算入口）从上一快照构造；`EstimateEvolvedOffline(history, asOf, health, metadata, prior)` 是按 as-of 重算的幂等入口（同一事件集位级同结果）。
- 快照/summary 未新增字段（`CapabilityState` 留在 Evolved 报告内）；T6 展示若需要 trend/日效应，读 Evolved 报告而非 summary。
