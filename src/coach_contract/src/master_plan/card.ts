import { z } from "zod/v4";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 赛季训练计划卡片（`master-plan` $type，#428）——kernel completed 产物在
 * 聊天里的结构化摘要。摘要即卡片（不做独立详情页）：goal + 阶段时间轴 +
 * 周数 + 负荷投影都走 markdown 正文，卡片 data 只携带渲染与定位需要的标量
 * （goal/周期/周数）——完整计划由服务端持有，#429 的启用/放弃在此之上加
 * plan_id（draft 落库后定位）。由 training 节点从已校验的
 * plan/simulation_report 确定性投影产出，挂在回复消息
 * additional_kwargs.card 上随 checkpoint 持久化（信封机制见
 * docs/coach_agent/structured-artifacts.md）。
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
  /** #429：draft 落库后的 plan_id，卡片「启用/放弃」CTA 的定位。缺省 = 落库
   * 流程之前的旧卡片或落库失败/无 race goal 的降级卡片，无启用 CTA。 */
  plan_id: z.string().min(1).optional(),
});
export type MasterPlanCard = z.infer<typeof MasterPlanCardSchema>;
