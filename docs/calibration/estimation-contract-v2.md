# 校准估计契约 v2（SPEC #993 / 票 #995，冻结 2026-11-16）

本文件冻结原地演进后 v4 的**估计契约**：联合观测目标、共享参数、条件独立关系、参考条件、状态标签、valid/eligible 判定、可运行先验与默认参数、算法修订标记与发布身份、三道门槛。数值门槛与评估方法冻结在 [evaluation-protocol-v2.md](evaluation-protocol-v2.md)。可执行对应物：`src/go/internal/compute/calibration/contract.go`、`contract_priors.go`、`protocol_v2.go`（测试 `contract_test.go`、`protocol_v2_test.go` 锁定行为）。后续票（#996–#998）实现拟合本体时**不得**偏离本契约；如需偏离必须先改本文件与对应测试。

## 1. 身份与修订标记（不开 v5）

- `algorithm_version=4` 不变；policy `supported_versions=[3,4]` 不变；生产全局 active 仍为 3；v3 冻结七文件（embed 哈希 + golden 双锁）与 v3 入口、结果、协议 v1、原最终留出一字不改。
- 新旧 v4 输出以**算法修订标记**区分：历史 v4 行（PR#740 实现）`algorithm_revision=''`；演进后 v4 输出 `algorithm_revision='v4-rev2-2026-11'`（常量 `EvolvedCandidateAlgorithmRevision`）。身份三元组 `EvolvedCandidateIdentity() = ("evolved_joint_v2", "rev2-research-2026-11", "v4-rev2-2026-11")`。
- 落点：`OfflineResult.AlgorithmRevision`（omitempty，旧策略为空保证 replay hash 不变）、`SourceSummary.AlgorithmRevision`、快照表新列（见 §7）、`EstimationContractDocument`。
- 新策略入口 `StrategyEvolvedCandidate="evolved_candidate"` 仅存在于离线 seam（`EstimateOffline*`），生产 wiring（`NewCalibration`/active 路径）不接触。#996 起该入口装配速度域估计器（`evolved_speed.go`，见 [evolved-speed-rev2.md](evolved-speed-rev2.md)）：普通训练必出有限中心+范围；#997 起同一入口联合装配个人心率动态拟合（`evolved_hr.go`，见 [evolved-hr-rev2.md](evolved-hr-rev2.md)）：普通光电 HR 序列即参与同一联合目标并输出 `HRsteady(v60)`（`model_estimated`），无序列但有合格生理先验输出 `prior_dominated`，两者皆无才 `unavailable`（必须报原因）；数值失败报 `solver_numerical_failure`，不伪称证据不足。

## 2. 观测模型与联合观测目标

### 2.1 速度域（R1）

`log v_i = a − k·log(t_i/3600) − delta_i + eps_i`，其中：

- `a = log v60`（log m/s），`v60 = exp(a)` 为模型一小时能力，配速中心 = `1000/v60` 秒/km（单位契约：`EstimationUnits`）。
- `k ∈ [0.02, 0.10]`（沿用冻结 v3 Riegel 域），`delta_i ≥ 0` 是**未观测努力余量**（log 速度单位），不是可从心率百分比机械换算的实测量。
- 有效时长域 180–7200 s；>7200 s 活动保留原始时长进入单调软约束（`V(t) ≤ V(7200)` + 额外 log 不确定度），不得当无误差一小时换算。已修复的连续片段保留完整时间分母；暂停/恢复不拼接；同活动多时长共享 root，不按独立样本累计支持。

### 2.2 心率域（R2）

- 稳态：`Hsteady(v, 环境, 日效应) = Hrest + (Hmax − Hrest)·F(v/v60)`，`F` 单调非降、由形状先验 knots 约束（§5）。
- 动态：一阶响应 `dH/dt = (Hsteady − H)/tau` 处理滞后；缓慢漂移（多日尺度 drift 项）与速度响应显式分离，不得混入 tau。
- 光电腕式 HR 允许进入联合目标（权重 0.5，`OpticalHRWeight`），不要求胸带或已核验协议。

### 2.3 联合目标与条件独立（反单向、反循环依赖）

联合后验目标 = 速度观测项 + HR 观测项 + 先验项，一次求解：

