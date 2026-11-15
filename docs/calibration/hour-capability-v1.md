# T4 一小时能力模型（#987）

候选实现 `hour_capability_v1`、参数 `hour-v1-conservative-research`。仅 `StrategyCandidate` 调用纯函数 `FitHourCapability`；生产 v3 与 T2 `segments_only` 不经过本模型。`types.go`、v3 源码与 golden 冻结。HRmax、RHR、CP 等其他基线仍按 v3 计算；旧配速条件 HR 暂时最多 low，独立 HR 支持由 T5 提供。

这些参数是**保守研究选择，尚无足够训练/验证资料校准**。没有使用最终留出调参，没有把个人 4′00″ 或旧模型约 3′55″ 当真值。以下范围不是 95% CI，不代表校准概率。工程测试通过不解除准确性和候选上线的 insufficient 门禁。

## 输入与模型

输入仅为 T3 admitted `CandidateEvidence`，不读取 ReplayReference、HR 或训练负荷来给配速增信。只处理 selected、连续、有日期和活动根、180 日内的有限观测；未来、缺测量质量、非连续/暂停观测不约束连续 Vmax。速度上限 8.5m/s 沿用测量域。重复 root/duration 去重，优先努力/测量质量，剩余按内容 hash 稳定排序。原始活动、窗口、时长和努力分类仍由 evidence pool 完整保留。

180–7200 秒的候选曲线为：

```
log Vmax(t) = a - k log(t / 3600)
V60 = exp(a), k ∈ [0.02, 0.10]
```

复用现有 Riegel 合理边界和 `enduranceIndex(k)` 映射，原 v3 helper 不修改。个人 k 只由已确认/很可能近全力的独立时长拟合，不由 unknown/submaximal 训练。没有独立时长支持时，报告 `k_support=unidentified_research_midpoint`，使用边界中点 0.06 作为显式研究假设，快照 `RiegelK` 保持 nil；不会冒充个人耐力估计。原模型 CS/D′/SpeedIndex 没有在本模型独立识别，候选快照置 nil，不能沿用未经努力筛选的旧拟合。

超过 7200 秒的观测**不当作精确 Riegel 锚点，即使有全力协议也不例外**。它们保留完整实际时长，以宽松非增延拓 `Vmax(t>7200) <= Vmax(7200)` 的必要条件进入单边损失：对所有非增延拓取最宽松包络，原时长预测允许任意继续衰减；正向支持仅在连包络也低于观测时才绑定。诊断 `duration_s` 是原时长，`model_duration_s=7200` 是包络边界而非截断活动，role 为 `long_duration_monotone_model_constraint`。额外 log 误差 0.15 承认长时耐力外延不足。30km/9000s 不会被当作另一个精确60min测量或按同一短程指数精确折算；只有长跑数据仍不输出中心。

## 目标函数与权重

第一阶段只拟合 near-maximal 锚点：

```
x_i = log(t_i/3600), y_i = log(Vobs_i)
r_i = (y_i - (a-k*x_i)) / sigma_i
L_anchor(a,k) = Σ w_i Huber_1.5(r_i)
```

Huber：`|r|<=1.5` 时 `r²/2`，否则 `1.5*(|r|-0.75)`，限制孤立异常值的影响。k 在既有边界内作确定性 0.0002 网格搜索；给定 k 的凸截距目标用70步二分求根，不依赖随机初值。无独立 k 时固定中点并重新估截距。

第二阶段在第一阶段曲线的**原持续时长**检查 unknown/submaximal 单边观测：

```
L_soft(a | k) = Σ w_j Huber_1.5(max(0,
  (log(Vobs_j) - sigma_j - log(Vmodel(t_j))) / sigma_j))
min_a L_anchor + L_soft, k 固定于 near-maximal 阶段，a >= a_anchor
```

measurement 容差并不表示次极限是精确能力。3min 快段只约束 Vmax(180)，不会把该速度直接设为 V60 下界。长时段使用上节宽松包络，所有折算仍是 model inference。轻松跑没有上界损失，因此慢60min不能封顶更快可信独立测试。第一阶段已经非绑定的约束不参与预算，不影响中心、范围或支持等级；固定 k、只允许提高截距使它们在第二阶段仍非绑定。

每条原始权重 `2^(-age_days/90)`；confirmed 努力系数1，probable系数0.7。测量质量通过误差影响拟合，不把测量 high 当 maximal 证明。按**实际参与拟合**的 root 内观测数、同日独立 root 数分别均分，故每根总贡献 <=1、每天总贡献 <=1。第一阶段只预算近全力锚点；第二阶段重新对锚点与实际绑定约束联合预算，不能重复花同根/同日预算。只增加非绑定 easy 不稀释已有锚点或绑定约束。`Hour.AnchorContribution` 与逐观察 Weight 报告实际拟合贡献，T3 pool Contribution 仍是池选择预算，不当作拟合独立证据数量。

