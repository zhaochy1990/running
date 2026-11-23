import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, MasterPlanV3Schema, type WeeklyPlan } from "@stride/contract";
import { masterPlanToContent } from "../../agents/training/content.js";
import { FrozenMasterPlanContextProvider } from "../master_plan/context.js";
import { createAssessmentSnapshot, createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "../master_plan/testFixtures.js";
import { runRollingProjection } from "./projection.js";
import { fromStoredContent } from "./storedContent.js";

/**
 * 排课可用度跨入口往返（devops#1043）：首次确认请求的禁跑日随 content 落库 →
 * 滚动 job 从存量读回 → 真实滚动内核（L1→L3→L4 排位+门禁+审计）排出的周课
 * 同样避开该日；批首周接上一周的实绩 + 仍生效的存量课表。
 */

const START_DATE = "2026-08-10";
const TOTAL_WEEKS = 18;
/** 批窗从第 13 周起（专项期整段，与 taperAuditRegression 同构）。 */
const START_WEEK = 13;
const WEEKDAY_OF = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/** 存量计划：18 周、专项期自第 13 周起；可用度=禁跑周四、单课 ≤150min、不允许双练。 */
function storedPlan(): ReturnType<typeof fromStoredContent> {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: TOTAL_WEEKS });
  const foundation = artifact.policy.phases[0]!;
  const policy = {
    ...artifact.policy,
    phases: [
      { ...foundation, end_week: START_WEEK - 1 },
      {
        ...foundation,
        canonical: "final_quality" as const,
        name: "专项期",
        start_week: START_WEEK,
        end_week: TOTAL_WEEKS,
        primary_goal: "race_specificity" as const,
        block_mode: "plateau" as const,
      },
    ],
    taper_weeks: 3,
    volume_bands: [
      { phase: foundation.name, weekly_km_min: 60, weekly_km_max: 90 },
      { phase: "专项期", weekly_km_min: 70, weekly_km_max: 100 },
    ],
  };
  const content = masterPlanToContent(
    { ...artifact.plan, goal: { ...artifact.plan.goal, race_date: addDays(artifact.plan.start_date, TOTAL_WEEKS * 7 - 1) } },
    "goal-test",
    {
      weekly_run_days_max: 6,
      available_training_windows: [],
      unavailable_days: ["thursday"],
      max_session_duration_min: 150,
      allows_double_sessions: false,
    },
  );
  Object.assign(content, { policy, skeleton: artifact.skeleton, anchor: artifact.anchor });
  // 落库 schema 接受带明细的 availability（Go 侧同款 JSON schema）
  assert.equal(MasterPlanV3Schema.shape.availability.safeParse(content.availability).success, true);
  return fromStoredContent({
    content: JSON.parse(JSON.stringify(content)) as Record<string, unknown>,
    masterPlanId: "plan-test",
    lastGeneratedWeek: START_WEEK - 1,
  });
}

/** 第 12 周（批窗前一周）的存量周课：周五、周日跑步，其余休息。 */
function previousWeekDoc(): WeeklyPlan {
  const doc = createTestWeeklyPlanDoc(START_WEEK - 1) as WeeklyPlan;
  const weekStart = addDays(START_DATE, (START_WEEK - 2) * 7);
  const rest = (offset: number): WeeklyPlan["sessions"][number] => ({ ...doc.sessions[1]!, date: addDays(weekStart, offset) });
  const run = (offset: number): WeeklyPlan["sessions"][number] => ({
    schema: "plan-session/v1",
    date: addDays(weekStart, offset),
    session_index: 0,
    kind: "run",
    summary: "有氧跑",
    notes_md: null,
    total_distance_m: 8000,
    total_duration_s: 2880,
    estimated_dose: 47.2,
    spec: null,
  });
  return { ...doc, sessions: [rest(0), rest(1), rest(2), rest(3), run(4), rest(5), run(6)] };
}

