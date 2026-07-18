# 客观运动负荷计算方案

## Summary

构建一套**效果优先、科学可解释、主负荷客观数据驱动**的训练负荷模型。主线采用经典 fitness-fatigue / PMC 思路：先计算每次训练的客观训练剂量，再用指数衰减得到急性负荷、慢性负荷和状态；HRV/RHR/睡眠作为恢复门控；sRPE 不进入主负荷，但作为旁路 internal-load 信号用于 dissociation 监测。

系统有两条入口，但共用同一个 TSS-like 标尺：

- **实际活动负荷**：使用真实时间戳、逐秒心率和速度，计算一次已经完成的训练。
- **计划活动负荷**：使用结构化处方中的时长、距离、配速/心率范围，输出 `expected/low/high` 预估值、覆盖率、置信度和假设。计划值允许与实际值有偏差，不假装知道执行后的心率漂移或恢复反应。

核心决策：

- `training_dose` 主算法只使用客观可计量数据，不使用 RPE、疼痛、心情、文字反馈。
- `sRPE` 单独存为 `subjective_internal_load`，只参与 fatigue/sick/overreached 旁路提示，不改写 `training_dose`、ATL/CTL/TSB。
- COROS/Garmin 黑箱负荷只作为独立验证标签，不得作为 STRIDE 算法输入或重标定因子。
- 跑步高精度计算；力量/交叉训练只有在 HR 可归一成 `cardio_tss` 或存在可靠 TSS-like 外部负荷时才进入主负荷。无 HR 的力量体积、卡路里、时长估算只作旁路诊断，不进入 `training_dose`。
- 所有进入 `training_dose` 的分量必须先归一到 TSS-like 尺度：1 小时阈值强度 = 100。
- 不要求专门阈值测试，使用历史数据自动估计 HRmax、RHR baseline、阈值配速/功率/心率。

## Evidence Base

经典策略按用途吸收：

- **Banister / Calvert fitness-fatigue 模型**：训练输入产生短期疲劳和长期体能，代表论文 Calvert et al. 1976, *A Systems Model of the Effects of Training on Physical Performance*, DOI `10.1109/TSMC.1976.5409179`。
- **Morton-Banister running performance model**：将跑步表现建模为训练刺激后的体能-疲劳响应，Morton et al. 1990, DOI `10.1152/jappl.1990.69.3.1171`。
- **TRIMP / HR-based load**：用心率储备和指数权重估计内部负荷，比单纯距离/时间更接近心血管压力。
- **Individualized TRIMP**：个体化 TRIMP 比通用 TRIMP 更适合耐力跑者；Manzi et al. 2009, DOI `10.1152/ajpheart.00054.2009`。
- **TSS / rTSS / Power load**：用阈值归一化外部功率或配速，弥补 HR 滞后和短间歇低估。
- **PMC / ATL / CTL / TSB**：用 7 天和 42 天指数衰减建模急性疲劳与慢性适应。
- **Internal vs External Load 框架**：内部负荷和外部负荷应分开记录再组合判断；Impellizzeri et al. 2019, DOI `10.1123/ijspp.2018-0935`。
- **Foster session-RPE**：不进入客观主负荷，但作为独立 subjective internal load，用于力量/交叉训练补充记录和 HR-TRIMP dissociation 监测。
- **ACWR / workload spike**：只作为负荷突增描述，不作为单独伤病预测器；Gabbett 相关论文有价值但争议较大。

## Key Concepts And Standard Mapping

对产品侧使用可读命名，同时在 schema / 文档中保留主流术语映射，避免脱离 TrainingPeaks / Strava / 文献：

| STRIDE 名称 | 标准映射 | 用途 |
|-------------|----------|------|
| `cardio_load` | raw Banister TRIMP / HR-TRIMP | 原始心血管 internal load |
| `cardio_tss` | hrTSS-style normalized TRIMP | 归一后的心血管负荷，1 小时阈值 = 100 |
| `external_tss` | speed-based rTSS | 速度、坡度负荷，1 小时阈值 = 100 |
| `high_intensity_tss` | execution-only EPOC proxy | 高强度工作后恢复不完全产生的补充负荷 |
| `mechanical_load` | runner mechanical stress proxy | 肌骨机械冲击负荷，旁路输出 |
| `training_dose` | objective TSS-like daily load | 进入 ATL/CTL/TSB 的客观主负荷 |
| `acute_load` | ATL | 7 天指数衰减急性负荷 |
| `chronic_load` | CTL | 42 天指数衰减慢性负荷 |
| `form` | TSB | $chronic\_load - acute\_load$ |
| `load_ratio` | EWMA ACWR-like ratio | 急慢性比，只作变化监控 |
| `subjective_internal_load` | sRPE-TL | 旁路主观 internal load，不进入主负荷 |
| `readiness_gate` | recovery gate | HRV/RHR/睡眠/sRPE-dissociation 门控 |

