/**
 * L4 内容层（devops#807，#796 三轮 grilling 拍板）：run-workout/v1 之上的
 * 判定表（derive）+ 校验（validators，一致性组 + 守恒组 C1-C8）+ spike 样本
 * 迁移器（migrate，E2E 验收 D）。不含 LLM 生成器与重试编排（#796 剩 ④⑤ 另票）、
 * 不含 kernel 接入（#803）。
 *
 * 导出面=未来接入票（生成器/重试）的入口：周级校验器与其入参类型。判定表
 * 与迁移器件由模块内部与测试走文件直连（与 load/ 收敛惯例一致）。
 */

export type { PaceZones } from "./derive.js";
export type { ContentValidation, SessionUnderTest, WeekContentInput } from "./validators.js";
export { validateWeekContent } from "./validators.js";
