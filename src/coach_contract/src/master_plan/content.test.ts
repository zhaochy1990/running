import assert from "node:assert/strict";
import test from "node:test";
import { MASTER_PLAN_CONTENT_VERSION, parseMasterPlanContent } from "./content.js";
import { MasterPlanV3Schema } from "./policy.js";
import { MasterPlanLenientSchema } from "./schemas.js";

/** 最小合法 v2 课表（=存量 5 行的形状：v3 之前 master_plan.content 的原样）。 */
function createV2Plan() {
  return {
    status: "draft" as const,
    goal: {
      race_name: "上海马拉松",
      distance: "FM" as const,
      race_date: "2027-11-01",
      target_time: "2:57:00",
      timezone: "Asia/Shanghai" as const,
      location: null,
    },
    start_date: "2027-07-05",
    end_date: "2027-07-11",
    total_weeks: 1,
    phases: [
      {
        name: "base" as const,
        start_date: "2027-07-05",
        end_date: "2027-07-11",
        focus: "有氧基础",
        weekly_distance_km_low: 60,
        weekly_distance_km_high: 70,
        key_session_types: ["long_run"],
        milestones: [],
        key_workouts: "周末长跑 24km",
        monitoring_triggers: [],
        coach_note: "",
        strength: { sessions_per_week: 2, focus: "下肢力量", timing: "周二/周四" },
        recovery: { focus: "睡眠", sleep_target_hours: "8", adjustment_trigger: "RHR 升高 5bpm" },
        is_completed: false,
        summary: null,
      },
    ],
    weeks: [
      {
        week_index: 1,
        week_start: "2027-07-05",
        phase_name: "base" as const,
        target_weekly_km_low: 60,
        target_weekly_km_high: 70,
        key_sessions: [],
        is_recovery_week: false,
      },
    ],
    training_principles: ["渐进负荷"],
    generated_by: "coach_agent" as const,
    version: 1 as const,
    created_at: "2027-06-28T00:00:00Z",
    updated_at: "2027-06-28T00:00:00Z",
  };
}

/** v2 课表 + 政策包四段（policy/skeleton/anchor/audit），即 master_plan.content v3。 */
function createV3Plan() {
  return {
    ...createV2Plan(),
    schema: "master-plan/v3" as const,
    snapshot_as_of: "2027-06-28",
    policy: {
      phases: [
        {
          canonical: "foundation" as const,
          name: "第一阶段·基础期",
          start_week: 1,
          end_week: 1,
          primary_goal: "aerobic_base" as const,
          training_goal: "建立有氧基础",
          block_mode: "progressive" as const,
          rationale: "赛季初有氧储备不足",
        },
      ],
      taper_weeks: 2,
      milestones: [{ phase: "foundation", signal: "周量", criterion: "连续 3 周 ≥60km" }],
      gates: [
        { phase: "foundation", signal: "RHR", criterion: "周均 RHR ≤ 基线+3", action_if_missed: "降周 15%" },
        { phase: "foundation", signal: "体感", criterion: "无持续疲劳", action_if_missed: "转吸收周" },
      ],
      volume_bands: [{ phase: "foundation", weekly_km_min: 55, weekly_km_max: 75 }],
    },
    skeleton: {
      weeks: [{ week: 1, canonical: "foundation" as const, block: 1, role: "progress" as const, km: 60, lr: 24, q: 1 }],
      blocks: [{ block: 1, canonical: "foundation" as const, start_week: 1, end_week: 1, absorb_weeks: [], boundary: "phase_start" as const }],
      recovery_policy: [{ id: "normal" as const, trigger: "体感正常", action: "常规递进", depth: "+3~8%/块" }],
      strength_policy: [{ canonical: "foundation" as const, strength_focus: "基础力量", quality_family: "E 为主", strides_note: "不计质量课" }],
      checks: [{ id: "acwr", pass: true, detail: "1.12 ≤ 1.3" }],
      milestones: [{ phase: "foundation", signal: "周量", criterion: "连续 3 周 ≥60km", week: 1 }],
    },
    anchor: {
      as_of: "2027-06-28",
      vdot: 52.9,
      vdot_source: "calibration@2027-06-20",
      seed: { ctl: 57, atl: 57 },
      coefficient_version: "lsq-20270628",
      projection: { capped: true, residual: 1 },
    },
    audit: {
      items: [{ item: "W1 Q 配额", verdict: "pass" as const, expectation: "进度周 1 节 T", actual: "1 节 T" }],
      summary: { pass: 1, warn: 0, fail: 0 },
    },
  };
}