- **条件独立图**：给定 `(a, k, {delta_i}, Hmax, Hrest, F-knots, tau, 日效应)`，各观测（跨活动根、跨日）相互独立；同一活动的速度观测与 HR 观测**共享** `(a, k, delta_root)`——这正是 HR 对能力/余量提供软约束的通道。
- **HR 不得自由吸收能力尺度**：`F(1.0) = 0.92 ± 0.04`（储备心率分数）是桥接软约束。HRsteady 在 v60 处被钉在 0.92 储备附近，因此 HR 序列只能通过该有限宽度通道约束 `a`，不能任意伸缩 `v60` 来拟合 HR。
- **每条观测只用一次**：HR→相对强度→(a, delta) 软约束与速度→(a, k, delta) 似然在同一联合目标内联合计入，不得先用 HR 推配速再把结果当独立证据增信，也不得把由同一 HR/配速联合推得的阈值 HR 当作独立 LTHR 验证。
- **范围传播**：v60 的估计范围必须传入 HRsteady(v60) 的范围（与 F(1.0)、Hmax、Hrest 的不确定度合成）；单向 `Hsteady(v)` 预测不冒充联合拟合。
- **日效应边界**：日间温度/恢复/传感器偏移进入 `Hsteady` 的日效应项（先验 §5），不得全部吸收进能力 `a`；环境无校准数据时不套统一热修正（limitation 如实标注）。
- **HR 序列的 Selected 语义（#997 实现注记，澄清 T1 评审 P2-1）**：`CandidateHRObservation.Selected` 只标记「已核验参考等级」（verified `field_30min_last20_v1` / `lab_lthr_report_v1` 且新鲜），**不是**普通序列进入联合目标的开关——普通训练 HR 序列按质量准入（时钟、覆盖、疑似步频锁定）进入联合目标，与其 Selected 值无关；`DeriveAdjudicationInput` 的 HR 事实（`HRSeriesValid`/`HRSensorOpticalOnly`/`HRMeasuredReference`）与该语义一致：序列有效性看观测值域与窗口，参考等级才看 Selected+tier。

### 2.4 v60 与 HRsteady(v60) 的参考条件（与实验室量的区别）

- `v60`：**模型推断量**——有界速度-时长域（180–7200 s）内 `log Vmax(t) = a − k·log(t/3600)` 在 t=3600 的值。不是 CS（critical speed，3 参数模型外推），不是任何比赛的实测速度，也不是用户自估。
- `HRsteady(v60)`：**声明参考条件下的模型预测**——参考条件 = 平地、无风、温带缺省环境（不作热修正）、恒速稳态（持续 ≥ `6×tau`，按 tau 先验上界即 ≥ 12 分钟；末段漂移质量规则沿用 v1：|首末 5 分钟均值差| ≤ 8 bpm）、剔除已识别恢复/掉点段。它是"预计在该配速下稳态运行的心率"。
- 与既有参考等级的区别（消费端不得混称）：实验室 `lab_lthr`（乳酸法个体判读，具日期/流程/仪器）、场地代理 `field_hr_proxy`（`field_30min_last20_v1` 协议）、训练 HR（`training_hr`）都是**测量/代理量**；`HRsteady(v60)` 是**模型估计**（target_type 表达模型语义，永不停称生理 LTHR）。参考条件与漂移剔除规则可复算（同输入同输出，时间机器测试锁定）。

## 3. 状态标签（五态）与判定次序

`EstimationState ∈ {measured_reference, model_estimated, prior_dominated, stale, unavailable}`，逐指标（speed/HR 各自判定）。判定次序（`AdjudicateEstimationContract`，冻结）：

1. **unavailable**：无有效输入且无合格先验；或输入物理不可能（全部收纳观测超界/非有限）；或求解失败。必须给 categorical reason。
2. **stale**：有保留估计但全部支持证据早于陈旧窗（speed 90 天 / HR 60 天，常量 `ContractSpeedStaleAfterDays` / `ContractHRStaleAfterDays`）。
3. **measured_reference**（speed）：存在 confirmed/probable 全力锚点；（HR）：verified 现场协议或 lab 报告在新鲜窗内。
4. **model_estimated**：普通训练满足可辨识判据（speed：≥2 独立活动根、≥2 独立日、时长比 ≥1.5，`ContractSpeedModelMinRoots/Days` 与 `ContractSpeedDurationRatioMin`）；HR：有效 HR 序列（光电可用，降权）。
5. **prior_dominated**：其余一切有有效输入/先验的场景——先验主导，**必须**输出有限中心与更宽范围，reason 含 `identifiability_limited_prior_dominated`；全是轻松跑时能力与余量不可分，如实标注，不得伪称个人精确识别。

**范围语义**：非 unavailable 状态必须带有限范围，称"模型敏感性/估计范围"（`model_sensitivity_range_not_probability_interval`）；只有另行覆盖校准通过才可称有指定概率意义的区间。"先验主导"依据（先验 IdentityHash + 输入 hash）可复算；未校准不显示精确可信百分比。

## 4. valid vs eligible（缺全力/缺胸带不排除）

