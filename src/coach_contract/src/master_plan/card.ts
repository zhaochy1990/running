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

/**
 * 训练计划创建表单卡（`master-plan-form` $type，#1024 R2）——聊天侧创建入口
 * 的第一张卡：training 节点做一次快 LLM 槽位补全（从对话提取比赛/日期/目标/
 * 习惯），产出预填表单挂在回复消息上；运动员在卡片上确认/修改后由小程序
 * 组装 kernel request 直投 plan-jobs（提交即确认 = user_confirmations 全真，
 * 异步 worker 生成，R1/R3 进度卡由客户端本地渲染轮询）。字段允许空串 = 待
 * 用户填写；生成时才做完整性校验（MasterPlanGraphRequest zod）。
 */
export const WEEKDAY_VALUES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAY_VALUES)[number];

export const MasterPlanFormCardSchema = z.object({
  goal: z.object({
    /** 空串 = 待用户填写（LLM 没提取到比赛名）。 */
    race_name: z.string().max(60),
    distance: z.enum(["FM", "HM"]),
    /** 空串 = 待用户填写；否则 YYYY-MM-DD。 */
    race_date: z.string(),
    /** h:mm:ss 目标成绩；空串 = 待填写。 */
    target_time: z.string(),
  }),
  availability: z.object({
    weekly_days: z.array(z.enum(WEEKDAY_VALUES)),
    preferred_long_run_day: z.enum(WEEKDAY_VALUES).nullable(),
  }),
  /** 近期训练基础（自由文本，可空；进 kernel request preferences）。 */
  base: z.string().max(200),
  /** 伤病或其他限制（自由文本，可空；进 kernel request injury/约束面）。 */
  restriction: z.string().max(200),
});
export type MasterPlanFormCard = z.infer<typeof MasterPlanFormCardSchema>;

/**
 * training 节点槽位补全 LLM 的宽松输出信封（快模型直出 JSON；字符串一律
 * 宽松收口，规范化（日期斜杠/中文星期/距离词）在节点侧做，解析失败按普通
 * 文本回复透传，绝不臆造表单。
 */
export const MasterPlanFormEnvelopeSchema = z.object({
  disposition: z.enum(["form", "clarify"]),
  /** clarify 时给运动员的话；form 时可选附一句话。 */
  message: z.string().optional(),
  form: z
    .object({
      race_name: z.string().optional(),
      distance: z.string().optional(),
      race_date: z.string().optional(),
      target_time: z.string().optional(),
      weekly_days: z.array(z.string()).optional(),
      long_run_day: z.string().optional(),
      base: z.string().optional(),
      restriction: z.string().optional(),
    })
    .optional(),
});
export type MasterPlanFormEnvelope = z.infer<typeof MasterPlanFormEnvelopeSchema>;
