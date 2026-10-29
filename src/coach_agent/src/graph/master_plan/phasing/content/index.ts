/**
 * L4 内容与排位层（devops#799 两段制：L4a 内容生成 flash×1 + L4b 波浪排位
 * 纯代码）：判定表（derive）+ 校验（validators，一致性组 + 守恒组 C1-C8 +
 * C9 E 课时长分层；课包阶段 C4/C9 归排位段）+ 能力递进投影（project，
 * projectZones）+ 生成编排（generate：draft→课包→排位→全量终检统一重试环
 * →模板兜底课包+排位）+ 排位段（schedule/：剂量估算器+波浪调度器+P 门+
 * scheduleOnly）+ spike 样本迁移器（migrate，E2E 回放）。不含 kernel/weekly
 * 接线（#803）。
 *
 * 导出面=接入票（#803 kernel 接线/回放脚本）与 R0（scheduleOnly）的入口；
 * 判定表、迁移器与剂量估算器由模块内部与测试走文件直连（与 load/ 收敛惯例一致）。
 */

export type { PaceZones } from "./derive.js";
export type { ContentAthleteContext, ContentGeneratorInput, ContentRaceContext, ContentWeekRow } from "./doctrine.js";
export { templateFallback } from "./fallback.js";
export type { ContentAttemptDetail, ContentDraft, ContentModel, ScheduledOutcome } from "./generate.js";
export { createContentModel, generateWeekContent } from "./generate.js";
export type { ProjectedWeekZones, ProjectZonesMeta, ProjectZonesResult } from "./project.js";
export { projectZones } from "./project.js";
export type { WeekBag } from "./schedule/scheduler.js";
export { scheduleOnly, scheduleWeeks } from "./schedule/scheduler.js";
export type { ContentValidation, SessionUnderTest, WeekContentInput } from "./validators.js";
export { sessionKm, validateWeekContent } from "./validators.js";