基础 log measurement 误差：high 0.02、medium 0.05、low 0.10。与 `min(0.15, age_days*0.001)` 正交合成；probable 额外0.06；60–120min 额外 `0.06*log(t/3600)/log(2)`；>120min 在120min误差之上额外0.15。年龄衰减、误差、Huber、持续范围与支持规则均是未校准研究参数，不是已测设备精度或生理概率。

## 中心、范围与不足路径

- 近期（复用60日边界）可信直接60min测试可产生低支持中心；单场不产生 high。
- 无直接测试时，至少两个近期独立 root、两个独立日、跨度>=1.5，且有>=20min近期锚点才产生跨时长中心。只有短快段、单场非60min、陈旧 PB 或 unknown/submaximal 可保持中心 nil。
- 至少两个近期、测量>=medium且残差不过3的独立 root/day 才可 medium；high 还需三个近期 high 测量的独立 root/day、全部拟合锚点 confirmed、有直接60min支持且无冲突。unknown/低质量观测不会靠数量凑 high；努力和测量支持来自实际拟合锚点，不对整个 pool 机械取最小值。
- 任一拟合锚点或原时长约束标准化冲突>3，保守降为 low 并记录冲突；Huber 中心不强制穿过异常观测。
- 范围是 k 两边界下重新估计截距的敏感性包络，加 `2*加权平均sigma+0.04` 的 log 宽度；冲突再加0.10。绑定约束时还包含锚点独立中心，避免把冲突挤成假精确值。它不由 holdout 误差校准，不称95%置信区间。
- `direct_60min_maximal` 表示只由直接60min锚点定中心；`speed_duration_inference` 表示跨时长或绑定约束模型推断；`constraints_only` / `insufficient_maximal_support` 的中心和范围为空。绑定约束不得伪装成直接60min测试。所有情形保留原时长观察、误差、拟合角色、实际权重、参数版本和不足/冲突理由。

## 验证

公开纯 seam、EstimateOffline 和 Replay 回归覆盖：unknown-only 缺失，可信直接60min不被慢训练封顶，独立速度—时长例子，3min非绑定原时长约束，完整30km宽松软约束，长跑可绑定但仍模型推断，长跑单独不捏造中心，暂停不约束连续能力，单场/陈旧/短快证据不足，少量GPS异常的鲁棒性，重复root与同日封顶，低测量协议不升 high，非绑定easy不稀释锚点或绑定约束。

原Replay scoring测试使用独立的历史已核验协议作为 admitted input，目标 Reference 始终独立、未来/留出/晚到隔离继续检验；没有把目标标签拷入输入来恢复覆盖。

## 2026-11-15 固定真实数据回放

普通 test/vet：`./internal/compute/calibration ./internal/compute/calibrationsource ./internal/compute/watchmap ./cmd/stride` 通过；前三包 race 通过。冻结 v3 hash/golden 和 T2控制仍通过。

在同机固定252活动、固定 manifest 上用 CLI 跑完整三版本。`T4-working-tree` 标签的原 manifest 两次耗时7.938/6.902秒，报告SHA256均为 `51c2120480ce33eff9de5c5a0d43fdce153bf8ed9cfee1cc7ec82479a461d90d`；加入 T3 已审阅 reader metadata（含69场暂停反证）的独立 manifest 耗时7.052秒，SHA256 `adf4a0de92f909e8706f0afc673b7f535c2382691e1611e6278239ba7c5b4518`。三次都 exit2 / insufficient，无计算失败。

与各自 T3 reviewed 报告逐字段对照，**v3 和 segments_only 完整结果相同**，两个 manifest 的内容 hash 未变；冻结 v3源码 hash 仍为 `1d20459b1d72095d775e69ce928aebde8540753a1c6631d5cf05fb35e0bc5826`。v3/T2 的阈值仍3.9914m/s，分别 high/low。candidate 保留1275条观察，因没有独立近全力锚点，方法 `constraints_only`、中心 nil、支持 none。当前唯一 prediction case 的阈值可用覆盖从 T3 候选的1/1降为0/1；这是诚实缺失，不是误差改善。真实资料缺独立可评分目标，不能报告改善的MAE、配对误差或准确性 pass。

原 manifest 没有 metadata，不冒充已经覆盖暂停；含真实 reader metadata 的回放继续把69场暂停对应观察留在非连续域，不选作连续约束。原资料、早期报告和私密标识/原话未提交Git；本轮报告仅存受控 `/tmp/stride-983/private/t4-*-replay-*.json`。没有生产写入、active切换或历史重算，release_ready=false。
