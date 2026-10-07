import { randomUUID } from "node:crypto";
import type { DataProvider, MasterPlanDraftSink } from "@stride/coach-agent";
import { GoDraftClient, masterPlanToDraftContent } from "@stride/coach-agent-worker";
import { getLogger } from "@stride/common";
import type { MasterPlan } from "@stride/contract";
import type { ApiConfig } from "../dto/config.js";

const logger = getLogger("coachApi:masterPlanDraftSink");

/** 落库是聊天 turn 的增值步骤，不能把 SSE 拖死在慢网络上（worker 侧默认无超时）。 */
const INSERT_TIMEOUT_MS = 10_000;

/**
 * #429 聊天内 draft 落库：training 节点生成计划后，绑定运动员当前激活的
 * race goal（Go 强制 goal_id 为真实 UUID），按 Go 存储契约补确定性 id
 * （masterPlanToDraftContent，与 plan-job worker 同一变换），经 worker 的
 * GoDraftClient 走 internal 端点插入 draft（幂等 by draft_id；Go 是 plan 表
 * 唯一写入方，ADR 0006/0030）——wire 协议只在 draftClient 一处维护。
 *
 * 一律 fail-soft：无 race goal、内容被拒、超时或网络错误都返回 null——
 * 卡片降级为无「启用」CTA，绝不打断聊天回复（node 侧还有一层兜底 catch）。
 */
export function createMasterPlanDraftSink(dataProvider: DataProvider, goApi: ApiConfig["goApi"], fetchImpl: typeof fetch = fetch): MasterPlanDraftSink {
  const client = new GoDraftClient(goApi.baseUrl, goApi.internalToken, fetchImpl, INSERT_TIMEOUT_MS);
  return async (plan, userId) => {
    try {
      const target = await dataProvider.getRaceTarget(userId);
      if (target === null) {
        logger.info({ userId }, "chat master-plan draft skipped: no active race goal");
        return null;
      }
      const content = masterPlanToDraftContent(plan, target.goal_id);
      assertWeeksLinkedToPhases(plan, content);
      const draftId = randomUUID();
      const planId = await client.insertMasterPlanDraft(userId, draftId, content);
      logger.info({ draftId, planId }, "chat master-plan draft inserted via Go internal endpoint");
      return planId;
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : undefined, userId }, "chat master-plan draft not persisted; card degrades without activate CTA");
      return null;
    }
  };
}

/**
 * 聊天侧宽松 schema（MasterPlanLenientSchema）不校验 week.phase_name ∈
 * phases[].name，也不校验 phase 名唯一——transform 会产出丢失/错绑的
 * phase_id，Go validWeek 必拒（422）。落库前显式拒绝并记具体原因，而不是
 * 让卡片静默降级成一句泛泛的 insert rejected。
 */
function assertWeeksLinkedToPhases(plan: MasterPlan, content: Record<string, unknown>): void {
  const phaseNames = plan.phases.map((phase) => phase.name);
  if (new Set(phaseNames).size !== phaseNames.length) {
    throw new Error(`plan has duplicate phase names: [${phaseNames.join(", ")}]`);
  }
  const phaseIds = new Set((content.phases as Array<{ id?: unknown }>).map((phase) => phase.id));
  const weeks = content.weeks as Array<{ phase_id?: unknown; week_index?: unknown }>;
  for (const week of weeks) {
    if (typeof week.phase_id !== "string" || !phaseIds.has(week.phase_id)) {
      throw new Error(`week ${String(week.week_index)} phase_name does not match any phase`);
    }
  }
}
