# Daniels' Running Formula（丹尼尔斯训练法）强度与课型映射

STRIDE 的配速/心率区间已经等价于 Daniels 的强度体系。编写任何跑步课时，按本表把 Daniels 术语映射到 STRIDE 区间名与 `target` 字段；区间数值一律从 `user_profile.pace_zones` / `heart_rate_zones` 取，不要自行估算。

## 训练课型分类（Q / L）

先按课型区分每周训练，再决定其强度区间。

- **质量课（Q）**：一节能达到 MP / HMP / T / I / R 强度的**独立**周中专项课，与长跑是**两次不同训练**；Q 的 `work` 段落在相应强度区间并达到该强度的刺激量（如 6–10 km 连续 MP、4×3 km MP 间歇、20–30 min 阈值、6–8×800 m 间歇、200/400 m 速度重复）。
- **长距离课（L）**：周中总里程最长的一次跑步，通常是覆盖长时段有氧的长跑；**从定义上就不是质量课（Q）**。即使它内嵌 MP/HMP 段落（M 长跑，见下），该长跑仍归类为 L，**不替代、不抵消每周的独立质量课（Q）**。
- **Q 与 L 独立计数**：1Q1L = 1 节独立质量课 + 1 次长距离课，两者是两次独立训练；2Q1L 同理。禁止把质量刺激折叠进长跑来充当 Q。
- **轻松/恢复/跨步**：E / `recovery` / strides 都不计入 Q。

## 强度区间映射（E / M / T / I / R）

| Daniels | STRIDE 配速区间 | STRIDE 心率区间 | 生理目的 | 典型形态 |
|---|---|---|---|---|
| E Easy | `easy` | `easy` | 有氧基础 | 连续轻松跑 |
| M Marathon | `marathon` | `marathon` | 比赛配速耐受 | 连续 M 跑 / 长跑内嵌 M 段 |
| T Threshold | `threshold` | `threshold` | 乳酸阈值 | 巡航间歇 / 连续 tempo |
| I Interval | `interval` | `interval` | VO2max | 800/1000/1200m 或 3-5 分钟重复 |
| R Repetition | `repetition` | `repetition` | 跑步经济性 / 速度 | 200/300/400m 重复，充分恢复 |
| （E 之下） | `recovery` | `recovery` | 主动恢复 | 恢复跑 / 质量课前后的 shake-out |

`recovery` 是 E 之下的独立一档，只用于恢复日或质量课前后，不作为有氧基础累积。

## 课型目录

- **巡航间歇（cruise intervals）**：T 配速分段，每段 5-20 分钟，段间短恢复慢跑；对应 `threshold` 课。blocks 内 work 段 target 用 `threshold` 区间，recovery 段用 `recovery` 或 open。
- **tempo 跑**：连续 T 配速 20-40 分钟；对应 `threshold` / `tempo` 课。
- **VO2max 间歇**：I 配速，800-1200m 或 3-5 分钟，段间恢复约等于段长；对应 `interval` / `vo2max` 课。
- **速度重复（R）**：200-400m，接近全速但保持跑姿，充分恢复；target 用 `repetition` 区间。STRIDE 无独立 repetition 课型时，并入 `interval` 课的 work 段，target 仍用 `repetition` 区间。
- **M 长跑**：长跑内嵌 M 配速段（MP/HMP），长跑仍是单一 `run` 会话，内嵌段写在其 blocks 里，不要拆成额外会话。M 长跑归类为 L（长距离课），**不抵消每周的独立质量课（Q）**；1Q1L 语义为「1 节独立 Q + 1 次 L」，两者是两次独立训练。
- **strides**：10-25 秒放松大步跑，充分恢复，属神经肌肉维持，不计质量训练（与 base.md / speed.md 一致）。

## 阶段映射（Daniels Phase I-IV）

| Daniels | STRIDE phase | 对应课型 |
|---|---|---|
| Phase I 基础 | `base` | E 为主 + strides + 轻度坡跑 |
| Phase II 早期速度 | `speed` | R 重复 + 少量 I + hills |
| Phase III 过渡 | `build` / `speed` | I 间歇为主 |
| Phase IV 专项 | `marathon` | T 巡航间歇 + M 长跑 |

STRIDE 的 `base` / `build` / `speed` / `marathon` / `taper` / `recovery` 已覆盖 Daniels 的阶段推进；本表仅用于把 Daniels 课型对应到当前阶段，不要据此重排 master plan 的阶段或里程碑。

## 结构原则

- **质量课（Q）**：一节能达到 MP/HMP/T/I 强度的**独立**周中专项课，与长跑（L）是两次不同训练；禁止把 MP 折叠进长跑充当 Q。1Q1L = 1 节独立 Q + 1 次 L。
- **2Q**：每周最多两次质量课（`hard_stimulus_density`）。
- **hard/easy**：质量课间隔 ≥48h；代价高的长跑之后不排质量课（与马拉松.md 一致）。
- **长跑占比**：长跑 ≤ 周量 25-30%（`long_run_share`）。
- **配速/心率目标**：一律从 `pace_zones` / `heart_rate_zones` 取；calibration 缺失或置信度低时，用 effort/心率描述并把无依据的数值留空，不要自行估算。
