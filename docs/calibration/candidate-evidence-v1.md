# T3 候选证据（#986）

公开纯 seam 为 `BuildCandidateEvidence(history, metadata, asOf)`；估计 seam 为 `EstimateOfflineWithEvidence`。原 `EstimateOffline` 是无额外证据的兼容入口。只有 candidate 使用它，segments_only 永久保留T2清洗+旧估计器对照；v3冻结不变。

## 参数与证据边界

以下为先声明的保守研究选择，尚无充分独立训练集校准，不称概率或准确性改善：180天窗口；90天半衰期；每时长最多3个独立root；质量权重high=1/medium=.7/low=.3；努力权重confirmed=1/probable=.7/submaximal=.35/unknown=.2。候选排名按速度×质量×努力×年龄权重，在截断之前执行，避免180天旧PB先淘汰近期活动。每个root每时长只留一个窗口；同root全部入选片段分摊最多1的贡献，同日多个root再共享最多1的贡献。贡献不是独立样本量或概率。独立root和独立日分别报告。缺稳定root时使用活动label；跨设备重复但无可证明关联时不能保证识别，报告该限制。

速度观测下界仅限原始持续时长，取观测速度×.9；10%是沿用测量冲突容限的保守误差裕量，未经统计校准。不可将3min下界用于60min。75/90/120min以及完整活动时长进入报告；完整活动以已记录全程elapsed为口径，另保留声明的summary时长；summary比记录长超过10s视作截断，另保留完整声明时长但不称连续。完整活动有暂停/缺口/不稳定等不能证明连续时标明非连续，不进入连续估计池。>120min为超长耐力分层，不自动精确外推。

努力与measurement quality分离。`asOf`沿用calibration域的上海civil day；Replay另以实际预测瞬时审计metadata可得时间，避免把当天已可得资料误当晚到。只有显式已核验的 `continuous_maximal_test_v1` 协议、来源版本、证据引用及精确窗口匹配才是confirmed。普通比赛身份、活动绑定自述全力与持续努力旁证三者齐备最多probable。明确submaximal或中断反证优先；标题、单次HR、feel或无活动绑定计划不升级。协议只支持指定窗口，不能传给同场其他时长。结构化课程或反馈尚无已核验活动绑定时保留unknown；不查聊天，不用已有阈值自证。

metadata 为独立的 admitted input，不读取 ReplayReference。Replay在输入被允许之后才传 metadata；未来/留出活动及晚到metadata排除，strict还要求metadata可得时间和证明。`available_at`必须代表所有字段可得时间；现有MySQL同步时间不是备注/比赛身份的历史可得证明，reader不伪造该证明。直接reader只供event-date retrospective，严格历史须外部审计。输出只含分类理由、来源版本和引用；不含私密备注原话。

T3暂复用旧速度估计器（包括60min短路）处理已挑选的传统时长；新长时段与努力池完整提供给T4。未知/次极限输入的阈值、时长模型及派生HR置信度最多low，probable最多medium；它们仍不是独立HR支持。环境/设备/地形仅标签，不修正理想平路速度。上线始终insufficient。

## 工程验证与真实证据（2026-11-15）

- 公开 seam 的确定性回归：同质量的协议全力/次极限、单项feel与自述不升格、比赛加多方旁证最多probable、反证优先、旧PB与3个近期活动、无质量课、重复/跨设备root别名与同日贡献封顶、恢复不拼接、75/90/120min、完整9000.5s、30km/9000s但仅3600s采样、协议不传播给其他窗口、v3与T2完整对照不受metadata影响。
- Reader回归覆盖COROS厘米距离/百分秒时钟与现有provider单位转换、跨上海零点日期、真实绑定比赛/备注/feel/设备/环境，输出不含原始备注与标题。回放测试覆盖独立input metadata的hash、同日精确cutoff、晚到/未知可得时间与留出隔离，ReplayReference永不进入努力输入。旧scoring fixture改用真实形状的连续样本，以维持原来“缺历史目标不能被覆盖率隐藏”的测试目的；summary-only现在明确是不能证明连续性的观测。
- `go test` 与 `go vet`：`./internal/compute/calibration ./internal/compute/calibrationsource ./internal/compute/watchmap ./cmd/stride` 均通过。前三包 `go test -race` 通过；包含冻结v3源码hash与golden门禁。
- 使用已有只读账号实跑新 `LoadCandidateMetadata`，仅调用storage `ActivitiesInWindow` / `UserRaces`：252条metadata，1个比赛身份、1条备注、245个温度字段、252条vendor feel。没有device字段/独立最大努力协议/可证明历史可得时间；读取结果保持unknown，不把feel和比赛身份当全力。私密分类导出保留 `/tmp/stride-983/private/t3-live-metadata.json`，没有提交raw资料、原话或标识。

当前参数是保守研究选择，而非T1训练集已经标定；独立最终留出没有调参。未进行生产写入、切换active或重算。T4仍需替换旧一小时短路与跨时长估计；T5仍需独立HR支持。未知字段与不足样本只阻塞上线，工程可在独立review通过后推进。

最终252活动原manifest三版本重复回放（工作树实现，固定code标签 `T3-final-working-tree`）：8.19/7.40s，均exit2/insufficient，报告两次SHA256均 `e6d0494ebe2d53e8c4cb28f9db924a7f9526a669aa52a113facd9c06f06bd6ee`。v3与T2 `segments_only` 完整结果与T2独立review修复后报告逐字段相同，v3源码hash仍 `1d20459b1d72095d775e69ce928aebde8540753a1c6631d5cf05fb35e0bc5826`，manifest未修改。candidate共1275观测、252完整活动、114条>60min；125条入选、97独立root、72独立日，同日封顶总贡献约72。没有输入努力metadata的原manifest全部unknown；v3/T2阈值3.9914m/s，candidate4.0179m/s，置信度分别high/low/low。新值是候选池变化下的旧估计器输出，绝非准确性改善结论。完整原始数据/报告仍留在受控 `/tmp`，不提交Git。
