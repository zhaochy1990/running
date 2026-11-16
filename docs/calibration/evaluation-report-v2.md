# 校准评估报告 v2（#993 / #1001 阶段 A，2026-11-16）

本报告是 T7 #1001 阶段 A（合并前）的开发后独立回测与验收记录：协议 v2 评分引擎对集成分支 head 跑 v3 / 旧 v4 / 更新后 v4(rev2) 三版本对比、个人生产只读资料冻结重测、T3 推迟的真实 HR 序列动态预测误差验证、真实隔离栈全链路 E2E，并按 [evaluation-protocol-v2.md](evaluation-protocol-v2.md) 分别给出三道门槛结论。阶段 B（部署、对真实生产用户的 publish/recompute、生产写入试用）未执行，入口清单见 §8。

## 1. 身份与 hash

| 项 | 值 |
|---|---|
| 实施分支 | `spec993/t7-1001`（worktree `wt-spec993/impl/t7-1001`） |
| 基点 = 集成分支 tip | `82ff7acdd8fb10518b8c4f58df1c1f5ec65ebb`（开工与收工双重 `git log`/`merge-base --is-ancestor` 亲核，tip 未前进，无需 merge） |
| 协议 v2 SHA-256 | `EvaluationProtocolV2SHA256()` = `566d3c5e…350485`（与 `testdata/evaluation-protocol-v2.sha256` golden 及双拷贝逐字一致，测试锁定） |
| v3 源码 SHA-256 | `FrozenV3SourceSHA256()`（v3 冻结面零改动，diff 与 golden 测试双确认） |
| 评分对象 | `v3`（`StrategyV3`）/ 旧 v4（`StrategyCandidate`，`hour_capability_v1+independent_hr_v1`，历史行为存档）/ 更新后 v4（`StrategyEvolvedCandidate`，`algorithm_version=4` + `algorithm_revision=v4-rev2-2026-11`） |
| 评分引擎 | `calibration.ReplayV2`（`protocol_v2_engine.go`）+ CLI `stride calibration replay-v2`；退出码 0=通过 / 2=insufficient / 1=输入·分割·hash·算法失败 |
| 引擎门槛常量 | 逐值锁定在 `TestV2FrozenGateConstantsMatchProtocol`（15/30 s/km、+1/+2 非劣、5/10 bpm、失败率≤1%、all-inputs≥90%、≥30 活动/≥10 用户/≤20% 权重、分层≥10/≥3、退化≤1/≤2、bootstrap 2000@seed993994、speed eligible≥3 根） |

引擎确定性：同输入重复运行报告 JSON 逐字节一致（无时钟、无未播种随机源；唯一随机源是冻结 seed 的 bootstrap）；观测聚合一律确定序（user+case ID 排序）+ 补偿求和（Kahan），多观测面（4 用户×3 参考共 12 观测的 manifest 连跑 40 次逐字节比对）与单 case 面均有测试锁定；manifest 活动/case 顺序重排不改变逐 case 输入 hash 与版本输出。（评审 P0-1 修复：初版在 map 迭代序+裸浮点求和下 60 跑出 4 份不同 JSON，已修复并加多观测确定性测试。）已知回归（known_regression）单列、无门槛；`event_date_retrospective` 家族单列、不入 strict 门槛；合成来源经 `real_reference_provenance` 门槛永远 insufficient，合成样本不做准确性 bootstrap。

## 2. 对集成 head 的三版本回测（协议 v2 引擎）

提交的合成回测 fixture `src/go/internal/compute/calibration/testdata/replay-v2.json`（schema 2，由 env-guard 生成器 `TestReplayV2GenerateCommittedFixture` 再生，`STRIDE_T7_FIXTURE_OUTPUT`）：

- **原 v4 已看样本全部迁移为 `known_regression`**：`replay-v1.json` 的 8 个 v1 期合成场景（progressive_60min / submaximal_30km / distance_jump_recovery / distance_reset_fallback / maximal_test / no_quality_sessions / pause_recovery / missing_gps_hr）不再作 train/验证输入，只作行为回归观察（8 个 case 仍产出三版本密封预测，供后续代码变更对比防倒退）。
- **新增前瞻形状合成用户**：普通混速训练、全 easy、含合成（`Real=false`）final_holdout 参考。三用户 all-inputs 口径 3/3 case 有限+物理合法+带范围，覆盖率 1.0（`all_inputs_coverage` gate PASS）；合成参考被显式拒绝 `non_real_reference`，accuracy 家族全部 insufficient（如实）。
- 运行命令与完整输出：`stride calibration replay-v2 --manifest …/replay-v2.json --code-version 82ff7acd…`，退出码 2（insufficient），报告存 `/tmp/stride-983/private/t7-replay-v2-synthetic.json`。
- 模拟全力仅存在于合成 fixture（推断分布/合成回归用途）；**没有任何模拟或个人标签回流真实训练标签**。

