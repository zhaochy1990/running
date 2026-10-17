import { z } from "zod/v4";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 赛季训练计划卡片（`master-plan` $type，#428）——kernel completed 产物在
 * 聊天里的结构化摘要。摘要即卡片（不做独立详情页）：goal + 阶段时间轴 +
 * 周数 + 负荷投影都走 markdown 正文，卡片 data 携带渲染需要的标量 + 完整
 * v2 计划 content（masterPlanToContent 变换产出）+ apply_token——生成不落
 * 库（#585），运动员点「应用」时凭 content + apply_token 调用户端 apply
 * 端点落库。由 training 节点从已校验的 plan/simulation_report 确定性投影
 * 产出，挂在回复消息 additional_kwargs.card 上随 checkpoint 持久化（信封
 * 机制见 docs/coach_agent/structured-artifacts.md）。
 */
export const MasterPlanCardSchema = z.object({
  goal: z.object({
    race_name: z.string().min(1),
    distance: z.enum(["FM", "HM"]),
    race_date: z.string().regex(DAY),
    /** h:mm:ss 目标成绩；完赛为目标时空串。 */
    target_time: z.string(),
  }),
  start_date: z.string().regex(DAY),
  end_date: z.string().regex(DAY),
  total_weeks: z.int().positive(),
  /** #585 apply-from-content：完整 v2 计划 doc（Go validateStructuredPlanDoc
   * 的输入形态）+ 一次性 apply_token（幂等键）。两者成对出现；缺省 = 降级
   * 卡片（无 race goal / 变换被拒）或 #585 之前的旧卡片（只带 plan_id），
   * 无「应用」CTA。 */
  apply_token: z.string().min(1).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type MasterPlanCard = z.infer<typeof MasterPlanCardSchema>;
