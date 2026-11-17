/**
 * 同步覆盖工具（devops#1013）：把首次同步 session 的原始/分析覆盖、as-of、
 * revision、gaps 与 pending/partial/unavailable 透传给教练模型，并附可引用的
 * 中文解释。回答近期问题前先看证据窗口；长期结论在历史未齐 / 待显式重算时
 * 必须明确受限；后台失败要给原因与出路，不能无限说「整理中」。
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider } from "../data/dataProvider.js";
import { explainSyncCoverage } from "../data/syncCoverage.js";
import { defineCoachTools } from "./common.js";

const getSyncCoverageSchema = z.object({});

/** 无 session 时的固定说明：rollout 默认关 / 老用户走旧管线，null ≠ 数据不存在。 */
const NO_SESSION_NOTE =
  "该用户没有首次同步 session（老用户，或分阶段同步尚未开启）。这不代表数据缺失：按工具实际查到的数据说明覆盖，不要凭 session 缺失断言历史完整或不完整。";

class SyncCoverageTool {
  constructor(private readonly store: Pick<DataProvider, "getSyncCoverage">) {}

  async getSyncCoverage(_input: z.infer<typeof getSyncCoverageSchema>, runtime: CoachToolRuntime) {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_sync_coverage: missing userId in runtime context");
    }
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("get_sync_coverage: missing asof in runtime context");
    }
    const coverage = await this.store.getSyncCoverage(userId);
    if (coverage == null) {
      return { hasSession: false, note: NO_SESSION_NOTE, provenance: { source: "stride", vendor_derived: false } };
    }
    return {
      hasSession: true,
      session: {
        state: coverage.state,
        provider: coverage.provider,
        anchorDay: coverage.anchorDay,
        bindingRevision: coverage.bindingRevision,
        updatedAt: coverage.updatedAt,
      },
      readiness: coverage.readiness,
      stages: coverage.stages.map((stage) => ({
        stage: stage.stage,
        readiness: stage.readiness,
        target: `${stage.targetFrom}~${stage.targetTo}`,
        scanned: stage.scannedFrom != null && stage.scannedTo != null ? `${stage.scannedFrom}~${stage.scannedTo}` : null,
        observed: stage.observedFrom != null && stage.observedTo != null ? `${stage.observedFrom}~${stage.observedTo}` : null,
        gaps: stage.gaps,
        error: stage.error,
      })),
      explanation: explainSyncCoverage(coverage, asof.slice(0, 10)),
      provenance: { source: "stride", vendor_derived: false },
    };
  }
}

export function createSyncCoverageTools(store: Pick<DataProvider, "getSyncCoverage">): StructuredTool[] {
  const impl = new SyncCoverageTool(store);
  return defineCoachTools([
    {
      name: "get_sync_coverage",
      description:
        "获取运动员首次手表同步的覆盖状态（devops#1013）：近期数据/分析的已获得证据窗口、分析 as-of 与可用域、历史补齐进度、缺口与失败原因。" +
        "回答「我最近的训练怎么样」前先看近期证据窗口；回答长期趋势、历史 PB、多年负荷、训练画像前必须先查本工具——历史未补齐或历史指标待显式重算（pending_explicit_recompute）时，长期结论要明确说明受限。" +
        "用户问「数据什么时候好/为什么还没有」时也用本工具：失败要给具体原因，不要说成「整理中」。无输入参数。",
      schema: getSyncCoverageSchema,
      handler: (input, runtime) => impl.getSyncCoverage(input, runtime),
    },
  ]);
}
