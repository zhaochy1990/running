# T5 独立 HR 支持（#988）

仅 `StrategyCandidate` 的 `EstimateOfflineWithEvidence` / `Replay` 使用 `independent_hr_v1`；生产 `ModelVersion=3`、源码摘要、golden 和 T2 `segments_only` 完整结果保持冻结。速度继续由 T4 一小时能力模型估计，输入中没有 HR；HR 路径不读取阈值速度，不把 HR 再作为速度模型的独立验证。HRmax、RHR 和现有 zones 纯算法不修改。

参数 `hr-v1-conservative-research` 是保守研究选择，尚未由足够独立训练/验证数据标定；不是概率，也不证明生理阈准确性。缺直接支持时 `ThresholdHR=nil`、confidence=`none`，不会为了 zones 凑数。候选仍 shadow/offline、`release_ready=false`。

## 三层目标与输入

`CandidateMetadata.HR` 是单独准入的历史输入，不是 `ReplayReference`。它沿用 T3 的活动/root 绑定、来源版本、opaque evidence ref、metadata 全字段可得时间和冲突拒绝；Replay 继续实施精确 cutoff、strict 可得时间证明、活动根级留出与 hash。当前 reader 不会猜测 HR sensor、实验室方法或全力协议；缺失保留缺失。没有新增生产写接口或手动覆盖功能。

- `lab_lthr`：只有 `lab_lthr_report_v1`、已核验、80–230bpm 的独立检测结果、报告日期与绑定活动日期一致、判读方法、仪器、source version 和 audit ref 齐备才可用。报告是已经可得的历史检测输入；被留出的检测结果只能作为 Reference，不能转为 input。它不要求把实验室 stage 伪造成连续逐秒 HR。输出 `target_type=lab_method_specific_LTHR`；只聚合**最新已准入实验室报告所对应的方法**，其他方法及 field 观测留在报告中、明确未入选，不能平均成统一生理真值。若最新民用日有多个方法且无法证明报告先后，显式返回方法歧义/缺失，不按活动ID任意选择。没有 lab 参考不得声称已验证生理 LTHR。
- `field_hr_proxy`：`HR.protocol=field_30min_last20_v1`、已核验、`sensor=chest_strap`，加 T3 精确绑定的 `continuous_maximal_test_v1` 30min 全力协议（`DurationS=1800`，起止严格相差1800s、来源/ref齐备）。全程HR有效覆盖>=95%、最大缺口<=5s；标量只取**末1200s时间加权平均**，不受最初10min的正常HR滞后影响。输出 `target_type=field_HR_proxy_not_physiological_LTHR`，不能叫生理乳酸阈。非胸带不满足本冻结协议。
- `training_hr`：普通训练、稳定次极限、全力60min平均HR、无可信协议或协议质量失败的HR只留质量/解释观察。即使稳定、恰好靠近估计阈值配速，也不产生独立阈值支持。未经协议验证的“高HR”不升级努力程度。

`CandidateHRReport` 提供目标类型、reference tier、协议/参数版本、数据截止时刻、实际选用证据日、实验室方法、支持理由、独立root/day数及不足。每条观察提供来源/ref、事件日、提取窗口、measurement kind、实验室方法/仪器、努力支持、覆盖/缺口/漂移及拒绝原因；不输出逐点HR、cadence、备注、GPS或活动对象。`audited_lab_report` 的 quality coverage 不适用（为0），不能误读为逐秒覆盖；报告值来自已核验检测，而非合成timeseries。

## 质量与独立性

HR 时钟沿用 candidate 的 timestamp 优先、否则 elapsed 规则，协议/cadence 必须使用**相同原始时钟坐标**；不压缩暂停、不拼恢复段、不补造采样。仅相邻间隔<=5s且两端80–230bpm的有效点作梯形积分；覆盖的分母始终是完整协议/提取时长。非单调/缺失时钟、显式中断以及同域现有片段清洗器发现的协议内连续性断点均拒绝现场支持。实测速度只用于发现暂停反证，不读取估计配速或用速度邻近增加HR支持；没有速度测量时依靠已核验连续协议及HR覆盖，不能把缺速度变成额外证据。

末20min的质量门禁：相邻有效点突变>15bpm、首尾各5min均值之差绝对值>8bpm、全段HR范围>20bpm、连续30s均值相对此前峰值下降>10bpm，均作为可疑尖峰/热漂移/恢复反证。它们是未校准的保守拒绝阈值，不能诊断具体生理原因；可能拒绝真实测试。最初10min只检查覆盖和连续性，不因正常HR爬升否定协议。

可选 `CandidateHRMetadata.Cadence` 使用同一时钟、单位为整步/min；至少300s有效配对中，HR与cadence两端相差<=3、匹配比例>=80%时标疑似锁步，或接受明确已审计的 `SuspectedCadenceLock` 反证。cadence重复时刻冲突不用于判断。未提供cadence不能声称已排除锁步，报告保留限制；不会从仅有HR的恒定值猜造cadence。