## Objective Load Formulas

### Cardio Load And Cardio TSS

优先用逐采样心率，而不是活动均值。先估计心率储备比例，并将异常值裁剪到 $[0, 1.05]$：

$$
HRR_t = clamp\left(\frac{HR_t - RHR_{baseline}}{HRmax_{estimate} - RHR_{baseline}}, 0, 1.05\right)
$$

v2 采用归一化 Banister TRIMP 形态，按真实时间戳间隔累加：

$$
cardio\_load = \sum_t \Delta minutes_t \cdot HRR_t \cdot e^{4 \cdot HRR_t}
$$

`cardio_load` 是 raw TRIMP，不能直接与 TSS-like `external_tss` 加权。先用个人阈值心率归一成 `cardio_tss`：

$$
threshold\_trimp\_1h = 60 \cdot HRR_{threshold} \cdot e^{4 \cdot HRR_{threshold}}
$$

$$
cardio\_tss = 100 \cdot \frac{cardio\_load}{threshold\_trimp\_1h}
$$

如果 `threshold_hr` 不可靠，按以下顺序处理：

- 用接近 `threshold_speed` 的稳定跑段估计 `threshold_hr`。
- 仍不可用时，`cardio_tss` 不参与混合；跑步优先使用 `external_tss`，HR 只保留为 raw `cardio_load` 诊断信号。
- 若 HR 是唯一可用信号且无阈值心率，只保留 raw `cardio_load` 诊断信号，`training_dose = NULL`，并标记为不进入 PMC。

心率异常处理：

- 丢弃低于 30 bpm、高于 230 bpm、或单秒跳变超过 12 bpm 且前后 5 秒不连续的采样点。
- HR 有效覆盖率 < 80% 时，不允许该通道单独进入 `training_dose`。
- 短间歇场景下 HR 滞后明显，`cardio_load` 只作为 internal load，不单独决定主负荷。

### External Load

跑步外部负荷使用 grade-adjusted speed / normalized graded speed。当前功率只保留为可研究的原始信号；由于两位真实用户的验证中简单 power-TSS 融合会降低跨设备趋势一致性，尚未进入主负荷。

速度版：

$$
IF_t = \frac{grade\_adjusted\_speed_t}{threshold\_speed}
$$

`normalized_IF` 按真实驻留时间使用 6 次幂均值；这让变速课的高强度段有足够权重，同时不依赖采样密度：

$$
normalized\_IF = \left(\frac{\sum_t \Delta t \cdot IF_t^6}{\sum_t \Delta t}\right)^{1/6}
$$

$$
external\_tss = duration_{hours} \cdot normalized\_IF^2 \cdot 100
$$

实现约束：

- GPS 配速样本先剔除暂停、明显漂移和低速非跑步段。
- `IF_t` 裁剪到 $[0, 2.0]$，避免 GPS 瞬时尖峰支配 6 次幂均值。
- `grade_adjusted_speed_t` 需要坡度平滑；海拔噪声大时降级为平路 speed。
- 只积分真实时间戳覆盖的驻留时间；缺失、重复、倒序时间戳和超过 5 分钟的暂停 gap 不补时长，也不把局部 trace 外推到活动 summary 总时长。

### High-Intensity Execution Load

`high_intensity_tss` 只属于**实际活动**。它识别“持续高强度工作后，速度已降到恢复区但心率仍未恢复”的额外代谢成本：

