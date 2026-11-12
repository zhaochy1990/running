/**
 * 偏差检测层（#858 PR-B）公开面：阈值单源 / 计划课↔活动匹配 / 周偏差判定。
 * 全部纯函数（零 LLM、零 DB）——activities 由调用方（PR-C 夜检/追问弹窗）传入。
 */

export * from "./detector.js";
export * from "./matcher.js";
export * from "./thresholds.js";
