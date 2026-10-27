/**
 * L4 内容层（devops#807 契约 + devops#811 生成）：判定表（derive）+ 校验
 * （validators，一致性组 + 守恒组 C1-C8 + C9 E 课时长分层）+ 能力递进投影
 * （project，projectZones）+ 生成编排（generate：flash×1 整块 → 校验 → 重试 ≤2
 * → 模板兜底）+ spike 样本迁移器（migrate，E2E 回放）。不含 kernel/weekly
 * 接线（#803）。
 *
 * 导出面=接入票（#803 kernel 接线/回放脚本）的入口。判定表、迁移器与兜底
 * 器由模块内部与测试走文件直连（与 load/ 收敛惯例一致）。
 */

export type { PaceZones } from "./derive.js";
export type { ContentAthleteContext, ContentGeneratorInput, ContentRaceContext, ContentWeekRow } from "./doctrine.js";
export type { WeekContentResult } from "./fallback.js";
export type { ContentDraft, ContentModel, ContentOutcome } from "./generate.js";
export { createContentModel, generateWeekContent } from "./generate.js";
export type { ProjectedWeekZones, ProjectZonesMeta, ProjectZonesResult } from "./project.js";
export { projectZones } from "./project.js";
export type { ContentValidation, SessionUnderTest, WeekContentInput } from "./validators.js";
export { sessionKm, validateWeekContent } from "./validators.js";
