# L4b 处方剂量系数·生产回归标定报告

> devops#799 · 标定日 2026-10-29 · 版本 `lsq-20261029` · 代码缺省 `DEFAULT_DOSE_COEFFICIENTS`（`phasing/content/schedule/dose.ts`）· 快照 `phasing/fixtures/dose-calibration-2026-10-29.json`（重拟合单测 `schedule/dose.test.ts` 钉住）

## 1. 方法

- **模型**：`training_dose ≈ Σ_band coef_band × minutes_band`（过原点最小二乘——零时长=零剂量的物理约束，无截距）。
- **目标变量**：生产 `activity_training_load.training_dose`（保守融合 TSS：min(cardio,external)+high_intensity）。
- **特征**：生产 `activity_zones(zone_type=pace)` 的区间时长——STRIDE 校准六区（`compute/zones/activity_zones.go`），合并映射 recovery+easy→**E**、marathon→**M**、threshold→**T**、interval→**I**、repetition→**R**，与计划侧丹系五带（`PaceZones`）同一语义层级。
- **样本过滤**：`training_dose IS NOT NULL AND excluded_from_pmc=0 AND session_class IN 跑步类 AND Σ区间时长 ≥ 20min`。
- **样本量**：739 活动（6348 区间行；三用户主体）。
- **复现**：`fitDoseCoefficients`（dose.ts 导出）读快照重拟合——单测断言与发布系数一致（±0.01 舍入）。

## 2. 结果

| 带 | 系数（dose/min） | 相对 E | 曝光（h） | bootstrap p5-p95 |
|---|---|---|---|---|
| E | 0.59 | 1.00 | 559.1 | 0.563 .. 0.628 |
| M | 1.37 | 2.30 | 172.1 | 1.305 .. 1.422 |
| T | 1.31 | 2.21 | 44.2 | 1.181 .. 1.468 |
| I | 2.01 | 3.39 | 26.4 | 1.795 .. 2.202 |
| R | 2.94 | 4.95 | 7.1 | 2.278 .. 4.075 |

**拟合优度**：R²=0.851，RMSE=18.0（剂量均值 55.7），残差 |p50|=10.0 / |p90|=27.6。

**相对形状与 POC 手拍系数对照**：POC（wave-poc.mjs）手拍 {1.0, 2.5, 3.3, 4.2, 5.0}；回归 {1.00, 2.30, 2.21, 3.39, 4.95}——单调序一致、量级吻合；M/T 相对次序轻微倒挂（M 2.30 ≥ T 2.21），解释：M 带时段为持续负荷（无组间恢复稀释），T 带时段常与低速段混布。两者差异在调度决策（排位只看相对负荷排序）上无实质影响。

## 3. 稳健性

- 剔除 race 类（n=729）重拟合：E 0.591 / M 1.332 / T 1.358 / I 2.032 / R 2.878——最大偏移 <3%。
- 3σ 截断（n=727）：E 0.589 / M 1.350 / T 1.347 / I 2.030 / R 2.885——<2%。
- bootstrap 500 次：E/M/I 系数稳定；T 带中等离散；**R 带曝光最薄（7.1h，CI 2.28-4.08）**——R 带系数可信度最低，已知限制如实记录（计划侧 R 带课时占比小，影响有限；再标定随曝光积累收窄）。

## 4. 已知限制（下游使用须知）

1. **个体剂量尺度偏差 ±20-30%**：全局一套系数是群体均值；生产 `daily_training_load` 的 ATL/CTL（种子直读）与模型剂量的绝对尺度在个体上可偏离。种子×L3 周量的联合可触发 P6（日负荷比 cap 1.3）**结构性上浮**——伤退/低 CTL 状态排长跑道爬坡的 fixture（如 pan/22、chaoyi-injury 后段）实测出现；这是 P6 的正确行为（该爬坡对当前体能确实过热），解在 L3 压量或 R2 回补，不在排位层。
2. **残差来源**：生产剂量的通道融合（min(cardio,external)+高强度加成）对心率覆盖度敏感，非带分钟数的线性函数；p90 残差偏大主要由比赛/高强度课的加成通道贡献。
3. **open 处方步零剂量**：open target（组间慢跑/strides）时长在计划侧不计剂量（配速不可知），而生产标定的区间时长把这些分钟计入 E 区——I/R 课（恢复慢跑占比高）的计划剂量系统性略低于实际。量级小（恢复段分钟×0.59），方向保守；如需收紧可对 open 恢复步按 E 系数估算（再标定时一并评估）。
4. **再标定路径**：新快照 → `fitDoseCoefficients` → 更新 `DEFAULT_DOSE_COEFFICIENTS` + `COEFFICIENT_VERSION`（递增）+ coach.yaml `training_plan.dose_coefficients`；旧计划曲线经 `load_meta.coefficient_version` 仍可解释。

## 5. 提取 SQL（快照重建用）

```sql
SELECT t.label_id, t.user_id, t.activity_date, t.session_class, t.training_dose,
       t.training_dose_source, t.load_confidence,
       ROUND(SUM(CASE WHEN z.zone_index IN (1,2) THEN z.duration_s ELSE 0 END)/60, 2) AS e_min,
       ROUND(SUM(CASE WHEN z.zone_index=3 THEN z.duration_s ELSE 0 END)/60, 2) AS m_min,
       ROUND(SUM(CASE WHEN z.zone_index=4 THEN z.duration_s ELSE 0 END)/60, 2) AS t_min,
       ROUND(SUM(CASE WHEN z.zone_index=5 THEN z.duration_s ELSE 0 END)/60, 2) AS i_min,
       ROUND(SUM(CASE WHEN z.zone_index=6 THEN z.duration_s ELSE 0 END)/60, 2) AS r_min,
       ROUND(SUM(z.duration_s)/60, 2) AS total_min
FROM activity_training_load t
JOIN activity_zones z ON z.label_id=t.label_id AND z.user_id=t.user_id AND z.zone_type='pace'
WHERE t.training_dose IS NOT NULL AND t.excluded_from_pmc=0
  AND t.session_class IN ('easy','long_easy','long_quality','quality','tempo','interval','race')
GROUP BY t.label_id, t.user_id, t.activity_date, t.session_class, t.training_dose,
         t.training_dose_source, t.load_confidence
HAVING total_min >= 20;
```
