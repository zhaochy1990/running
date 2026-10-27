/**
 * 内容层测试/回放共用件（与 load/testSupport.ts 惯例一致）：L3 canonical →
 * 强度家族提示（ContentWeekRow.qualityFamily 的行构建用），fallback.test 与
 * tests/contentReplay.ts 共享，防三处拷贝漂移。
 */

export const QUALITY_FAMILY_OF: Record<string, string> = {
  recovery: "无质量课（纯 E + strides 触感）",
  foundation: "E 为主；速度触感靠 strides 副课",
  early_quality: "R 重复（速度经济性）",
  transition_quality: "I/T（冬季以 T 为主）",
  final_quality: "M 配速比赛专项",
};