- 速度 IF 先以 20 秒时间常数指数平滑。
- 连续达到 $IF \ge 1.05$ 至少 60 秒后，才允许打开恢复观察窗口。
- 只有 $IF \le 0.90$ 的真实恢复段计入残余；$0.90 < IF < 1.05$ 的 float 不产生负荷，也不提前结束资格。
- 真正进入恢复区后最多累计 120 秒；若工作结束 240 秒内仍未进入恢复区，或心率已恢复到 $0.85 \times LTHR$ 相对强度以下，则关闭该工作段的恢复资格。
- 基础残余加成之外，仅对 20 秒平滑后的高峰值、且 LTHR 以上心率暴露明显的严重课增加非线性 EPOC proxy。单点 GPS 峰值无法触发。
- 必须同时有至少 80% 的 HR 和速度覆盖；否则 `high_intensity_tss = NULL`，不得加到主负荷。

它不读取课型标签、厂家 `training_load`、`aerobic_effect` 或 `anaerobic_effect`。计划阶段不知道实际恢复心率，因此计划负荷不调用该通道。

### Mechanical Load

采用保守、可解释的 runner mechanical stress proxy，单独输出，不并入 `training_dose`，也不触发硬性调度结论。它用于提示肌骨冲击，不用于替代心血管负荷。

基础公式：

$$
mechanical\_load = distance\_km \cdot grade\_factor \cdot intensity\_factor \cdot descent\_factor
$$

各因子定义如下，其中 `ascent_m_per_km` 和 `descent_m_per_km` 都按全程正向爬升/下降除以距离计算：

- `grade_factor = min(1.5, 1 + 0.006 * ascent_m_per_km)`，约 83 m/km 爬升触顶。
- `descent_factor = min(1.4, 1 + 0.004 * max(0, descent_m_per_km - 20))`，20 m/km 以下不额外加权，约 120 m/km 下降触顶。
- `intensity_factor = min(1.4, 1 + 0.5 * max(0, normalized_IF - 0.85)^2)`，高速跑、间歇、冲刺逐步增加机械压力。
- Trail / 越野若 GPS 海拔噪声大，`mechanical_load_confidence = low`。

这些系数仍是 provisional heuristics。验收标准：常规平路 easy run 的 `mechanical_load / distance_km` 应接近 1.0；普通起伏路线不应超过 1.25；只有明显爬降、快速课或越野路线才应超过 1.3。后续可参考 Minetti 2002 坡度代谢成本、Vernillo 2017 下坡跑冲击研究、Stryd leg spring stiffness 等进一步校准。

### Non-Running Side Channels

当前模型不把无 HR 的力量训练体积、卡路里或时长估算写入 `training_dose`。这些信息可以作为旁路肌骨压力或解释性 reason 保留，但因为没有归一到 1 小时阈值强度 = 100 的 TSS-like 尺度，不能进入 ATL/CTL/TSB。

后续可以在具备个人化校准和足够历史基线后再启用非跑步客观 fallback。候选信号包括：

- `calories_kcal / body_mass_kg`
- `volume_load_kg = sum(weight_kg * reps)` 及个人 rolling baseline
- 运动类型校准后的 duration-based objective proxy

这些候选信号当前不得写入 `training_dose`。`subjective_internal_load` 可提示额外疲劳，但不改写主负荷。

### Training Dose

`training_dose` 是进入 ATL/CTL/TSB 的主负荷，所有参与混合的分量都必须是 TSS-like 尺度。

v2 规则不读取课型标签：

- HR 与速度通道都达到 80% 覆盖：`training_dose = min(cardio_tss, external_tss) + high_intensity_tss`。保守 envelope 防止单独的光学心率或 GPS 异常支配 PMC；高强度补充项只有双通道完整时可加。
- `cardio_tss` 不可靠但 GPS 有效：`training_dose = external_tss`。
- 跑步只有 HR 且 `cardio_tss` 可靠：`training_dose = cardio_tss`，置信度按 HR 覆盖率决定。
- 力量/交叉训练有 HR：只有可归一成 `cardio_tss` 时才可写入 `training_dose`。
- raw TRIMP、无 HR 力量训练体积、卡路里、时长估算、sRPE 不进入 `training_dose`；无法得到 TSS-like 客观负荷时 `training_dose = NULL`，`excluded_from_pmc = 1`。

### Planned Load Estimate

计划负荷解析结构化 warm-up、work、active recovery、passive rest、cooldown：

