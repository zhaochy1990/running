// 赛季训练计划服务层 —— #428 起卡片契约的客户端镜像。当前只承载教练会话里
// `master-plan` 卡片信封的数据形状（coach_contract MasterPlanCardSchema 镜像，
// 数值口径由后端 zod 把关）；卡片 data 只带渲染/定位需要的标量摘要，阶段
// 时间轴与负荷投影走 markdown 正文。#429 的 draft 落库/启用流程在此扩展
// 端点与 plan_id。

/** 赛季目标（卡片的 goal 摘要）。 */
export interface MasterPlanCardGoal {
  race_name: string;
  distance: 'FM' | 'HM';
  race_date: string;
  /** h:mm:ss 目标成绩；完赛为目标时空串。 */
  target_time: string;
}

/** `master-plan` 卡片信封的 data（MasterPlanCardSchema 镜像）。 */
export interface MasterPlanCard {
  goal: MasterPlanCardGoal;
  start_date: string;
  end_date: string;
  total_weeks: number;
}
