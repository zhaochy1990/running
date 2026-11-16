# 校准评估协议 v2（#993 / #995）

冻结日期：2026-11-16。冻结方式：本文件双拷贝（`docs/calibration/` 与 `src/go/internal/compute/calibration/`）一字不差，域内副本被 `//go:embed` 摘要并以 `testdata/evaluation-protocol-v2.sha256` 双锁。任何门槛变更必须新建协议版本；协议 v1 文档、v1 留出、v1 报告与 hash 一字不改。

## 适用对象与身份

本协议只评分**原地演进后的 v4**（SPEC #993，2026-11-16 拍板不开 v5）：`algorithm_version=4` 不变，`algorithm_revision=v4-rev2-2026-11` 区分新旧 v4 输出；历史 v4 行（revision 为空）是存档，不得重写、不得重包装为新验证。评分对象的行为契约见 [estimation-contract-v2.md](estimation-contract-v2.md)。快照与 lineage 必须携带：契约 IdentityHash、先验集 IdentityHash、输入 SHA-256、协议 SHA-256（v1 与 v2 各自）、v3 源码 SHA-256、代码版本。

## 与 v1 的关系与已知回归

- 协议 v1（`evaluation-protocol-v1.md`）的数值门槛、参考等级、最终留出与"不调参"约束全部保持原样，仍约束 v1 评分与历史报告。
- v4 v1 阶段已用于分析/调参/交付的样本——`testdata/replay-v1.json` 全部合成场景、#983/#991 的个人案例与最终留出、任何参与过 v4 参数选择的私有导出——一律标 `known_regression`。它们只作已知回归（防行为倒退）与探索，不得再声称独立最终验证，不得改标签改报告。
- 新最终留出只能来自**前瞻收集**：内容版本首次可得时间、真实全力协议、独立计时/检测、设备/环境、活动根级预分割。

## 样本、分割与 manifest

manifest 沿用 v1 结构（schema_version=2），活动根级分割为 `train` / `validation` / `final_holdout` / `known_regression`：

- 同一 root 的活动、laps、片段、成绩派生物共用一个 split；跨 split 改 root 一律拒绝。
- 用户内 train/validation/final_holdout 事件时序不得倒序重叠；`known_regression` 免时序约束但单列，不参与任何准确性门槛分子。
- 最终留出完全不调参；先验与默认参数在评分前冻结（先验 IdentityHash 写入报告），不得看结果改先验再评分。
- 每个 `prediction_as_of` 只能读取 `event_time <= cutoff` 且 `available_at <= cutoff` 的输入；strict 模式还必须有不可变首次可得时间证据。无证明、仅事件日期的样本单列 `event_date_retrospective`，不入 strict 门槛。
- 无重叠/时序泄漏声明：参考标签永不进入拟合输入；同一观测在联合目标中只计一次；HR 与配速互推的派生值不得当作独立证据增信（契约文档的条件独立图为准）。违反任一条即报告作废。

## 覆盖口径（all-inputs 与 eligible 双报）

覆盖率同时报告两个口径，禁止事后删除难样本：

- **all-inputs**：窗口内全部有效跑步输入（无全力标签、光电 HR 均在内）。
- **eligible**（事前冻结）：speed —— 窗口内 ≥3 个被收纳跑步活动根；HR —— 存在有效 HR 序列或合格生理先验。
- 工程硬门槛（all-inputs 口径）：演进后 v4 对**缺全力标签**的有效场景必须输出有限、物理合法、带范围的 model/prior 估计；无数据/损坏/数值失败必须显式 unavailable 并报原因。仅缺全力标签或仅光电 HR 不是 unavailable 理由。

## 误差指标与冻结数值门槛

单位：配速误差秒/km（1000/v60 对独立参考），HR 误差 bpm。报告有符号偏差、绝对误差中位数/P90、N/用户数/独立活动数、缺失/失败率、范围宽度与有独立参考时的覆盖率、先验影响（有/无个人历史先验双跑）、趋势滞后/跳变、运行耗时、身份与输入 hash。

最终 strict direct_60min 集（独立真实活动，前瞻收集）：

- ≥30 独立真实活动、≥10 用户，每人最多 20% 权重（按用户等权再对活动平均）。
- 候选绝对配速误差中位数 ≤ 15 s/km 且 P90 ≤ 30 s/km；同时对 v3 非劣：中位数 ≤ v3+1 s/km、P90 ≤ v3+2 s/km。
- 计算失败率 ≤ 1%；all-inputs 覆盖率（有限+物理合法+带范围）≥ 90%。
- 预声明分层：设备厂商、GPS 异常/干净、暂停恢复/连续、全力标签有无、时长类（<3600s / 3600s±20% / >7200s）；每层 ≥10 独立活动、≥3 用户，层内中位数退化 ≤1 s/km、P90 退化 ≤2 s/km；不足则该层 insufficient。

HR（lab_lthr 与 field_hr_proxy 分开，各 ≥30 独立活动、≥10 用户）：绝对误差中位数 ≤5 bpm、P90 ≤10 bpm，且非劣 v3；lab 按方法、field 按设备分层各 ≥10 活动/≥3 用户。联合推算的 HRsteady(v60) 不是独立 LTHR 真值，不进入本 gate，只作一致性诊断。无直接 HR 参考时 HR gate 保持 insufficient。

不确定性与稳定性：用户级整组有放回 bootstrap 2000 次、seed=993994，报告配对绝对误差中位数/P90 差的百分位 95% 区间；同输入重复运行输出 hash 必须逐位一致；输入顺序无关；确定性失败不放宽。

## 三道门槛（分开验收，不得互替）

1. **工程准入**：确定性 fixture（#995 六类）、版本隔离（revision 标记区分新旧 v4、v3 冻结面不破）、来源/恢复测试、防泄漏检查全部通过，且独立 review 修复闭环。通过仅解锁后继票与单用户试用候选资格，不代表准确性。
2. **单用户受控研究试用**：工程准入通过 + 用户明确知悉 research_uncalibrated 局限并另行授权 + 按用户隔离与可撤销恢复就绪。允许群体准确性 insufficient。个人授权不能绕过确定性错误、跨用户影响或恢复不可用。
3. **全量/扩大范围上线**：本协议事前冻结的独立准确性门槛达标 + 发布授权。insufficient 持续阻塞；工程通过或个人授权均不可替代。

## 状态与退出码

沿用 v1 语义：0=完整冻结门槛通过；2=insufficient（标签/人数/用户/分层/严格可得时间不足或评分未支持）；1=输入/分割/hash/算法失败。离线回放成功不等于准确性验收；合成样本不做准确性 bootstrap。