- warm-up、cooldown 和 active recovery 计入；passive rest 不计入运动负荷。
- 配速范围用个人 `threshold_speed_mps` 转成 IF 范围，并沿用实际 `external_tss` 的 6 次幂/IF² 标尺。
- 心率目标在有 RHR/LTHR 时作为 IF² 代理。
- `WORK + OPEN target` 不使用固定课型 IF，直接标记该步不可估算。
- 缺个人阈值速度时保留明确的计划距离，但 `estimated_dose = NULL`；绝不回退到固定 `5:00/km`。
- FM race 使用目标完赛时间推导 MP；tune-up race 有时长时使用自己的距离与时长，
  只有距离时按比赛距离映射到个人阈值配速区间并显式记录该估算假设。
- 输出 `expected_dose`、`low_dose`、`high_dose`、预计时长/距离、coverage、confidence、assumptions 和未估算步骤数。

## Rolling Load And Readiness

STRIDE 的 canonical PMC 保持 7 / 42 天时间常数 EWMA；这是自身训练决策模型，不按手表品牌切换。厂家负荷比只能用于验证：

- COROS 当前样本与 STRIDE 7/42 EWMA 高度一致。
- Garmin 的 `dailyAcuteChronicWorkloadRatio` 只保留一位小数；同步层在 ATI/CTI 完整时改存精确的 `ATI / CTI`。
- Garmin ATI/CTI 使用专有加权窗口，并不等于 7/42 EWMA。离线比较可同时给出公开标准的 7/28 eACWR 参考，但该参考不替换 canonical PMC，也不读取厂家负荷作为输入。

滚动负荷使用指数衰减：

$$
acute_t = acute_{t-1} + k_7(load_t - acute_{t-1})
$$

$$
chronic_t = chronic_{t-1} + k_{42}(load_t - chronic_{t-1})
$$

其中 $k_N = 1 - e^{-1/N}$。

当前固定 7/42 天，等同 PMC 的 ATL/CTL 时间常数。固定参数是有意选择：稳定、可解释、便于跨用户比较。当前不拟合个体化 $\tau$，也不宣称精确预测比赛表现。Hellard 2006 等对 Banister 参数拟合稳定性的批评继续作为后续研究风险。

恢复门控不改变已完成训练剂量，只改变下一步训练建议。`readiness_gate` 的最终规则：任一 red 信号或两个及以上 yellow 信号 => red；一个 yellow 信号 => yellow；无信号 => green。

客观恢复信号：

- HRV 基线：最近 28 天夜间 HRV 中位数和 MAD；样本少于 14 天时 HRV 不参与门控。
- HRV yellow：昨夜 HRV < 基线中位数 - 1.5 * MAD；HRV red：昨夜 HRV < 基线中位数 - 2.5 * MAD，或厂商状态为 `poor` / `low`。
- RHR 基线：最近 60-90 天 RHR 第 10 分位数；样本少于 14 天时 RHR 不参与门控。
- RHR yellow：昨晨 RHR >= 基线 + 5 bpm；RHR red：昨晨 RHR >= 基线 + 8 bpm。
- 睡眠 yellow：昨夜睡眠 < 6.5 小时，或 7 日均值 < 7 小时。
- 睡眠 red：昨夜睡眠 < 6 小时，或连续两晚 < 6.5 小时。

sRPE dissociation 信号：

$$
subjective\_internal\_load = RPE_{CR10} \cdot duration\_minutes
$$

仅当过去 90 天同一 `sport + session_class` 至少有 6 条记录时启用 dissociation。分别计算 `subjective_internal_load` 和 `training_dose` 的 robust z-score：

$$
z(x) = \frac{x - median(x_{class})}{1.4826 \cdot MAD(x_{class})}
$$

- `srpe_dissociation_yellow`：$z_{sRPE} - z_{dose} >= 1.0$ 且 $z_{sRPE} >= 0.5$。
- `srpe_dissociation_red`：$z_{sRPE} - z_{dose} >= 1.5$ 且 $z_{sRPE} >= 1.0$。
- dissociation 只产生 `readiness_gate` reason，不改写 `training_dose`、ATL、CTL、TSB。

`readiness_gate` 的理由必须可解释：例如 `low_hrv`、`rhr_elevated`、`sleep_debt`、`srpe_trimp_dissociation`。

## Calibration Rules

自动校准，不要求用户固定测试：