- **valid**（输入有效性）：有限、在物理域内（速度 0<v≤8.5 m/s、时长 ≥180 s、HR 80–230 bpm）、在 180 天窗口内。缺全力标签、光电 HR、缺胸带**不影响** valid。
- **eligible**（评估覆盖口径，事前冻结，见协议 v2）：speed——窗口内 ≥3 个被收纳跑步活动根；HR——有有效 HR 序列或合格生理先验。覆盖率同时报 all-inputs 与 eligible 两口径，不得事后删难样本。
- 硬规则：仅缺全力标记**不是** unavailable 理由（`NeverUnavailabilityReasons()` 明文禁列 `missing_all_out_label` / `missing_chest_strap` / `optical_HR_only`）；缺胸带只降权。

## 5. 可运行先验与默认参数（`DefaultEvolvedPriors()`，全部 research_uncalibrated）

先验即代码：数值、截断边界、单位、出处全在 `contract_priors.go`，`Validate()` 强校验（有限、均值在界内、knots 严格单调、桥接 knot 必须在 rel=1.0），`IdentityHash()` = 参数 hash 进 lineage。**没有"以后再研究"的空入口**——群体/个人数据不足时这些宽研究先验就是默认值，且明确携带 `calibration="research_uncalibrated"` 与 limitations。

| 参数 | 均值 | SD | 截断 | 单位 | 损失 | 出处（动机，不证明准确） |
|---|---|---|---|---|---|---|
| log v60 | ln 3.4 | 0.40 | [ln 1.5, ln 8.5] | log m/s | 截断二次（高斯先验项） | SPEC#993 R1；doi:10.1249/MSS.0000000000002412（CS from training data） |
| k | 0.06 | 0.03 | [0.02, 0.10] | log速度/log时长 | 截断二次 | 冻结 v3 riegel_k 域；R1 |
| delta·confirmed_maximal | 0.01 | 0.02 | [0, 0.25] | log速度 | 类均值二次 + delta≥0 硬约束 | R1（真实测试令 delta 近 0 但不当开关） |
| delta·probable_maximal | 0.03 | 0.04 | [0, 0.35] | log速度 | 同上 | R1 |
| delta·submaximal | 0.18 | 0.10 | [0, 0.70] | log速度 | 同上 | R1（普通训练弱先验） |
| delta·unknown | 0.14 | 0.12 | [0, 0.70] | log速度 | 同上 | R1（课型未知） |
| 历史能力先验 sd | floor 0.15 + 0.002/天 | — | — | log m/s | 老化二次项 | R1（年龄衰减+足够方差；中心永不当速度上限） |
| HRmax | 188 | 12 | [140, 230] | bpm | 截断二次；观测最大值优先 | 群体研究宽先验；观测可覆盖 |
| Hrest | 55 | 10 | [35, 90] | bpm | 同上；daily RHR 行优先 | R2 |
| F knots (rel→储备分数) | 0.55→0.68, 0.75→0.82, 0.90→0.88, **1.00→0.92**, 1.15→0.97 | 各 0.04 | 单调硬约束 | 分数 | 单调 + 二次 | R2；经典强度-HR 分数对齐（研究动机）；1.00 knot = 桥接约束 |
| tau | 45 | 20 | [10, 180] | s | 截断二次 | PMC4687158 一阶 HR 动态 |
| 日效应（Hsteady 平移） | 0 | 2 | [−15, 15] | bpm | 二次 | R2/R3 |
| 漂移 | 0 | 0.5/天 | [−10, 10] 累计 | bpm/天 | 二次 | R2（缓慢漂移显式分离） |
| 光电 HR 权重 | 0.5 | — | (0,1) 开区间 | 相对权重 | 联合目标乘权 | R2（降权可用，不排除） |

历史快照先验规则：`sd = hypot(0.15, 0.002×age_days)`，中心不作上限；同一批输入算出的旧快照不得与原始输入作为两份独立证据反复相乘（同源不双计，T2 实现时按 root 去重）；优先用上一状态或留一活动构造先验。

## 6. 不可辨识与诚实输出