## 3. 个人生产只读重测（180 天窗冻结）

按 `prod-readonly-data-access-recipe` 一次性只读取数（stride_reader 只读 MySQL + COS 只读签名 GET；零生产写入、零部署、零 policy/override 调用）：

- 冻结窗：上海日 2026-05-21 … 2026-11-16（180 天）；用户 `f10bc353-01ab-4db1-af9f-d9305ea9a532`。
- 冻结内容：280 活动（其中跑步 250：run_outdoor 208 / run_track 35 / run_indoor 7）、250 个 timeseries blob 共 **636,687 点**、300 行 RHR 日行、4,337 lap 行、25 races 行、synced_at 可得性证据。原始冻结与 manifest（126 MB，schema 2）保留在 `/tmp/stride-983/private/t7-freeze/`、`t7-personal-v2-manifest.json`（不提交）。
- 映射走生产同一条 `calibrationsource.Load/LoadCandidateMetadata` 路径（sport 映射、样本清洗、race/feel 元数据一致），scratch 转换器跑后即删、worktree 干净。

### 3.1 与 11-16 基线（251 次/641,150 点）的输入差异（如实列出）

| 项 | 基线（11-16 早） | 本次冻结 |
|---|---|---|
| 窗口内跑步次数 | 251 | **250** |
| timeseries 点数 | 641,150 | **636,687** |
| 窗口定义 | 近 180 天 | 2026-05-21…11-16（上海日） |

**因此本次结果与基线的任何差异不得宣称"纯算法同输入改善"**：输入集合已不同（少 1 次跑、少 4,463 点；差异活动无法从现存基线冻结中逐一定位，基线原始导出未保留）。个人数据不构成独立总体准确率证据，下述数值是行为观察。

### 3.2 三版本结果（today 截止 2026-11-16）

| 版本 | 一小时能力配速 | 阈值 HR | 状态/理由 |
|---|---|---|---|
| v3（冻结） | **250.539 s/km**（4:10.5，与 11-16 基线 250.539 逐位一致——冻结算法+不同输入快照下复现） | null | high（配速） |
| 旧 v4 | **null** | **null** | `no_independent_maximal_anchors` / `no_independent_HR_protocol_support`（与基线双 null 锚点一致） |
| 更新后 v4 (rev2) | **269.43 s/km**（4:29.4），范围 [266.56, 275.23] | **154.4 bpm**，范围 [147.7, 160.5] | 双通道 `model_estimated`；`joint_map_hr_dynamic_fit`，τ=20 s，HRmax 164.4 / RHR 39.2（拟合值，非实测），桥接 0.92；86 根/64 天，maximal_anchors=0，先验曲率份额 0（数据主导） |

**诚实性声明**：(a) 不以 4′00″ 或任何值作真值——本 manifest 零参考标签，accuracy 家族全部 insufficient；(b) rev2 与 v3 的配速中心差 ~19 s/km 是两个模型对"普通训练+努力余量"与"选拔窗口"的不同解释，无独立参考时**不判断谁更准**；(c) rev2 的范围是模型敏感性范围，不是置信区间；(d) 通道限制披露完整（`research_uncalibrated…`、`cadence_lock_suspected_series_excluded`、`HR_tau_grid_coarsened_large_input`、`capability_state_solve_failed_stationary_center_retained`——后者见 §6 的披露修复）。

