# Per-athlete race prediction model — design blueprint

> 状态:**设计稿,未实现**。作为 TDD 实现的蓝本。
> 归属层:`src/stride_core/running_calibration/`(athlete baseline 单源包,纯算法层,无 DB/infra 依赖)。
> 关联:本文档替换写死的 `THRESHOLD_SPEED_RIEGEL_EXPONENT = 0.06`,根因见 commit `fix(calibration): make threshold speed track recent fitness`。

---

## 1. 目标与背景

### 1.1 要解决的问题

1. **写死的疲劳指数**:`core.py` 用全局 `THRESHOLD_SPEED_RIEGEL_EXPONENT = 0.06` 把任意时长努力投影到 1 小时阈值。这个指数对**所有用户相同**,但运动员有"速度型 vs 耐力型"的本质差异——速度-时长曲线的形状因人而异。
2. **两个子模型自相矛盾**:阈值→Riegel 投影对耐力型**偏保守**(高估掉速);`ability_snapshot` 的 race 预测对短距**偏激进**(预测 10K 快于真实 PB)。同一个用户给出不同答案。
3. **无个体化、无验证**:没有从用户自己的历史推断曲线参数,也没有用真实比赛验证预测。

### 1.2 核心思路

每个用户的**速度-时长曲线**(speed–duration curve)形状不同。这条曲线的输入数据**仓库已在计算**:`segments.best_speed_candidates` → `core._estimate_threshold_speed` 里的 `best_by_duration` 就是每个时长档的最佳成绩包络。我们要做的是从这条包络**拟合个体参数**,而非套用常数。

**速度型 / 耐力型**自然落在拟合参数的不同组合上,无需写死:

| 类型 | 表现 | 参数特征 |
|------|------|----------|
| 耐力型 | 掉速慢,曲线平 | Riegel `k` 小;CS 接近其短距速度,D′ 占比小 |
| 速度型 | 短距强,长距掉得快 | Riegel `k` 大;D′ 大(短距远高于 CS) |

---

## 2. 模型

分三层,从核心曲线到长距离修正。

### 2.1 核心曲线:Critical Speed 模型 CS + D′(2 参数)⭐

跑步版的 Critical Power(库里已有功率版 `core.estimate_critical_power`,本模型是速度版,互不替代)。

```
线性形式:   distance = CS · t + D′
等价双曲:   t = D′ / (v − CS)
```

- **CS(critical speed, m/s)** = 有氧/耐力渐近线(≈ 可持续上限,接近但略高于 LTHR/MLSS 配速)→ **耐力引擎**
- **D′(m)** = 有限的无氧距离储备 → **速度/冲刺能力**

**拟合域**:严重强度域,约 **2–20 分钟**的努力(过短受神经肌肉峰值污染,过长 CS 模型外推失真)。

### 2.2 派生标量:Riegel 个体指数 `k`

为兼容现有阈值投影,从同一条包络**额外**拟合一个标量幂律指数:

```
v(d) = v_ref · (d / d_ref)^(−k)       拟合: ln v = ln v_ref − k·ln d  (加权 OLS)
```

`k` 直接替换 `THRESHOLD_SPEED_RIEGEL_EXPONENT` 的常量用法。CS 模型缺数据时 `k` 作为更鲁棒的降级路径。

### 2.3 长距离修正:durability 因子

纯速度-时长曲线假设每次努力"满血起步",**一定高估马拉松**(后程抗疲劳是真正限制)。引入个体 durability 因子:

```
predicted_long_time = curve_extrapolation_time × durability_factor(athlete, distance)
```

`durability_factor ≥ 1`,由以下推断(数据仓库已有):
- 近期**长跑史**:最长完成距离、长跑配速(`activities`)
- **HR decoupling**:`activity_ability.l1_breakdown.hr_decoupling`(已在算)——解耦率高 → durability 差 → 因子大
- 距离越接近马拉松、用户长跑储备越不足,因子越大

> Phase 1 可先把 `durability_factor` 实现为基于"最长近期长跑 / 目标距离"比值的保守占位,Phase 2 再接 decoupling 回归。

---

## 3. 数据来源(全部已存在)

| 输入 | 来源 | 备注 |
|------|------|------|
| 最佳成绩包络 (speed, duration, conf, source) | `segments.best_speed_candidates` → `best_by_duration` | 复用,勿重算 |
| 努力时间 / 年龄(recency) | `SpeedCandidate.activity.activity_date` + `as_of_date` | 复用刚加的衰减逻辑 |
| 长跑史 | `activities`(distance_m, duration_s, date) | durability 输入 |
| HR decoupling | `activity_ability.l1_breakdown.hr_decoupling` | durability 输入,**经 adapter 读** |
| 真实比赛(验证 ground truth) | 真实活动 PB(非 `race_predictions` 表) | 留一验证 |

---

## 4. 拟合算法

### 4.1 鲁棒加权拟合