- 全轻松跑：`a` 与 `delta` 仅靠速度不可分 → 先验主导 + 宽范围 + `identifiability_limited_prior_dominated`。
- 只有 HR 无速度基准：F 桥接约束允许输出 `prior_dominated` HR，但 v60 范围必须完整传入（HR 范围不可能窄于 v60 范围 × F 斜率传播）。
- 无 HR 序列且无合格生理先验 → HR `unavailable` + `no_HR_series_or_qualified_physiological_prior`（必须报原因，不用默认常数伪装）。
- 只有弱历史先验 → `prior_dominated`（中心=老化先验，范围=先验 sd 展开），非 unavailable、非 v3 锁定值。
- **合格生理先验的可执行定义（#997 实现注记）**：窗口内（≤180 天）至少一行域值合法（35–90 bpm）的静息心率日行（`HealthRow.RHR`）。宽研究先验本身（HRmax 188±12 / Hrest 55±10）**不**单独构成合格生理先验——那是人人皆有的缺省参数，不是该用户的测量来源；RHR 行是真实用户测量。有 RHR 行而无 HR 序列时输出 `prior_only_HR_estimate` 的 `prior_dominated`（中心 = RHR 经桥接组合，范围 = 先验 sd 展开）。
- **序列全被质量门槛排除**：窗口内有域合法 HR 观测（adjudication 视为有效序列）但每条序列都被质量门（疑似步频锁定、时钟非递增）排除 → 仍输出先验组成估计，reason 附加 `HR_series_all_excluded_quality_gates`，不冒充 model_estimated，也不静默 unavailable。
- **adjudication 与 fitter 准入的口径差（#996 评审 P2-2，#997 收口）**：契约 adjudication 不检查 MeasurementQuality，`FitEvolvedSpeed` 纯 seam 调用者可传入 quality=none 的 selected 连续行——此时全部收纳行被准入拒绝，报告 `solver_numerical_failure` + `all_admitted_rows_rejected_measurement_quality` 双原因（装配路径 `buildCandidateEvidence` 只产 High/Medium/Low，不可达；差异在契约文档显式声明而非沉默）。

## 7. 发布与修订标记契约（解决 (user,day,version) 覆盖冲突）

冲突（#995 探索发现）：`PublishRunningCalibration` 对 (user, as_of_date, algorithm_version) 是 `ON DUPLICATE KEY UPDATE` 覆盖 upsert，与拍板"v4 身份内不覆写旧 v4 历史行"相抵。**拍板解法（已落实现与测试）：修订标记进自然键。**

- 唯一键 = `(user_id, as_of_date, algorithm_version, algorithm_revision)`（GORM `uq_run_cal` priority 4 新列 `algorithm_revision varchar(64) not null default ''`）。旧二进制不写该列 → 默认 ''，与既有 (user,day,version) 行为完全兼容（ADR 0045 的同日重算/幂等语义保留于**同一修订**内）。
- **跨修订不覆写**：不同 revision = 不同行，历史 v4 行（''）对演进 v4（`v4-rev2-2026-11`）不可变。MySQL 测试 `calibration_revision_test.go` 锁定：跨修订两行并存且旧行值不变；同修订同键幂等覆写（同 ID）；读取 tiebreak 维持 `as_of_date DESC, id DESC`（确定性）；revision 字符集校验 `[A-Za-z0-9._-]{0,64}` 拒绝垃圾键值。
- **迁移**：GORM AutoMigrate 只加列不改既有唯一索引，`AutoMigrateWatch` 内新增幂等步骤 `migrateRunningCalibrationRevisionIndex`（information_schema 检查 `uq_run_cal` 列集，缺 `algorithm_revision` 时 DROP+ADD 重建四列唯一索引；新库直接建四列索引，no-op）。部署序列（ADR 0045 更新）：先加列+重建索引 → 再部署新读写者；本文与代码均不执行生产迁移。
- 派生表 lineage（五个 `calibration_provenance_json` 列）不受影响：fingerprint 序列化整快照（含 revision），provenance 冻结语义原样。
- 按用户选择/预览/发布闭环、revision 偏好读取策略 = T5（#999）范围，本契约只保证键空间与历史不可变性。

## 8. 三道门槛（分开验收，不得互替）

1. **工程准入**：#995 六类确定性 fixture、时间机器测试、版本隔离（revision 区分新旧 v4、v3 冻结面与 golden 不破）、来源/恢复测试、防泄漏检查全绿 + 独立 review 修复闭环。通过只解锁后继票与试用候选资格，不代表准确性，更不代表上线。
2. **单用户受控研究试用**：工程准入 + 用户明确知悉 research_uncalibrated 局限并**另行授权** + 按用户隔离与可撤销恢复就绪。允许群体准确性 insufficient。个人授权不能绕过确定性错误、跨用户影响或恢复不可用。
3. **全量/扩大范围上线**：协议 v2 事前冻结的独立准确性门槛达标 + 发布授权。insufficient 持续阻塞；工程通过与个人授权均不可替代。

## 9. 序列化与时间机器（工程验收项）

- `EstimationContractDocumentSnapshot()`：契约全量序列化（身份/单位/状态/先验/哈希/门槛/发布规则），JSON round-trip 无损，`IdentityHash()` 确定性；报告必须内嵌契约 IdentityHash、先验 IdentityHash、输入 hash、协议 v1/v2 hash、v3 源 hash、代码版本。
- 时间机器：`DeriveAdjudicationInput` 只收纳 `event_time ≤ cutoff` 且窗口内的证据；cutoff 之后的输入/标签/HR 观测不改变过去的判定（测试锁定）。未来输入不得改变过去预测。