沿用180日观察窗口，60日内协议才支持当前标量，陈旧观察仍保留、标量不静默沿用。相同root跨日矛盾整根拒绝；同root只入选一次，同日多个root先取日中位数，再取跨日中位数，避免重复活动/密集同日测试占据中心或支持。单独一个root/day为low；>=2独立root且>=2日为medium；任意入选结果相差>6bpm降low并记录冲突。本研究版最多medium，重复协议也不凑high，更不表示生理准确性已验收。不同lab方法永不混合。

## 确定性验证与 zones

在公开 seam 逐个 red→green 实现：末20min独立于配速中心、低/快配速不制造支持、HR滞后与不等间隔时间加权、掉点/尖峰/锁步/漂移/平滑恢复、HR仍高时的实测暂停反证、晚到/未核验/冲突metadata、陈旧与缺证据、lab方法/仪器/日期与方法分层、重复root/day和跨日别名。Replay检验HR metadata进入input hash、Reference不进入输入、晚到/未知严格可得时间及留出HR协议排除。

`ComputeTrainingZones` 保持冻结：有独立HR标量时HR zones无需配速、RHR或HRmax，置信度跟随HR；无LTHR但有有效RHR+HRmax时仍是显式low的HRR回退；缺两者之一保持缺失。pace zones仍只依赖速度，不由HR推造。测试对照其他baseline及v3/T2完整结果，冻结源码/hash/golden无修改。

## 真实输入验证与解释

原252场和另含69场可靠暂停metadata的manifest均完整回放，与各自T4已提交报告比较v3/T2完整结果；T4小时模型及原evidence pool（除新增HR报告外）保持不变。两组都没有已核验的lab/30min field协议，因此candidate HR中心缺失、支持none，训练HR观察可查。这是诚实缺失，不能用来声称HR误差降低。

11/10的约158bpm是旧最快一小时窗口的平均HR，反映那段实际努力；不是独立LTHR检测。新诊断按整场录制单独计算的平均HR可能不同（同日主录制约156.47bpm），不能将两种窗口混作相同统计量。旧v3快照约166.56、页面四舍五入约167bpm来自速度附近段落的旧规则；它与158的差异不能证明谁是真实生理LTHR。缺独立协议时本候选选择不精确给数。

真实FitRec 3活动/1用户/1500点按原Unix事件日期和原HR采样走candidate：全部缺有效协议，且稀疏采样/缺口拒绝现场质量支持。没有造日期/逐秒HR，没有把同场输入当独立label。OSF只有5min HR汇总、Trinity只有stage/作者label，不能重复填充成>=95%逐秒覆盖或将label倒灌输入；它们的lab/field语义沿用[公开数据研究](public-datasets.md)，本票不读取最终留出或宣称HR准确性验收。

逐次命令、manifest/report/hash、完整对照与结果记录于受控 `/tmp/stride-983/t5-implementation-evidence.md`；原始资料/私密报告留Git外。工程测试通过不解除[冻结协议v1](evaluation-protocol-v1.md)的真实独立参考、分层、人数和准确性门禁。

## T5 独立评审修复：同根来源冲突

去重前先审计**全部已通过当前协议/HR质量/可得时间/新鲜度准入**的同root别名。若数值按现有4位小数精度不同，或reference tier、协议、field传感器、lab方法/仪器相互矛盾，则整根不参与当前HR支持；原始观察及 `root_HR_alias_conflict` 仍完整保留，顶层也记录冲突。不按活动ID选择一个来源，也不平均不兼容的报告。没有可信的优先来源时，这是会增加缺失的保守研究策略，不能声称冲突已被生理方法消解。

只有解释与对外精度数值一致的别名才去重成一个根贡献，聚合/6bpm分歧判断均使用该统一精度值；逐观察仍保留原始提取均值。故交换ID不会隐藏反证，也不会让显示精度内的浮点微差越过支持边界。不同来源版本或audit ref本身不等于矛盾，它们继续保留供审计。无效、未核验、晚到、域外或陈旧别名不制造数值/协议冲突；原180日观察窗内同root跨日整根拒绝的身份不变量保持，未来/181日及更早输入先排除。

公开seam的红绿回归复现了170/190bpm同根录制与另日170bpm造成错误medium，修复后同根全部拒绝、剩余独立日为low；交换alias ID不变。另覆盖lab方法、仪器、lab/field类型冲突、无效/晚到别名不污染有效支持，以及对外精度相同alias不因ID选择亚精度浮点数而误降级。真实两组资料没有已核验HR协议，因此这项来源冲突的保证来自确定性回归，不能把真实训练回放当独立冲突准确性标签。

> 演进提示（#993/#995，2026-11-16）：本文件描述的 v1 行为是冻结存档；原地演进后 v4 的联合估计契约（先验、状态标签、修订标记）见 [estimation-contract-v2.md](estimation-contract-v2.md)，评估以 [evaluation-protocol-v2.md](evaluation-protocol-v2.md) 为准，v1 协议与留出不改。