- **上包络拟合**:最佳成绩是**单边观测**(非全力只会偏慢),拟合上包络,用 **Huber / RANSAC** 鲁棒损失剔除非极限点,而非普通 OLS。
- **权重** = `recency_weight(age, half_life=90d)` × `confidence_weight`(HIGH×1.5 / LOW×0.6)× `source_weight`(timeseries×1.15)。**复用 `core._recency_weight` 与现有 projection 权重逻辑,不要另写一套。**

### 4.2 稀疏数据:跨用户 empirical-Bayes 收缩(关键)

多用户仓库 → "新用户数据少"的正解是**部分池化**,而非硬 fallback 到常数:

```
cs_shrunk = (n_eff / (n_eff + τ)) · cs_indiv + (τ / (n_eff + τ)) · cs_prior
```

- `cs_prior` / `d_prime_prior` / `k_prior` = 跨用户群体分布的均值(population prior)
- `n_eff` = 该用户的有效样本权重(加权后)
- `τ` = 收缩强度(超参,留一验证调)
- 数据多 → 几乎用自己的;数据少 → 接近群体均值,**平滑过渡,不会因 2 个点给出离谱曲线**

**层级边界(HARD)**:population prior 需要读**多个用户**的数据 → 这是 **adapter/infra 职责**,不在纯 core。
- **纯 core**:`fit_speed_duration_model(envelope, as_of_date, *, prior: ModelPrior | None)` —— 接收 prior 作为入参,只拟合**单个**用户。
- **adapter**(`stride_server/` 或 CLI 侧):跨用户聚合算出 `ModelPrior`,注入 core。
- 这样 `coach.*` 仍可依赖纯 core(满足 `.importlinter`)。

### 4.3 生理护栏 / 降级

- `k` 夹在 `[0.02, 0.10]`;CS 不超过最快短距速度;D′ ≥ 0
- 要求时长跨度足够(如至少覆盖 ~5min 与 ~30min 两端,≥3 档)
- 数据不足 → 退到 `k_prior`(群体)→ 再退到现有 `0.06` 常量(最末降级)
- 每个输出带 `CalibrationConfidence` + `CalibrationEvidence`(与现有字段一致)

---

## 5. 公共 API(纯 core,拟提议)

新模块 `src/stride_core/running_calibration/prediction.py`:

```python
@dataclass(frozen=True)
class SpeedDurationModel:
    critical_speed_mps: float | None
    d_prime_m: float | None
    riegel_k: float | None
    endurance_index: float | None      # 归一化:曲线平坦度,越高越耐力型
    speed_index: float | None          # 归一化:D′ 相对量,越高越速度型
    confidence: CalibrationConfidence
    evidence: tuple[CalibrationEvidence, ...]

@dataclass(frozen=True)
class ModelPrior:                       # adapter 跨用户聚合后注入
    cs_mps: float
    d_prime_m: float
    riegel_k: float
    strength_tau: float

@dataclass(frozen=True)
class RacePrediction:
    distance_m: float
    time_s: float
    pace_s_per_km: float
    confidence: CalibrationConfidence

def fit_speed_duration_model(
    best_by_duration: dict[float, SpeedCandidate],
    as_of_date: date,
    *,
    prior: ModelPrior | None = None,
) -> SpeedDurationModel: ...

def predict_race(
    model: SpeedDurationModel,
    distance_m: float,
    *,
    durability_factor: float = 1.0,
) -> RacePrediction: ...

def durability_factor(
    long_run_history: Sequence[RunningActivity],
    decoupling: float | None,
    distance_m: float,
) -> float: ...
```

`estimate_running_calibration` 内:用 `fit_speed_duration_model` 拿到 `riegel_k`,替换 `_riegel_threshold_projection` 里的常量;把 CS/D′/index 写入快照。

---

## 6. Schema 扩展(按单源规则)

按 CLAUDE.md "Athlete baseline metrics — single source":

1. `types.py::RunningCalibrationSnapshot` 加字段:
   `critical_speed_mps`, `d_prime_m`, `riegel_k`, `endurance_index`, `speed_index`, `speed_duration_confidence`
2. `sqlite_connector.py::RUNNING_CALIBRATION_SCHEMA` + `_ensure_columns` 加对应列(REAL / TEXT)
3. `fetch_latest` / `save_snapshot` 读写新列
4. 带 `CalibrationConfidence` + `CalibrationEvidence`,与现有字段一致

> race 预测结果可继续写现有 `race_predictions` 表(`race_type, duration_s, avg_pace`),但**改由本模型生成**,以统一两个矛盾子模型。

---

## 7. 验证(怎么证明优于 0.06)

**留一法 vs 真实比赛**:
1. 对每个有真实 PB(如 10K)的用户,拿其余努力拟合模型 → 预测该 PB → 量配速误差
2. 比较三组:个体 CS+D′ / 个体 Riegel-k / 写死 0.06
3. 指标:跨用户 **MAE(配速 s/km)** + 偏差方向(是否系统性高/低估)
4. 验收门槛:个体模型 MAE 显著低于 0.06 基线,且无系统性偏差

回归不变量测试覆盖:速度型样本(大 D′)、耐力型样本(小 k)、稀疏新用户(收缩到 prior)、马拉松 durability 折扣。

### 7.1 Phase 1 实测结果(6 名真实用户,as_of 2026-06-28)

