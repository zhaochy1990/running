import assert from "node:assert/strict";
import { test } from "node:test";
import { type MasterPlanGraphRequest, MasterPlanGraphRequest as MasterPlanGraphRequestSchema } from "@stride/contract";
import { FrozenMasterPlanContextProvider } from "./context.js";
import { MasterPlanNodes } from "./nodes.js";
import { templateFallback } from "./phasing/content/fallback.js";
import { type ContentDraft, ContentDraftSchema, type ContentModel } from "./phasing/content/generate.js";
import { buildPhaseEvidence } from "./phasing/evidence.js";
import { createAssessmentSnapshot, createTestCompletedOutcomeV3, createTestRequest } from "./testFixtures.js";

/**
 * 内核内容节点的排课可用度接线（devops#1043）：用真实形态的确认请求（availability
 * 带日内窗口/禁跑日/单课时长上限/双练许可 + 首选长跑日/力量项）跑 content 节点，
 * 可用度与历史边界确实进入排位段；周日与长跑位型冲突时具体原因随失败上浮。
 */

const AS_OF = "2026-08-09T10:00:00+08:00"; // 周日 → 首周周一 2026-08-10
const START_MONDAY = "2026-08-10";
/** 近 10 个月每周一~周六各一次有氧跑（周日休）。 */
const ACTIVITIES = Array.from({ length: 40 }, (_, index) =>
  Array.from({ length: 6 }, (_, day) => ({
    shanghaiDay: new Date(new Date(`${START_MONDAY}T00:00:00Z`).getTime() + ((index - 40) * 7 + day) * 86_400_000).toISOString().slice(0, 10),
    name: "稳定有氧训练",
    sport: "run",
    distanceM: 80000 / 6,
    strideSessionClass: "easy",
    durationS: 4000,
    strideDose: 45,
  })),
).flat();

/** 模板课包当模型输出（零 LLM；排位、门禁、分布优化、审计全走真实代码）。 */
const contentModel: ContentModel = {
  invoke: async (input) =>
    ContentDraftSchema.parse({
      weeks: templateFallback(input).map(({ week, courses }) => ({
        week_no: week,
        courses: courses.map((course) =>
          course.kind === "e-slot"
            ? { type: "E", band: course.band, strides: course.strides }
            : { name: course.name, type: course.type, purpose: course.purpose, note: course.note, blocks: course.blocks },
        ),
      })),
    }) as ContentDraft,
};

async function runContentNode(availability: Partial<MasterPlanGraphRequest["availability"]>) {
  const parsed = MasterPlanGraphRequestSchema.parse({
    ...createTestRequest(),
    requested_as_of: AS_OF,
    availability: { ...createTestRequest().availability, ...availability },
  });
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const evidence = buildPhaseEvidence(
    createAssessmentSnapshot(),
    ACTIVITIES,
    { raceName: "西安马拉松", distance: "FM", targetTime: "2:50:00", weeklyRunDaysMax: parsed.availability.weekly_run_days_max },
    "2026-08-09",
  );
  const nodes = new MasterPlanNodes({
    contextProvider: new FrozenMasterPlanContextProvider(createAssessmentSnapshot(), ACTIVITIES),
    goalAssessmentModel: {} as never,
    phasingModel: {} as never,
    contentModel,
  });
  return nodes.content({
    request: parsed,
    context: { userId: "athlete-test", generationId: "gen-test" },
    evidence,
    skeleton: artifact.skeleton,
    activities: ACTIVITIES,
  } as never);
}

test("content 节点：真实形态请求的可用度与历史边界进入排位段，批次产物带分布留痕", async () => {
  const update = await runContentNode({ available_training_windows: [], unavailable_days: [] });
  assert.equal(update.outcome, undefined, JSON.stringify(update.outcome));
  const scheduled = update.scheduled!;
  assert.ok(scheduled.weeks.length > 0);
  assert.equal(scheduled.distribution.length, update.contentInput!.rows.filter((row) => row.role !== "race").length, "每个常规周一份分布留痕");
  assert.deepEqual(update.contentInput!.availability, {
    availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
    maxSessionDurationMin: 180,
    allowsDoubleSessions: false,
  });
  // 首周接已知历史：上周一~周六有实绩（跑步）；生成当天（上周日）还没跑≠休息，记未知
  const boundary = update.contentInput!.boundary!;
  assert.equal(boundary.length, 7);
  assert.equal(boundary[6]!.date, "2026-08-09");
  assert.deepEqual(
    boundary.map((day) => day.run),
    [true, true, true, true, true, true, null],
  );
  assert.ok(scheduled.scheduleChecks.flat().every((check) => check.pass));
  assert.ok(scheduled.checks.flat().every((check) => check.pass));
});

test("content 节点：禁跑日进入排位（P8 生效），续排所需的明细原样挂在生成输入上", async () => {
  const update = await runContentNode({ available_training_windows: [], unavailable_days: ["thursday", "friday"], weekly_run_days_max: 5 });
  assert.equal(update.outcome, undefined, JSON.stringify(update.outcome));
  const dates = update.scheduled!.weeks.flatMap((week) => week.sessions.map((session) => session.date));
  assert.ok(dates.length > 0);
  const weekdayOf = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  assert.ok(
    dates.every((date) => weekdayOf(date) !== 3 && weekdayOf(date) !== 4),
    "周四/周五禁跑日无课",
  );
  assert.deepEqual(update.contentInput!.availability!.availableWeekdays, [0, 1, 2, 5, 6]);
});

test("content 节点：周日禁跑与长跑周日位型冲突 → 质量失败并带具体冲突（不再是悄悄排在周日）", async () => {
  const update = await runContentNode({});
  assert.equal(update.scheduled, undefined);
  assert.equal(update.outcome?.decision, "failed_quality_gate");
  if (update.outcome?.decision !== "failed_quality_gate") return;
  assert.deepEqual(update.outcome.artifact.unresolved_issues.slice(0, 1), ["content_generation_failed"]);
  assert.match(update.outcome.artifact.unresolved_issues.join(";"), /content_conflict:.*周日为不可跑日——长跑须排周日/);
});