test("滚动续排：存量 content 回读可用度 → 真实内核排出的周课避开禁跑日；批首周接实绩 + 仍生效的存量课表", async () => {
  const master = storedPlan();
  assert.deepEqual(master.availability.detail, {
    available_training_windows: [],
    unavailable_days: ["thursday"],
    max_session_duration_min: 150,
    allows_double_sessions: false,
  });
  // 生成时点=第 12 周周三：该周周一~周三按实绩、周四~周日按存量周安排
  const asOf = addDays(START_DATE, (START_WEEK - 2) * 7 + 2);
  const activities = Array.from({ length: 28 + TOTAL_WEEKS }, (_, index) =>
    Array.from({ length: 6 }, (_, day) => ({
      shanghaiDay: addDays(START_DATE, (index - 28) * 7 + day),
      name: "稳定有氧训练",
      sport: "run",
      distanceM: 80000 / 6,
      strideSessionClass: "easy",
      durationS: 4000,
    })),
  ).flat();
  const previousMonday = addDays(START_DATE, (START_WEEK - 2) * 7);
  const askedWeeks: string[] = [];
  const outcome = await runRollingProjection(
    {
      contextProvider: new FrozenMasterPlanContextProvider(createAssessmentSnapshot(), activities),
      models: {
        phasingModel: {
          invoke: async () => {
            throw new Error("滚动不重跑 L2");
          },
        },
        contentModel: {
          invoke: async () => {
            throw new Error("使用既有确定性模板兜底");
          },
        },
      },
      existingWeeklyDoc: async (weekStart) => {
        askedWeeks.push(weekStart);
        return weekStart === previousMonday ? previousWeekDoc() : null;
      },
    },
    { userId: "athlete-test", master, asOf: `${asOf}T10:00:00+08:00` },
  );
  assert.equal(outcome.decision, "completed", JSON.stringify(outcome));
  if (outcome.decision !== "completed") return;
  assert.deepEqual(askedWeeks, [previousMonday], "只读批首周之前一周的存量周文档");

  // 续排同样避开禁跑日；P8 可跑日门全过
  const runDates = outcome.weeklyDocs.flatMap((doc) => doc.sessions.filter((session) => session.kind === "run").map((session) => session.date));
  assert.ok(runDates.length > 0);
  assert.ok(
    runDates.every((date) => WEEKDAY_OF(date) !== 3),
    `续排课表落在禁跑日（周四）：${runDates.filter((date) => WEEKDAY_OF(date) === 3).join(",")}`,
  );
  assert.ok(outcome.scheduled.scheduleChecks.flat().every((check) => check.pass));
  assert.ok(
    outcome.scheduled.scheduleChecks.flat().some((check) => check.id === "P8 可跑日"),
    "可跑日门生效",
  );

  // 批首周的边界：周一~周三实绩（跑步）、周四~周日的存量安排（周五、周日跑步）
  const prefix = outcome.scheduled.distribution[0]!.prefix;
  assert.equal(prefix[6]!.date, addDays(previousMonday, 6));
  assert.deepEqual(
    prefix.map((day) => day.run),
    [true, true, true, false, true, false, true],
  );
  assert.deepEqual(
    prefix.slice(3).map((day) => day.loadPt),
    [0, 47.2, 0, 47.2],
  );
  // 存量跑步会话没有 spec——关键课属性未知（不猜）；休息日按安排确定不是关键课
  assert.deepEqual(
    prefix.slice(3).map((day) => day.key),
    [false, null, false, null],
  );
});

test("存量计划只有天数上限（#1043 之前落库）：回读不带明细，续排按具体日期未知处理", () => {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const content = masterPlanToContent(artifact.plan, "goal-test", { weekly_run_days_max: 5 });
  Object.assign(content, { policy: artifact.policy, skeleton: artifact.skeleton, anchor: artifact.anchor });
  const master = fromStoredContent({ content, masterPlanId: "plan-test", lastGeneratedWeek: 6 });
  assert.deepEqual(master.availability, { weeklyRunDaysMax: 5, strength: null }); // 未设置力量偏好（#222）
});