- **走时间稳定性**（每 14 天 strict walk-forward，13 个 case）：数据可得性（COROS 9 月补同步）使 2026-09-17 前的 case 输入为空（时间机器如实拒收，非删除）——有效 6 个 case：rev2（链式先验）相邻跳变中位 1.77 s/km、P90/最大 5.87 s/km；v3 对照中位 2.24 s/km。滞后（lag）诊断在本 manifest 为空（无参考标签无法计算——引擎已实现半程漂移代理，仅在 ≥2 个带参考 strict 预测的用户上输出）。
- **先验敏感性**（有/无个人历史先验双跑，评审 P0-2 修复后为真接线：主跑消费上一 case 快照先验，`HistoricalPriorMeanLog` 进报告 lineage；无先验复跑恒 nil）：5 个链式 case（walk-133…today）主跑 vs 无先验中心差 = −0.141 / +0.114 / −0.028 / −0.190 / 0.000 s/km，**|Δ| 中位 0.114、最大 0.190 s/km、状态翻转 0**；today 的链式先验 = walk-175 主跑中心（log 1.3097，sd 0.15 floor、零龄（引擎链式先验 AgeDays=0；生产路径按快照日老化）），当日中心差不落 3 位小数。诚实解释：老化弱先验（sd floor 0.15）在该数据曲率主导的窗口上只把中心移动 ≤0.19 s/km——该结论现在由接线后的真实双跑支撑，而非构造性恒等。
- **hash 齐**：manifest SHA、逐 case 输入 SHA（today=`4a8389e1e229…`）、先验 IdentityHash、契约 IdentityHash、协议 v1/v2 hash、v3 源 hash、代码版本全在报告 JSON。

## 4. T3 推迟项：真实个人 HR 序列动态预测误差

以 2026-10-19 截止拟合（223 次训练输入），对之后 4 周留出活动做 30 s 块级前向模拟（一阶 τ 响应 + 拟合 F 形状 + v60；首块初始化不计残差，与拟合准入语义一致）：26 个留出活动、2,655 块，**MAE 5.66 bpm、有符号偏差 −0.65 bpm、|e| 中位 4.93、P90 10.82**；最差单活动 MAE 12.7 bpm（13 块，间歇形态）。**这是拟合 HR 响应模型的动态预测误差，不是阈值 HR 准确率**（无 LTHR 独立真值），二者分开报告、不得互替。scratch 验证器跑后即删。

## 5. 真实隔离栈全链路 E2E（13383/13384 复用）

`TestT7IsolatedStackFullChainMySQL`（新增，`internal/handlers/compute/calibration_t7_e2e_mysql_test.go`）：两个真实隔离测试用户（目标 A + 对照 B，均为随机 UUID、走真实 MySQL/tsblob-lifecycle/JWT 栈）：

- 数据→拟合→**用户 override**→**原子 bundle**：A 发布 rev2（snapshot+双 zones+override 单事务），effective 立即解析 pin 身份（v60=4.09 m/s、HR 161.8 bpm、双通道 model_estimated）；发布重试幂等。
- **派生链**：recompute 后 A 的 6 行 per-activity load（当日 2 行 v4 lineage 带 override 披露）、PMC 日序列 3 天、ability 快照 15 维、per-activity ability 6 行；历史日不被当日阈值回填（回落当日 v3 行 + `override_snapshot_missing` 显式理由）。
- **写入范围**：B 全程零 override 行、派生行零触碰、effective 行 ID 不变；**global policy 在 baseline/publish/recompute/revoke/recovery 五个相位 deepEqual 全等（active=3）**。
- **恢复演练**：revoke→effective 回 v3→recompute→6/6 行干净 v3 lineage；rev2 快照历史不可变存活。全程 `[drill]` 日志留档（测试输出）。
- **Coach 读取**：Go↔TS 共享 fixture 对（`TestCalibrationSharedFixture` × `calibrationMySQL.test.ts`，真实隔离 MySQL）TS 侧逐字段 deepEqual PASS（含 override-selected/revoked/fallback）。**三端读取**：`TestCalibrationClientServer`（真实 Gin/MySQL/JWT、22 显示 case 含 evolved 与 override 形状）本 head PASS；三端投影零改动（本票零 TS/前端 diff），T6 三端链路证据继续有效。

## 6. 本票发现并修复的 T4 披露缺陷

个人重测暴露：联合路径的 `evolvedJointSpeedOutShell` 重建 Limitations 列表，**丢弃**稳态报告上的 `capability_state_solve_failed_stationary_center_retained`（状态解数值失败→平稳中心保留的披露）与 `k_grid_coarsened_large_input`——真实数据窗口上 CapabilityState 缺席却无任何 limitation 解释。修复（RED→GREEN，`TestEvolvedJointShellPreservesStationaryLimitations`）：shell 改为携带稳态 limitations。数值与先验 IdentityHash 不受影响（纯披露修复）；修复后个人报告如实带上该 limitation。状态解本身在该窗口失败（>60 证据日 ISO 周聚合 + 250 活动规模下 `evolvedStateJointSolve` 数值失败回退）属 T4 遗留行为，平稳中心保守保留、trend 不披露——登记为后续票观察项，不在本票改动求解器。