经 `scripts/eval_threshold_model.py` 对全部 6 名用户逐个跑老(0.06)vs 新(个体 k)对比 + 留一法:

| 用户 | 类型 | 拟合 k | 阈值 老→新 | LOO 误差 老→新 | 结论 |
|------|------|--------|-----------|----------------|------|
| zhaochaoyi | 耐力 | 0.038 | 4:05→4:02 | 0.029→**0.003** | 大胜 |
| dingchentao | 耐力 | 0.033 | 3:58→3:51 | 0.072→**0.042** | 胜 |
| pan | 耐力 | 0.048 | 4:57→4:56 | 0.017→**0.005** | 胜 |
| dehua | 耐力 | 0.047 | 3:51→3:49 | 0.128→0.157 | 小负 |
| renzhen | 耐力 | 0.043 | 4:13→4:10 | 0.057→0.085 | 小负 |
| lvge | 混合 | 0.064 | 4:00→4:00 | 0.055→0.067 | 持平(k≈0.06,no-op)|

**关键发现**:

1. **LOO 聚合 MAE 老 0.0597 vs 新 0.0598 —— 基本持平**。个体 k 的价值**不在**长距外推精度,而在:
   - **响应性**:新阈值跟踪近期体能(zhaochaoyi/dingchentao 近月明显上行,老值被钉住)——这正是"阈值监测"要解决的。
   - **个体化**:k 从 0.033 到 0.064 真实分化,无一撞 clamp;耐力型正确拿到更平的 k。
2. **2 例小负(dehua/renzhen)同源**:单幂律无法拟合"短段平、长段陡"的双相曲线;留出长锚后 refit 的 k 偏平 → 高估长距。且其留出的 60min 锚 105–180d 陈旧,recency 设计本就主动降权 —— LOO 对此有偏。
3. **稳健性全部通过**:无 k 撞界、无 CS/D′ 退化、稀疏用户(lvge)优雅退回 0.06。

**据此决定**:

- **不加** k 向 0.06 的收缩。收缩会把响应性收益(真正的 benefit)交换给一个已经持平且有偏的 LOO 指标 —— 等于把模型变回 0.06。跨用户 empirical-Bayes 先验仍按 §4.2 留给稀疏新用户(Phase 2 adapter)。
- **采纳**一项标签级优化:模型 HIGH 置信度要求存在**近期(≤60d)长努力(≥45min)**,与阈值置信度口径对齐 —— 修掉实测中"短段新、长段陈旧却标 HIGH"的不一致。仅改 `speed_duration_confidence` 标签,不动 k / 阈值。
- 双相曲线的长距精度是已知单幂律局限,交由 **Phase 3 的 CS+D′ 预测 + durability**(参数已持久化,ready)。

---

## 8. TDD 实现计划(RED → GREEN 顺序)

> 每步先写失败测试,fixture 复用 `tests/stride_core/running_calibration/test_core.py::_steady_activity`。

**Phase 1 — 个体曲线拟合(MVP)**
1. `test_endurance_athlete_fits_flat_curve`:平坦包络 → 小 `riegel_k` / 高 `endurance_index`
2. `test_speed_athlete_fits_steep_curve`:短距远高于长距 → 大 D′ / 高 `speed_index`
3. `test_cs_model_recovers_known_cs_dprime`:用合成 `d = CS·t + D′` 点,拟合还原 CS/D′
4. `test_recency_and_confidence_weighting`:近期/高置信努力主导拟合
5. `test_insufficient_data_falls_back`:<3 档 → 降级到 prior/0.06,confidence ≤ LOW
6. 接线:`estimate_running_calibration` 用拟合 `k` 替换常量;旧 `test_core.py` 全绿(必要时按新语义更新断言)

**Phase 2 — 跨用户先验 + 收缩(adapter)**
7. `test_population_prior_aggregation`(adapter 层):多用户模型聚合出 prior
8. `test_shrinkage_pulls_sparse_user_to_prior`:稀疏用户向 prior 收缩;数据足用户几乎不动

**Phase 3 — race 预测 + durability**
9. `test_predict_race_matches_known_pb`:留一,预测真实 10K PB,误差 < 阈值
10. `test_marathon_applies_durability_discount`:长跑储备不足 / 高解耦 → 马拉松配速被折扣
11. `test_predictions_monotonic_in_distance`:距离越长配速越慢(无交叉)

**Phase 4 — 验证脚本**
12. 留一法对比脚本(非单测),产出个体模型 vs 0.06 的 MAE 报告

---

## 9. 非目标 / 暂不做

- 不做实时 per-activity 预测(快照级别即可)
- 不替换 `ability_snapshot` 的整体能力评分体系——只统一其中的 race-pace 预测口径
- Phase 1 的 durability 用保守占位,精细 decoupling 回归留 Phase 3

---

## 10. 开放问题

- CS 拟合域上界(15 vs 20 min)按本仓库数据分布定标
- `τ`(收缩强度)、durability 因子形态用留一验证调参
- `endurance_index` / `speed_index` 的归一化基准(跨用户分位 vs 绝对)需在 Phase 2 有了 prior 后确定
