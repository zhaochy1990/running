# 最终全 PR 评审修复验证（2026-11-16）

运行源码固定为 `081d045a881070ebeb9eae849bf8681042d61649`（base933）；独立 implementer 在独立
worktree 修复两轴全部 S1–S3 / F1–F3。这里只报告本次亲自执行的工程验证，独立复评由原
两个 reviewer 对新的固定 head 接续。生产默认 active3、candidate4、fallback3，所有生产
构造的 candidate / active4 写开关仍关闭。`release_ready=false`，准确性仍 insufficient。

## 修复与反例

| Finding | RED 与修复后的实际结果 |
| --- | --- |
| S1 | 共享 `future-source-schema` 令 Web 显示高支持、MP 自检失败；补 known-schema 判断后，Web/MP/Swift 都保留中心、拒借 v1 支持/质量/努力。共享 projector 回归通过。 |
| S2 | public compute 的休息日 RHR 55、持久基线50、局部健康P10=40，原输出错误 red；现在 yellow。缺历史基线显式 unavailable reason，不借未来。真实 MySQL 两休息日的 day bundle、实际 PMC seed、同ID重写后的冻结来源和旧 writer digest 失效均通过。 |
| S3 | 抽取很小的相邻HR区间测量原语，覆盖/漂移/质量策略仍由消费者拥有。原933源码 overlay 与新实现对 valid/partial-window/spike/drift/stale/missing 六个纯合成输入的 Snapshot+Evidence SHA256 逐一相同。没有改变浮点运算次序或科学门槛。 |
| F1 | RED：shadow 单开关可误授权 active4 refresh；另缺中心 active4 可写366行。现分开 active/shadow 构造能力，candidate payload 即使 active 开关打开仍拒绝，缺中心/必要baseline保留原五表并显式 unavailable。真实 opt-in 与 rollback 见下。 |
| F2 | 真实 MySQL 暂停反证 RED：metadata-aware 0，实际 job 却持久化7个连续贡献。candidate job 改用既有 `LoadCandidate`，现0；另连续 control 保留 storage source version、活动绑定与as-of，未来活动不入证据。v3 loader不变。 |
| F3 | 实际 producer observation 有 stale 但摘要丢原因的 RED；现有界摘要保留具体拒绝/质量原因与 `latest_rejected_evidence_date`。旧协议不恢复HR中心/范围/支持计数/有效证据日。真实 MySQL与三端解释回归通过。Coach bounded schema 对新字段的剥离亦独立RED后修复。 |

## 真实隔离 active4 / rollback

`TestActiveCandidateOptInRefreshDerivedAndRollbackMySQL` 在受 exact root/TCP loopback/
`stride_983_test` guard 保护的 MySQL8.4 与真实 FileStore 上执行。只使用随机UUID、声明为
**SYNTHETIC** 的工程活动/协议；没有拿它们充当真实准确性标签。

1. 实际 v3 校准→compute/PMC→ability/L1 建立原五表。
2. 实际 shadow job 不改变五表。policy4 后默认构造、shadow单开关、candidate碰撞均拒绝。
3. 明确 active4 opt-in 校准 refresh 保留 `label_ids` / `health_dates`，不标 candidate-only。
   原始输出JSON直接传给compute/ability。普通storage元数据不会伪造已核验全力，故中心
   仍诚实缺失；derived明确 unavailable，已有五表逐值保持。
4. 真实存储读取后的测量经既有 `EstimateOfflineWithEvidence`，加入明确 **合成** 的精确
   协议，得到正向中心，再经合法 Publish。此段与普通storage job的未核验输入明确区分。
5. active4 opt-in compute/PMC/ability/L1 实际写入五表，核对73行冻结来源的版本4、逐日
   as-of与fingerprint一致。没有让今天bundle替代昨天bundle。
6. 显式 policy3 + full v3 compute/ability 重算。五表输出与原v3逐值一致（排除生成ID、执行
   时间、新policy revision/provenance），冻结来源再次为3。只改pointer不算派生回滚。

该测试及F2/S2/F3四个真实DB回归都在 `-race` 下实际执行通过，默认skip不计实跑。
原非最终T8 stack报告与first-score保持历史状态；本轮没有重写它们，新实际栈结果单列如下。


## 新252活动非最终真实栈（独立于73行合成正向链路）

在上述固定源码实际运行 `TestCalibrationCapturedStack`，PASS234.69s。明确改进仅限 gated
harness可复跑：原capture日允许早于真实execution日，未来/零capture日仍拒绝（RED→GREEN）。
没有改变真实输入日期、点或系统时钟；job按实际今天执行。原capture为2026-11-15，新执行日
为2026-11-16，二者分别写入摘要。

