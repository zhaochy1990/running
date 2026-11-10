/**
 * 偏差检测阈值单源（#858 PR-B）：detect 层所有可调口径集中于此，代码里
 * 禁止出现裸数字阈值。默认值在 #800 文档终审前先钉住（PR-F 要把本文件
 * 抄进文档）；改这里=改产品口径，须同步文档与追问弹窗文案。
 *
 * 边界语义（配单测 detect/*.test.ts 的边界用例）：
 *   - PACE_SLOW_PCT 用 ≥：4.9% 不算练差、5.0% 算；
 *   - MISSED_RATIO / SEVERE_RATIO 用 <：79.9% 算没完成、80.0% 不算；
 *   - OVER_RATIO 取等号即触发：124% 不算超量、125% 算（与边界用例一致）。
 */

/** 质量课配速慢多少百分比算「练差」（paceDeltaPct ≥ 5 触发；E 课/LR 不算练差依据）。 */
export const PACE_SLOW_PCT = 5;

/** 周完成率（实际/计划）低于此值算「没练完」（< 0.8 触发）。 */
export const MISSED_RATIO = 0.8;

/** 周完成率低于此值算「严重」（< 0.6 触发；或质量课全缺，见 detector）。 */
export const SEVERE_RATIO = 0.6;

/** 周完成率不低于 125% 算「超量」（≥ 1.25 触发）。 */
export const OVER_RATIO = 1.25;

/** 计划课↔实际活动日期匹配窗（天）：同日权重最高，±1 日仍可配（漂移容忍）。 */
export const MATCH_DATE_WINDOW_DAYS = 1;

/** 距离接近度容差：|实际−计划|/计划 ≤ 0.35 才可配（差 50% 明确不配）。 */
export const MATCH_DISTANCE_TOLERANCE = 0.35;

/** 匹配评分权重（同日 > 距离 > 课型，综合分降序贪心一对一）。 */
export const MATCH_WEIGHT_DATE = 0.4;
export const MATCH_WEIGHT_DISTANCE = 0.3;
export const MATCH_WEIGHT_CLASS = 0.3;

/** 同日日期分 =1，±1 日降为该值（可配但置信度记 medium）。 */
export const MATCH_ADJACENT_DAY_SCORE = 0.6;

/** 计划距离缺失时的中性距离分（不奖不罚，靠日期+课型定胜负）。 */
export const MATCH_NEUTRAL_DISTANCE_SCORE = 0.5;

/** 活动无 session_class 时的通配课型分（可配但低于显式相容）。 */
export const MATCH_NULL_CLASS_SCORE = 0.4;

/** 浮点边界容差（0.8/1.25 这类十进制阈值在二进制浮点下的相等判定）。 */
export const RATIO_EPSILON = 1e-9;