## 7. 三道门槛结论（分开验收，不得互替）

### 门槛 1：工程准入 — **pass（测试面），本票独立 review 待执行（open）**
- 确定性：引擎字节级复现、输入顺序无关、bootstrap 冻结 seed 复现（测试锁定）；v1/v2 引擎互斥隔离（schema 1/2 互拒）。
- 版本隔离：v3 冻结七文件/golden/协议 v1 零改动；rev2 修订标记区分新旧 v4；T1 storage revision 键隔离测试原样绿。
- 来源/恢复：§5 E2E 全链路 + revoke→recompute 恢复演练 + 写入范围/global 不变断言。
- 测试：calibration 包全量、`go test ./...` 全模块、隔离栈 storage/handlers 全量、CLI 守卫、Go↔TS fixture 对、client-server harness 全绿。
- 独立 review 状态：T1–T6 六票 review 全部闭环（见各自 evidence）；**本票（#1001）独立 review 按流程在本报告后执行**，未完成前不声称该子项闭环。
- 隔离栈环境污染处置（如实）：`watch_binding_state` 等 4 张外分支残留表导致 `TestDeleteUserData_CoversEveryUserOwnedTable` 失败——基点 commit 复现确认与本票无关，隔离测试容器内 DROP 后恢复绿（同 T3/T4 wxpay 残留处置模式）。

### 门槛 2：单用户受控研究试用 — **条件满足，未执行（需用户另行授权）**
已就绪：工程门槛（上）、按用户隔离与原子发布/可撤销恢复（E2E 演练）、无效估计工程性拒绝、preview 只读入口。**所需授权清单**：用户知悉 rev2 为 `research_uncalibrated` 研究先验（未人群校准）、知悉 §3 的中心差与范围语义、知悉 HR 拟合参数（HRmax/RHR/τ）为模型推断非实测、明确授权对本人账号 publish 更新后 v4（`--actor` 审计）。授权前保持未执行；旧 v4 授权不自动延及 rev2 新行为。

### 门槛 3：全量/扩大范围上线 — **insufficient（保持阻塞，如实保留为上线待办）**
协议 v2 逐项：
| 门槛 | 状态 | 说明 |
|---|---|---|
| direct_60min 样本（≥30 活动/≥10 用户/≤20% 权重） | insufficient | 无前瞻收集的独立真实参考 |
| 配速中位≤15 / P90≤30 s/km | insufficient | 同上（无标签不可评分） |
| 对 v3 非劣 +1/+2 | insufficient | 同上 |
| HR lab/field 各 ≥30/≥10、≤5/≤10 bpm、非劣 v3 | insufficient | 无 lab/field 独立参考 |
| 失败率 ≤1% | **insufficient（机器归约 gate 已接线）** | 个人 manifest：`no_eligible_activities`（零参考无评分面）；合成：`synthetic_source_not_scored`；测试套件隔离/合成面 0 失败仅为工程观察，不作 gate 结果 |
| all-inputs 覆盖 ≥90% | pass | 合成 3/3、个人 6/6、T1 六类 fixtures（T2-T4 测试） |
| 分层 ≥10/≥3、退化 ≤1/≤2 | insufficient | 无分层标签 |
| bootstrap 2000@993994 | n/a→insufficient | 合成不做 bootstrap；无真实配对样本 |
| real_reference_provenance | insufficient | 新独立留出只能前瞻收集（协议 v2 §新最终留出） |

群体准确性 insufficient 不被个人试用误报为通过；insufficient 项保持 open，不以工程完成冒充全量准入。

## 8. 阶段 B 待授权入口清单（本票零执行）

1. 部署类（用户执行）：k3s `deploy.sh` / 镜像发布 / caddy —— 本票未触碰，命令未运行。
2. 个人试用类（需门槛 2 授权后，隔离栈内已演练）：
   - CLI：`stride calibration user preview|publish|revoke|recompute --user <UUID> --actor <审计>`（publish/revoke/recompute 需 `--actor`）；
   - job：`user_calibration`（internal-only，`UserInitiable:false`）三 action 同名。
3. 恢复方案（已验证）：revoke（effective 回 global v3）→ recompute（派生 load/zones/PMC/ability 重建 v3 lineage）；预记录旧 policy/snapshot 引用即可回读。
4. 生产验证类（部署后）：只读回读新代码终态、目标用户派生重算回读、其他用户不变抽查。

## 9. 测试与证据索引

