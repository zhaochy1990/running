import assert from "node:assert/strict";
import { test } from "node:test";
import { RACE_DISTANCES_M } from "@stride/contract";
import { createAssessmentSnapshot } from "../../testFixtures.js";
import { buildPhaseEvidence } from "../evidence.js";
import { halfMarathonTrainingPace, runwayWeeks } from "../racePolicy.js";
import type { ContentGeneratorInput } from "./doctrine.js";
import { templateFallback } from "./fallback.js";
import { generateWeekContent, validateWeekBag } from "./generate.js";
import { projectZones } from "./project.js";
import { validateWeekContent } from "./validators.js";

function raceInput(date: string, target = 7200): ContentGeneratorInput {
  const projection = projectZones(45, target, RACE_DISTANCES_M.HM, 12);
  const week = projection.weeks[0]!;
  const goal = target / (RACE_DISTANCES_M.HM / 1000);
  return {
    rows: [
      {
        distance: "HM",
        specificPaceSKm: halfMarathonTrainingPace(week.vdot, goal),
        week: 1,
        phase: "final_quality",
        role: "race",
        totalKm: 21.0975,
        longRunKm: null,
        qualitySessions: 1,
        qualityFamily: "半马专项",
        zones: week.zones,
      },
    ],
    athlete: { weeklyRunDaysMax: 5, weekKm: 40, fitness: { ctl: 70, atl: 65, form: 5 } },
    race: { distance: "HM", name: "测试半马", date, targetTime: target === 7200 ? "2:00:00" : "1:20:00", goalPaceSKm: goal },
    planStartMonday: "2027-02-01",
  };
}

test("HM evidence and zones derive pace and capability from half-marathon distance", () => {
  for (const [targetTime, seconds] of [
    ["1:59:59", 7199],
    ["1:20:00", 4800],
  ] as const) {
    const evidence = buildPhaseEvidence(
      createAssessmentSnapshot(),
      [],
      {
        raceName: "测试半马",
        distance: "HM",
        targetTime,
        weeklyRunDaysMax: 5,
      },
      "2026-10-23",
    );
    assert.equal(evidence.target.distance, "HM");
    assert.match(evidence.target.race, /半程/);
    const band = projectZones(45, seconds, RACE_DISTANCES_M.HM, 12).goal_m_pace;
    assert.ok(Math.abs((band[0] + band[1]) / 2 - seconds / 21.0975) < 1);
  }
  assert.equal(runwayWeeks("2027-02-01", "2027-02-07", "HM"), 1);
  assert.equal(runwayWeeks("2027-02-01", "2027-02-08", "HM"), 2);
  assert.equal(runwayWeeks("2027-02-01", "2027-02-08", "FM"), 1);
  assert.ok(halfMarathonTrainingPace(40, 228) > 228);
});

test("HM model fallback supports every race weekday, including race-only Monday and Tuesday", async () => {
  for (let day = 1; day <= 7; day++) {
    for (const target of [4800, 7200]) {
      const input = raceInput(`2027-02-0${day}`, target);
      const output = await generateWeekContent(input, {
        invoke: async () => {
          throw new Error("exercise fallback");
        },
      });
      assert.equal(output.source, "fallback");
      const sessions = output.weeks[0]!.sessions;
      assert.equal(sessions.length, 1);
      const race = sessions[0]!;
      assert.equal(race.date, input.race.date);
      assert.equal(race.blocks[0]!.steps[0]!.duration.value, 21097.5);
      assert.ok(output.checks.flat().every((check) => check.pass));
    }
  }
});

test("HM hard checks reject a marathon race and an incorrect goal pace", () => {
  const input = raceInput("2027-02-07");
  const bag = templateFallback(input)[0]!;
  assert.ok(validateWeekBag(bag, input.rows[0]!, input).every((check) => check.pass));
  const course = bag.courses[0]!;
  assert.equal(course.kind, "course");
  if (course.kind !== "course") throw new Error("expected structured course");
  course.blocks[0]!.steps[0]!.duration.value = 42195;
  assert.ok(validateWeekBag(bag, input.rows[0]!, input).some((check) => check.id === "HM 项目硬校验" && !check.pass));
  course.blocks[0]!.steps[0]!.duration.value = 21097.5;
  course.blocks[0]!.steps[0]!.target = { kind: "pace_s_km", low: 165, high: 175 };
  assert.ok(validateWeekBag(bag, input.rows[0]!, input).some((check) => check.id === "HM 项目硬校验" && !check.pass));
});

