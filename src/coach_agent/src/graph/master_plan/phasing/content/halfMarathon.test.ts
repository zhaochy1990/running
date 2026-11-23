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