| 命令（cwd=src/go 除注明） | 结果 |
|---|---|
| `gofmt -l .` / `go vet ./...` | 空 / 通过 |
| `go test ./internal/compute/calibration/... -count=1` | ok（含 v2 引擎测试：三版本 trio、双分母、误差算例、known_regression 单列、单 case 与多观测确定性（12 观测×40 跑）、先验链接线观测、失败率 gate（含空分母防护）、lag 诊断、bootstrap、retrospective、顺序无关、常量锁；T1-T6 全部原测试、shell 披露修复回归） |
| `go test ./... -count=1`（全模块） | 全 ok |
| DSN=13383 `go test ./internal/storage/... -count=1` | ok 43.4s（外分支残留表清理后） |
| DSN+Rabbit 13384 `go test ./internal/handlers/compute/... -count=1` | ok 16.9s（含新增 T7 E2E） |
| DSN=13383 `TestCalibrationSharedFixture` × TS `calibrationMySQL.test.js` | 双 PASS（fixture 对逐字段一致） |
| DSN+Rabbit `TestCalibrationClientServer`（STRIDE_990_CLIENT_SERVER + .done） | PASS 23.6s |
| CLI `calibration replay-v2`（合成 fixture / 个人冻结 manifest） | 退出码 2（insufficient，如实）；个人跑 142 s |
| cmd/stride 全量 | ok |

本票零 TS/前端/iOS 改动（`git diff --name-only` 过滤为 0），T5/T6 的 TS 测试基线继续有效。两份存档报告（`t7-replay-v2-synthetic.json`、`t7-personal-replay-v2.json`）由**评审修复后的最终引擎**重新生成（报告级 contract/priors IdentityHash 已填充；个人数值与初版逐位一致，链式 case 主跑因先验接线移动 ≤0.19 s/km）。CI 证据由编排侧在总 PR ready 时附 run 链接（本票证据=本地+隔离栈+独立评审复核）。本地证据目录：`/tmp/stride-983/private/t7-*`；spec993-notes 证据见 `evidence/t7-1001.md`。

## 10. 评审修复记录（2026-11-16，FAIL→修复）

独立评审（`spec993-notes/evidence/t7-1001-review.md`）判定 FAIL（2×P0、2×P1、4×P2；个人重测数值与红线全部核真）。修复：

- **P0-1 字节级确定性**：`v2ScoreFamily`/`v2ScoreKnownRegression` 改用确定序 case 迭代（`v2CasesInScoredOrder`，user+ID 排序）；两处 SignedBias 聚合改 Kahan 补偿求和；walk-forward 排序加 ID 决胜。新测试 `TestReplayV2MultiObservationDeterminism`（4 用户×3 真实参考=12 观测，连跑 40 次逐字节比对；修复前 run 0 即红）。
- **P0-2 先验链接线**：主 evolved 跑改为 `estimateEvolvedCandidate(..., priorByUser[user])` 真消费链式先验（`EstimateEvolvedOffline` 同款入口形状），无先验复跑保持 nil；`PriorChainApplied` 现反映真实消费（报告带 `HistoricalPriorMeanLog` lineage）。`TestReplayV2WalkForwardStabilityAndPriorSensitivity` 扩展断言：链式 run 带 prior lineage、无先验 run 不带、prior 均值=上一 case 快照中心。个人 manifest 双跑重跑：|Δ| 中位 0.114 / 最大 0.190 s/km（见 §3.2 修正后的先验敏感性节——初版 0.0 系未接线的构造性恒等，解释已改写）。
- **P1-1 失败率 gate**：strict final_holdout direct_60min 家庭新增 `failure_rate` gate（消费 `v2FailureRateMax`，真实参考才评分，空分母=insufficient）。测试 `TestReplayV2FailureRateGateIsMachineReduced`（真参考 0 失败=pass、合成不评分、真实源零 eligible=insufficient）。
- **P1-2 lag 诊断**：实现半程漂移代理（≥2 带参考 strict 预测用户，later−earlier 半程均差，补偿求和；描述性、非 gate），删除死变量。测试 `TestReplayV2LagDiagnosticsComputed`（4 用户×3 参考=非空且 Users=4；单参考 manifest=nil 不伪造）。
- **P2**：§2 6/6→3/3；两份存档报告用修复后引擎重生成（身份 hash 字段补齐）；CI 证据归编排侧（上文注记）；评审 3 条观察项（all-inputs 分母排除零输入 strict case、HR 非劣 margin-0 为引擎侧选择、时长分层 (4320,7200] 落 unclassified）入 evidence 遗留清单。
