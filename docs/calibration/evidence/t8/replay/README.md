# T8 首次最终评分与确定性复跑

工程评分实现及首次评分前独立专项 review 通过；真实准确性结论为 **insufficient，release_ready=false**。首次报告没有提供外部工程 receipt，因此其 `engineering_status` 如实为 unavailable。该字段不替代已存在的工程测试/栈证据，也不冒充尚未完成的总 PR 全 SPEC 双轴 review。

实现固定为 `1f6a13f2d8d2977a97283400d325781612a41d5c`。本目录属于随后提交的报告工件；报告提交 SHA 与实现 SHA 分开。原 freeze、首次/复跑的私有文件和失败阶段审计记录均保留，没有看结果后修改模型、参数、标签、分割或 cutoff。

## 独立真实证据与覆盖

| 最终参考族 | 严格历史 eligible 活动/用户 | retrospective eligible 活动/用户 | 三方 paired 活动/用户 | 结论 |
|---|---:|---:|---:|---|
| 直接 60min | 0/0 | 0/0 | 0/0 | insufficient |
| 比赛预测 | 0/0 | 5/4 | 0/0 | insufficient |
| 实验室 LTHR | 0/0 | 0/0 | 0/0 | insufficient |
| 现场 HR 代理量 | 0/0 | 0/0 | 0/0 | insufficient |

5 个独立比赛标签保留原 `probable_maximal`，缺失的测量分类记录为 `not_recorded`，没有补造 high、confirmed、直接60min或HR真值。collection完成时刻只证明报告前已观察，不能成为历史首次可得证明。没有新建/覆盖正式训练计划。

| 策略（retrospective race，同分母5） | available | missing_center | unsupported | 计算失败 | coverage |
|---|---:|---:|---:|---:|---:|
| v3 | 5 | 0 | 0 | 0 | 100% |
| segments_only | 5 | 0 | 0 | 0 | 100% |
| candidate | 0 | 5 | 0 | 0 | 0% |

candidate 的5个case均缺独立近全力训练锚点，v60及identified k缺失；HR也均无独立协议支持。没有借 ModelKUsed、先验或 heldout 成绩补中心。三方共同交集为0，因此比较 median/P90/bias、配对差值分布和 bootstrap 区间均为 null，不能把它们写成0误差、0影响或准确性改善。缺中心影响4个独立用户；缺少可比较数值时，“大幅数值变化数量”同样 unavailable。

## 冻结门槛

[脱敏 summary](summary.json) 保留所有 strict report gate 的 observed、threshold、单位、eligible/paired计数和状态。距离层只发布固定索引，原始距离/目标成绩/身份不公开。4项策略实现身份检查 pass，其余37项 insufficient，0项 fail；这些身份检查不是准确性通过。

| 原门槛组 | 本次观测 | 状态 |
|---|---|---|
| 直接60min ≥30活动/10用户；用户等权且单用户≤20% | strict eligible/paired均0 | insufficient |
| primary覆盖≥90%、candidate不低两基线；计算失败≤1% | primary分母0，不能拿race分母代替 | insufficient |
| direct对v3 median/P90非劣（1e-9）；对segments改善1/2 s/km | 无共同真实direct标签 | insufficient |
| 必需分层≥10活动/3用户；direct层退化≤1/2 s/km | 所有strict层无样本；样本不足的层退化亦不可评估 | insufficient |
| race ≥60活动/20用户、相对误差非劣及改善≥.005 | strict0；retro5/4且三方paired0 | insufficient |
| 按用户bootstrap2000/seed983984，两个上限≤0 | paired0，无区间 | insufficient |
| lab/field各≥30活动/10用户，median≤3/P90≤6 bpm且不劣v3；方法/设备层10/3 | 无独立HR标签 | insufficient |
| 全部确定性回归与旧个人配速容差≤.01 s/km | 工程测试存在；首评分未注入外部receipt | 首报告unavailable，工程证据另列 |

训练HR/非全力约束只做质量与协议检查，不纳入精确标签N。候选参数仍是保守研究选择，不声称经独立训练数据校准。准确性不足只阻塞候选上线；不因代码提交或 PR ready 自动切 active、shadow落库或历史重算。

## 首次、复跑与 hash

首次：exit2，51.687s；root随后明确授权仅做一次确定性复跑：exit2，50.173s。第二次明确标为已使用最终集的 determinism run，不是新的独立首次。11/11 view、各case report和aggregate的原始gzip SHA256、解压字节及语义JSON hash均相同；stdout只有新输出路径不同，去掉路径后相同。没有第三次运行。

- 代码：`1f6a13f2d8d2977a97283400d325781612a41d5c`
- 实际二进制：`bc74c54eb57c77458b11c54fec4a1d68f81b86b7743043b7b19a4e9f7544b2d5`
- 首次不可覆盖freeze：`db27c851504f59b1ca6f6cc3e53a4d40ffe9e1c0cd0cd73d38d5fbac03d335c9`
- 两次aggregate：`d7b96d7d5e76c6a13e513210e40ee6c744baf365c4f639c092b7e35a52ee7f6c`
- 协议：`043c5f28690c4db6138983eb95849ca870ce0e3ab2a3f224f6de07d18ab813cc`
- 原inventory：`c8c9d90a2a53b74774a56cb5d8d49ed1f77f63a711677de714f640249bd96763`

原文件/新view/fit input/首末时刻与完整file inventories保留在受控私有工件。root已完成37工件的独立持久备份，备份inventory SHA256为 `2ba6dd8d929eebca3e1b952ce94c97c632dff6484dec64c400618d19c6c6b25d`，原二进制及两次输出均包含。目录0700、文件0600、O_EXCL，没有覆盖原split/base/outcomes，也不把原始轨迹、真实身份或目标成绩提交Git。采集/裁决者此前看过来源来冻结标签；模型/评分实现者在freeze前未打开最终outcomes或按最终误差调参。T1–T7曾使用nonfinal252缺陷回放和公开工程样本，不宣称所有人此前都没见过原成绩。

## 工程证据与阶段边界

本地全compute+CLI的test/race/vet、handlers普通suite与最后provenance增量测试通过；精确实现的独立专项0 finding。原406/540预审发现的失败率身份、同根内容、可得时间、receipt失败状态、数值有限性、canonical身份、token及sealed报告问题都在首次freeze前修复，原红日志未改写。

[真实隔离栈报告](../stack/README.md) 绑定实际运行 source `266c5437`，已融合其最终证据文档 `3baf24d8`；与实现joint的17个runtime tree/blob和17个原校准运行文件逐项字节一致。没有冒称在joint重跑全栈。T8实际验证了MySQL/FileStore、MQ job、Gin及TS/三个客户端读取/回滚；T8客户端读取测试与T7真实UI走查的范围分别保留。

限制继续保留：candidate预览缺中心、剂量不可用且未请求ability源；五表仍冻结v3来源，active4写被拒绝；没有验证全量candidate激活、普通完整binary/COS部署或生产。生产active仍3，零生产写入。#982/#983/#991仅Refs并保持open，阶段B待用户授权合并、部署完成和生产只读验收。总 PR 更新后的fresh全SPEC双轴review由root继续安排。