- 本轮选用允许的 `fresh-manifest.json.gz`，原gzip SHA256为
  `b9c582bf7d0de612f308fd77b2209507715b8cd3ce2a68a78a23621fdaf014d2`；解压JSON字节SHA
  为 `6d4164199707f6f761da57e0ee2fa40214bb0bd5dcaecc0b5b9d0574dae61820`。
  harness实际消费投影（as_of/activities/health、ordinal重映射前）的ReplayContentHash为
  `ff3bc5984375965b949f75f86cfa1d6810a67126a2d7d4e88567b0100471deb8`。三种hash首尾完全相同。
- 旧266c栈的e940 gzip hash对应另一个允许输入 `t3-reviewed-input-manifest.json.gz`，不是本次
  fresh输入。旧源码也是对原gzip字节做SHA；两轮不称同一输入，不做跨输入数值改善比较。
  本轮harness仅消费其声明的活动/健康字段，不声称消费T3的69份metadata或伪造已核验标签。
  candidate的storage元数据由实际导入字段经既有reader生成；F2暂停链路另有单独真DB回归。
- 252活动、644425点、300RHR经真实sync storage→FileStore→provider后逐值核对，130历史日。
  真实RabbitMQ dispatcher/pipeline为7 started / 7 completed / 0 failed；真实五表行数为
  252 load / 366 PMC / 15 ability / 78 L1 / 3024 activity zones。L1依实际90日窗口，不照搬旧80行。
- 新3→4→3每阶段实际mysql2 adapter、Coach工具、Go Gin+JWT、Web/MP projector和Swift
  APIClient/decoder/display均读取相同HTTP hash通过；Swift各1 test/0skip。不是新原生UI走查。
- candidate130日speed/HR中心全部缺失，252 preview剂量全缺、paired0、median/P90=null。
  `changed_dose=0`不能当“无影响”；没有已核验锚点，不借v3拼值。默认active4 writers拒写、
  五表仍v3且逐值不动；显式回3全量重算后输出相等，历史/休息日来源含显式unavailable审计。
- 原样的输入文件、原始活动和已应用计划没有被改；不是live供应商HTTP同步/COS部署验证。
  原snapshot/metadata缺历史可得证明仍是event-date retrospective，不宣称严格历史回测。

Go服务与consumer已defer正常退出；252个FileStore blobs、随机用户、五表及snapshots经storage
清理并审计，policy恢复3/4/3。精确label核验后已删除本轮自有Rabbit容器
`stride983-final-review-rabbit`（loopback13384），未动root-owned MySQL和其他Rabbit服务。

## 客户端与本地检查

- 新本地真实 Gin+RS256+MySQL 服务提供12个同响应hash状态。真实Chrome Web smoke通过：
  390px、桌面、合成触摸/键盘帮助、网络失败/重试；stale HR卡展开后实际显示未采用日期和原因。
- MP为相同12份真实HTTP的 public projector；Swift为真实 APIClient + session/bootstrap +
  TrainingStatusModel 的3 tests/0skip。它们没有被描述为新一轮小程序模拟器或iOS原生UI走查。
- 原始 schema2 的三端保守降级由共享fixture的 public projector直接验证。真实服务会先经
  storage将未知source解析为legacy unavailable，因此这12案live smoke不冒称原样透传schema2。
- Web focused 34 tests；MP自检与tsc；Swift显示8 tests；fresh workspace冻结安装/拓扑build，
  Coach source/tool/mysql adapter focused25tests；Web build均通过。Coach的fixture-only CI过滤
  和显式已构建source契约测试同步更新。
- 完整普通 `go test ./...` 通过；相关 calibration/calibrationsource/trainingload/compute
  race、API calibration/calendar focused race、相关vet通过。七个frozen v3文件与原933无差异。
- 扩大的整个API `-race` 有既有 `TestAdminBalances_List` 失败：fakeAuthLookup计数并发写。
  三个相关points文件与origin/master无差异；清STRIDE环境、无DB运行origin a70同focused也
  复现。它没有被称为全局race通过，也没有为此修改无关业务。
- 既有calendar CI fixture在周一422的反例已重现；只给被移动到明天的session独立合法index，
  focused与完整普通Go通过，不改生产validator、不跳过周一。

所有新本地服务正常收口：API `.done` 后PASS201.54s，Vite已停；storage-only audit确认
12个client身份/profile/snapshot/zones均移除。四个DB回归各自defer删除随机用户/五表/快照，
真实FileStore blobs清理，policy恢复3/4/3。没有停/删root-owned MySQL，没有生产访问、
注册账号、正式计划、merge/deploy或新final评分/调参。原最终留出已使用过，不再称unseen。

可机器核验的脱敏hash与边界：[verified-summary.json](verified-summary.json)。
新截图仅保留本次stale状态的卡片：[HR说明](web-producer-stale-hr-hr.png)；均为合成数据且已实际查看。