- `RHR_baseline`：最近 60-90 天静息心率低分位数估计。
- `HRmax_estimate`：最近 180 天有效高强度活动心率高分位估计，过滤明显异常。
- `threshold_speed`：从历史最佳 3-60 分钟跑步表现拟合 critical speed / power-duration 曲线。
- `critical_power`：若功率数据足够，从最近 90-180 天 power-duration 曲线估计；否则不启用功率版 external load。
- `threshold_hr`：从接近阈值配速的连续稳定跑段估计，不要求用户做阈值测试。
- `threshold_trimp_1h`：由 `threshold_hr`、`HRmax_estimate`、`RHR_baseline` 推导；不可用时不得混合 raw TRIMP 与 TSS-like load。
- 每次重算时保留校准版本，避免历史负荷因参数变化无法解释。

## Test Cases

必须覆盖这些场景：

- 同样 60 分钟训练，HR 更高的一次 `cardio_load` 更高。
- `cardio_load` 归一为 `cardio_tss` 后，1 小时阈值心率训练约等于 100。
- 同样距离，阈值速度附近跑的 `external_tss` 明显高于轻松跑。
- `normalized_IF` 使用真实时间驻留的 6 次幂均值；不同采样密度得到一致结果，瞬时 GPS 尖峰被裁剪后不支配结果。
- 短间歇 HR 滞后时，`external_tss` 能补足负荷，不完全依赖平均 HR。
- 相同工作段下，恢复心率持续偏高的间歇课产生 `high_intensity_tss`；恢复充分时不产生。
- 稳态阈值跑保持 1 小时约 100，不因课型文字或高强度通道额外加成。
- 只有局部时间序列时不外推到 summary 总时长，高强度覆盖不足时不加成。
- 计划负荷与相同结构的实际 external channel 在 TSS 标尺上一致，但不会伪造执行后的恢复心率。
- HR 缺失时仍能用配速/功率计算负荷，并降低 `load_confidence`。
- HR 异常尖峰不会显著污染 `cardio_load`。
- 同样距离和强度，下坡更多的一次 `mechanical_load` 更高，但不直接抬高 `training_dose`。
- 常规平路 easy run 的 `mechanical_load / distance_km` 接近 1.0。
- 力量训练无 HR 且只有重量/次数、卡路里或时长时，不写入 PMC，只保留旁路信号和 reason。
- 只有时长的 mobility/yoga 不产生 `training_dose`。
- 连续 7 天高负荷后 `acute_load` 快速上升，`chronic_load` 慢速上升。
- 停训数天后 `acute_load` 下降快于 `chronic_load`，`form` 上升。
- RHR 升高或 HRV 降低只改变 `readiness_gate`，不改变已完成训练的 `training_dose`。
- 存在 RPE/备注时，`training_dose`、`acute_load`、`chronic_load` 完全不变。
- 同类训练历史不足 6 条时，不产生 sRPE dissociation flag。
- 高 sRPE + 低客观负荷的异常组合会产生 `dissociation_flag`，但不改写客观主负荷。
- 力量训练无 HR 时 `training_dose = NULL`；若有 sRPE，只作为旁路 internal load。
- 任一 red 恢复信号或两个 yellow 信号会得到 `readiness_gate = red`；单个 yellow 信号得到 `yellow`。

## Assumptions

- 目标是服务日/周训练调度，而不是只给单次训练打分。
- 准确性优先于复制现有厂商黑盒；厂家字段只用于离线趋势/ratio 验证。
- 用户不做固定校准测试，系统从历史数据自动估计个人参数。
- 实际主负荷只使用客观可计量且已归一到 TSS-like 尺度的数据：`cardio_tss`、`external_tss`、`high_intensity_tss`。睡眠、HRV、RHR 用于 readiness，卡路里、重量/次数、时长估算不进入 `training_dose`。
- 主观 RPE、疼痛、心情、文字反馈不参与 `training_dose`、ATL、CTL、TSB。
- sRPE 作为旁路 subjective internal load 保留，用于 dissociation 监测和恢复门控解释。
- 当前使用固定 ATL/CTL 时间常数 7/42 天。COROS 对照与该定义高度一致；Garmin 厂家 ratio 的有效响应更短，不能据此把 STRIDE 全局时间常数改成设备专用值。
