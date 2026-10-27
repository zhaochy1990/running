import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunWorkoutSchema } from "@stride/contract";
import { ATHLETES } from "../fixtureLoader.js";
import type { PaceZones } from "./derive.js";
import { migrateSpikeSession, migrateSpikeWeek, type SpikeSession, SpikeWeekSchema } from "./migrate.js";
import { validateWeekContent } from "./validators.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../fixtures/l4-e2e-shanghai.json");

/** 周一锚点（合成日期：真实 date 由 L5 填，此处只需 date 语义合法且周内可去重）。 */
const WEEK1_MONDAY = "2026-10-19";
/** 赛周（第 6 周）周日=比赛日。 */
const RACE_DATE = "2026-11-29";
const weekMonday = (weekNo: number) => {
  const d = new Date(`${WEEK1_MONDAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (weekNo - 1) * 7);
  return d.toISOString().slice(0, 10);
};

const spikeSession = (over: Partial<SpikeSession> & Pick<SpikeSession, "type" | "segments">): SpikeSession => ({
  day: "Mon",
  name: "测试课",
  km: 10,
  note: null,
  ...over,
});

test("机械映射：main/strides→work、配速双空→open、name/note 保留、type 透传", () => {
  const migrated = migrateSpikeSession(
    spikeSession({
      day: "Wed",
      type: "E",
      name: "E 10km 含快步",
      km: 10,
      note: null,
      segments: [
        { kind: "main", distance_m: 9600, time_s: null, pace_s_km_min: 288, pace_s_km_max: 336 },
        { kind: "strides", distance_m: 100, time_s: null, pace_s_km_min: null, pace_s_km_max: null },
      ],
    }),
    "2026-11-04",
  );
  assert.equal(RunWorkoutSchema.safeParse(migrated).success, true);
  assert.equal(migrated.type, "E");
  assert.equal(migrated.name, "E 10km 含快步");
  assert.equal(migrated.purpose!.includes("快步跑"), true);
  const [body, stride] = migrated.blocks[0]!.steps;
  assert.equal(body!.step_kind, "work");
  assert.deepEqual(body!.target, { kind: "pace_s_km", low: 288, high: 336 });
  assert.equal(stride!.step_kind, "work");
  assert.deepEqual(stride!.target, { kind: "open", low: null, high: null });

  const quality = migrateSpikeSession(
    spikeSession({
      type: "LR",
      segments: [
        { kind: "main", distance_m: 11000, time_s: null, pace_s_km_min: 288, pace_s_km_max: 336 },
        { kind: "work", distance_m: 3000, time_s: null, pace_s_km_min: 249, pace_s_km_max: 288 },
      ],
    }),
    "2026-11-08",
  );
  assert.equal(quality.type, "LR");
  assert.equal(quality.purpose!.includes("尾段"), true);
});

test("date 派生：周一锚点 + day 偏移", () => {
  const week = migrateSpikeWeek(
    {
      week_no: 6,
      sessions: [spikeSession({ day: "Sun", type: "E", segments: [{ kind: "main", distance_m: 5000, time_s: null, pace_s_km_min: 288, pace_s_km_max: 336 }] })],
    },
    weekMonday(6),
  );
  assert.equal(week[0]!.workout.date, RACE_DATE);
});

test("机械不猜：配速区间半空/无 duration/distance 与 time 双值 抛错", () => {
  assert.throws(() =>
    migrateSpikeSession(
      spikeSession({ type: "E", segments: [{ kind: "main", distance_m: 5000, time_s: 1800, pace_s_km_min: null, pace_s_km_max: null }] }),
      "2026-11-02",
    ),
  );
  assert.throws(() =>
    migrateSpikeSession(
      spikeSession({ type: "E", segments: [{ kind: "main", distance_m: 5000, time_s: null, pace_s_km_min: 288, pace_s_km_max: null }] }),
      "2026-11-02",
    ),
  );
  assert.throws(() =>
    migrateSpikeSession(
      spikeSession({ type: "E", segments: [{ kind: "main", distance_m: null, time_s: null, pace_s_km_min: null, pace_s_km_max: null }] }),
      "2026-11-02",
    ),
  );
});

test("E2E 重判：spike 七值样本迁移 V1 后六周 一致性+C1-C8 全绿（#807 验收 D）", async () => {
  const raw = JSON.parse(await readFile(FIXTURE, "utf8")) as {
    input: {
      week_rows: Array<{ no: number; total_km: number; long_run_km: number | null; quality_sessions: number }>;
      pace_zones: Record<"easy" | "m" | "t" | "i" | "r", [number, number] | [null, number]>;
    };
    output: { weeks: unknown[] };
    gates: Record<string, Array<{ id: string; pass: boolean }>>;
  };
  const z = raw.input.pace_zones;
  const zones: PaceZones = {
    easy: [z.easy[0], z.easy[1]],
    m: [z.m[0], z.m[1]],
    t: [z.t[0], z.t[1]],
    i: [z.i[0], z.i[1]],
    r: [z.r[0], z.r[1]],
  };
  const maxTrainingDays = ATHLETES.chaoyi.weeklyRunDaysMax;
  assert.equal(raw.output.weeks.length, 6);

  for (const weekRaw of raw.output.weeks) {
    const week = SpikeWeekSchema.parse(weekRaw);
    const row = raw.input.week_rows.find((r) => r.no === week.week_no)!;
    // 前置：spike 自带门 1-5 周全绿；第 6 周差异恰为 G2（赛周 lr=null 语义 spike
    // 未实现）与 G7（比赛课豁免）——本票判定表正是把这两条豁免正式化。
    const spikeFails = raw.gates[String(week.week_no)]!.filter((g) => !g.pass).map((g) => g.id);
    if (week.week_no < 6) assert.deepEqual(spikeFails, [], `week ${week.week_no} spike gates not all green`);
    else assert.deepEqual(spikeFails, ["G2 长跑唯一且合值", "G7 质量课结构完整"], "week 6 spike fails should be exactly the two formalized exemptions");

    const migrated = migrateSpikeWeek(week, weekMonday(week.week_no));
    const checks = validateWeekContent({
      sessions: migrated,
      row: { total_km: row.total_km, long_run_km: row.long_run_km, quality_sessions: row.quality_sessions },
      zones,
      maxTrainingDays,
      ...(week.week_no === 6 ? { raceDate: RACE_DATE } : {}),
    });
    for (const c of checks) assert.equal(c.pass, true, `week ${week.week_no} ${c.id}: ${c.detail}`);
  }
});
