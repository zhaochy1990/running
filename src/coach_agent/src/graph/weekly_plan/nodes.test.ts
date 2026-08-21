import assert from "node:assert/strict";
import test from "node:test";
import type { WeeklyPlan, WeeklyPlanSimulationReport } from "@stride/contract";
import { loadWithinTolerance, mergeSimulationIntoPlan } from "./nodes.js";
import { createWeeklyPlanForSimulation } from "./testFixtures.js";

test("mergeSimulationIntoPlan keys doses by date and session index", () => {
  const plan: WeeklyPlan = {
    ...createWeeklyPlanForSimulation(),
    sessions: [
      ...createWeeklyPlanForSimulation().sessions,
      {
        schema: "plan-session/v1",
        date: "2026-08-21",
        session_index: 0,
        kind: "rest",
        summary: "Rest",
        spec: null,
        notes_md: null,
        total_distance_m: null,
        total_duration_s: null,
        estimated_dose: null,
      },
    ],
  };
  const simulation = {
    sessions: [
      { date: "2026-08-17", session_index: 0, estimated_dose: 40 },
      { date: "2026-08-19", session_index: 0, estimated_dose: 70 },
    ],
  } as WeeklyPlanSimulationReport;

  const merged = mergeSimulationIntoPlan(plan, simulation);

  assert.equal(merged.sessions[0]?.estimated_dose, 40);
  assert.equal(merged.sessions[1]?.estimated_dose, 70);
  assert.equal(merged.sessions[2]?.estimated_dose, null);
});

test("loadWithinTolerance uses the same rounded acceptance band as retry feedback", () => {
  const simulation = {
    available: true,
    total_dose: 257.29,
  } as WeeklyPlanSimulationReport;
  const target = {
    training_load_low: 208,
    training_load_high: 233.9,
  } as Parameters<typeof loadWithinTolerance>[1];

  assert.equal(loadWithinTolerance(simulation, target), true);
  assert.equal(loadWithinTolerance({ ...simulation, total_dose: 257.2901 }, target), false);
});