test("存量 v2 内容无 schema 字段时按 v2 原样返回（零回归）", () => {
  const plan = createV2Plan();
  const parsed = parseMasterPlanContent(plan);
  assert.equal(parsed.contentVersion, MASTER_PLAN_CONTENT_VERSION.v2);
  // 原样：不重新套内容规则（老行不被读路径挡在门外），键值一字不改。
  assert.deepEqual(parsed.plan, plan);
});

test("v2 存量行即使违反今天的跨字段内容规则也照样可读（读路径不重跑质量门）", () => {
  const legacy = { ...createV2Plan(), total_weeks: 3, weeks: createV2Plan().weeks, training_principles: [] };
  const parsed = parseMasterPlanContent(legacy);
  assert.equal(parsed.contentVersion, MASTER_PLAN_CONTENT_VERSION.v2);
  assert.equal(parsed.plan.total_weeks, 3);
});

test("v3 政策包往返：parse → serialize → parse 等价", () => {
  const plan = createV3Plan();
  const first = parseMasterPlanContent(plan);
  assert.equal(first.contentVersion, MASTER_PLAN_CONTENT_VERSION.v3);
  assert.deepEqual(first.plan, createV3Plan());
  const rounds = parseMasterPlanContent(JSON.parse(JSON.stringify(first.plan)));
  assert.equal(rounds.contentVersion, MASTER_PLAN_CONTENT_VERSION.v3);
  assert.deepEqual(rounds.plan, first.plan);
});

test("v3 继承 v2 的全部跨字段确定性规则（政策包不改课表语义）", () => {
  // total_weeks 必须等于 weeks.length、week_index 必须从 1 连续。
  assert.equal(MasterPlanV3Schema.safeParse({ ...createV3Plan(), total_weeks: 2 }).success, false);
  const brokenWeek = createV3Plan();
  const [week] = brokenWeek.weeks;
  assert.ok(week);
  brokenWeek.weeks = [{ ...week, week_index: 2 }];
  assert.equal(MasterPlanV3Schema.safeParse(brokenWeek).success, false);
});

test("未知的 content schema 直接拒绝，不静默降级成 v2 视图", () => {
  assert.throws(() => parseMasterPlanContent({ ...createV2Plan(), schema: "master-plan/v4" }), /unsupported master_plan content schema/);
});

test("v3 保留全部 v2 字段，读方按 v2 消费不受政策包影响", () => {
  const parsed = parseMasterPlanContent(createV3Plan());
  assert.ok(parsed.contentVersion === MASTER_PLAN_CONTENT_VERSION.v3);
  const asV2 = MasterPlanLenientSchema.safeParse(parsed.plan);
  assert.equal(asV2.success, true, "v3 必须是合法的 v2 课表（读方按 v2 消费不该失败）");
  assert.deepEqual(
    { start_date: parsed.plan.start_date, end_date: parsed.plan.end_date, weeks: parsed.plan.weeks },
    { start_date: createV2Plan().start_date, end_date: createV2Plan().end_date, weeks: createV2Plan().weeks },
  );
});

test("v3 缺少政策段或课表字段时拒绝入库", () => {
  for (const key of ["policy", "skeleton", "anchor", "audit", "weeks"] as const) {
    const broken: Record<string, unknown> = createV3Plan();
    delete broken[key];
    assert.throws(() => parseMasterPlanContent(broken), /invalid|expected|Required/i, `missing ${key} must be rejected`);
  }
});

test("v3 只收政策包的 canonical 枚举与三档判定，旧枚举与自由字符串被拒", () => {
  const badPhase = createV3Plan();
  const [phase] = badPhase.policy.phases;
  assert.ok(phase);
  phase.canonical = "base" as never;
  assert.equal(MasterPlanV3Schema.safeParse(badPhase).success, false);

  const badVerdict = createV3Plan();
  const [item] = badVerdict.audit.items;
  assert.ok(item);
  item.verdict = "maybe" as never;
  assert.equal(MasterPlanV3Schema.safeParse(badVerdict).success, false);
});