test("HM optional activation is budgeted separately from the race", async () => {
  const input = raceInput("2027-02-07");
  input.rows[0]!.totalKm = 34;
  input.rows[0]!.qualitySessions = 2;
  const out = await generateWeekContent(input, {
    invoke: async () => {
      throw new Error("exercise fallback");
    },
  });
  assert.equal(out.weeks[0]!.sessions.filter((workout) => workout.type === "M").length, 2);
  assert.ok(out.weeks[0]!.sessions.every((workout) => workout.date <= input.race.date));
  assert.ok(out.checks.flat().every((check) => check.pass));
});

test("HM long-run dose has a literal project cap even within generic C2 tolerance", async () => {
  const input = raceInput("2027-02-07");
  input.rows[0] = { ...input.rows[0]!, role: "progress", totalKm: 65, longRunKm: 24 };
  input.race.date = "2027-04-04";
  input.athlete.weeklyRunDaysMax = 6;
  const out = await generateWeekContent(input, {
    invoke: async () => {
      throw new Error("exercise fallback");
    },
  });
  const sessions = out.weeks[0]!.sessions;
  const long = sessions.find((workout) => workout.type === "LR")!;
  assert.ok(long.blocks[0]!.steps[0]!.duration.value! <= 24000);
  const checks = validateWeekContent({
    sessions: sessions.map((workout) => ({ workout })),
    distance: "HM",
    specificPaceSKm: input.rows[0]!.specificPaceSKm!,
    row: { total_km: 65, long_run_km: 24, quality_sessions: 1 },
    zones: input.rows[0]!.zones,
    maxTrainingDays: 6,
  });
  assert.ok(
    checks.every((check) => check.pass),
    JSON.stringify(checks.filter((check) => !check.pass)),
  );
});

test("HM time-based specific work cannot evade the ten-kilometre cap", () => {
  const input = raceInput("2027-02-07");
  input.rows[0] = { ...input.rows[0]!, role: "progress", totalKm: 65, longRunKm: 23.4 };
  const bag = templateFallback(input)[0]!;
  const course = bag.courses.find((item) => item.kind === "course" && item.type === "M");
  assert.ok(course?.kind === "course");
  const work = course.blocks.flatMap((block) => block.steps).find((step) => step.step_kind === "work")!;
  assert.ok(work.target.kind === "pace_s_km");
  const pace = (work.target.low + work.target.high) / 2;
  work.duration = { kind: "time_s", value: 12 * pace };
  assert.ok(validateWeekBag(bag, input.rows[0]!, input).some((check) => check.id === "HM 项目硬校验" && !check.pass));
});

test("HM fallback quality work follows early, transition, and final phases", () => {
  const expected = [
    ["early_quality", 1, "R"],
    ["transition_quality", 1, "T"],
    ["transition_quality", 2, "I"],
    ["final_quality", 1, "M"],
    ["final_quality", 2, "T"],
  ] as const;
  for (const [phase, week, type] of expected) {
    const input = raceInput("2027-04-04");
    input.rows[0] = { ...input.rows[0]!, phase, week, role: "progress", totalKm: 50, longRunKm: 18 };
    const bag = templateFallback(input)[0]!;
    assert.ok(
      bag.courses.some((course) => course.kind === "course" && course.type === type),
      JSON.stringify({ phase, week, type }),
    );
  }
});

test("HM L3 reaches optional activation only when race budget and calendar allow it", async () => {
  const { loadAthlete } = await import("../fixtureLoader.js");
  const { tableFallback } = await import("../fallback.js");
  const { buildLoadPlan } = await import("../load/expand.js");
  const { buildWeeklySeries, habitualBaseline } = await import("../load/baseline.js");
  const { snapshot, activities } = await loadAthlete("chaoyi");
  const evidence = buildPhaseEvidence(
    snapshot,
    activities,
    {
      raceName: "半马",
      distance: "HM",
      targetTime: "1:20:00",
      weeklyRunDaysMax: 6,
    },
    "2026-10-26",
  );
  const series = buildWeeklySeries(activities, "2026-10-26");
  for (const [raceDate, weeks, expectedQ] of [
    ["2027-02-07", 15, 2],
    ["2027-02-08", 16, 1],
  ] as const) {
    const intent = tableFallback(evidence, weeks);
    const load = buildLoadPlan({
      intent,
      runwayWeeks: weeks,
      baseline: habitualBaseline(series),
      recentWeeksKm: series.weeks.slice(-4).map((week) => week.km),
      distance: "HM",
      raceDate,
      raceEasyPaceSKm: 300,
      weeklyRunDaysMax: 6,
    });
    assert.equal(load.weeks.at(-1)!.q, expectedQ);
    assert.ok(load.weeks.every((week) => week.lr == null || week.lr <= (week.role === "taper" ? 15 : 24)));
  }
});
