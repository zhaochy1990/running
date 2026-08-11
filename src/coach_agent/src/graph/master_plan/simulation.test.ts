import assert from "node:assert/strict";
import test from "node:test";
import { simulateMasterPlanLoad, simulatePmcDays } from "./simulation.js";
import { createAssessmentSnapshot, createTestMasterPlan } from "./testFixtures.js";

test("PMC uses canonical 7/42 day constants and daily update order", () => {
  const [day] = simulatePmcDays([100], { atl: 70, ctl: 60 });
  assert.ok(day);
  assert.equal(day.atl, 73.9937);
  assert.equal(day.ctl, 60.9411);
  assert.equal(day.form, -13.0525);
  assert.equal(day.ratio, 1.2142);
});

test("weekly simulator deterministically estimates dose and applies the fixed v1 distribution", () => {
  const report = simulateMasterPlanLoad(createTestMasterPlan(), createAssessmentSnapshot());
  const first = report.weeks[0];
  assert.ok(first);
  assert.equal(report.algorithm_version, "master-plan-load-v1");
  assert.deepEqual(report.daily_distribution, [0.1, 0.18, 0.12, 0.18, 0.1, 0.27, 0.05]);
  assert.equal(first.estimated, true);
  assert.equal(first.provenance, "weekly_midpoint+key_sessions+remaining_easy_volume");
  assert.equal(first.confidence, "high");
  assert.equal(first.estimated_dose, 372.3529);
  assert.equal(first.long_run_dose_share, 0.3286);
  assert.equal(first.end_ctl, 65.7274);
  assert.equal(first.end_atl, 60.6711);
  assert.equal(first.end_form, 5.0563);
});

test("simulator decays PMC state across the gap before plan start", () => {
  const snapshot = createAssessmentSnapshot();
  snapshot.fitness_state.as_of_date = "2026-08-01";
  const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot);
  assert.ok(report.weeks[0]!.end_ctl !== null && report.weeks[0]!.end_ctl < 65.7274);
});

test("simulator marks weekly dose unavailable without threshold calibration", () => {
  const snapshot = { ...createAssessmentSnapshot(), running_calibration: null };
  const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot as never);
  assert.equal(report.weeks[0]!.estimated_dose, null);
  assert.equal(report.weeks[0]!.confidence, "low");
  assert.equal(report.weeks[0]!.missing_dose_reason, "threshold_speed_calibration_missing");
  assert.equal(report.weeks[0]!.end_ctl, null);
  assert.equal(report.weeks[0]!.end_atl, null);
  assert.equal(report.weeks[0]!.end_form, null);
});

test("simulator accepts a plan starting Monday of the current snapshot week", () => {
  const snapshot = createAssessmentSnapshot();
  snapshot.fitness_state.as_of_date = "2026-08-11";
  const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot);
  assert.equal(report.weeks[0]!.confidence, "medium");
  assert.match(report.weeks[0]!.provenance, /^partial_current_week/);
  assert.ok(report.weeks[0]!.estimated_dose !== null);
  assert.ok(report.weeks[0]!.end_atl !== null && report.weeks[0]!.end_atl < 70);
});

test("simulator does not invent PMC state when the initial ATL or CTL is missing", () => {
  const snapshot = { ...createAssessmentSnapshot(), fitness_state: { ...createAssessmentSnapshot().fitness_state, atl: null } };
  const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot);
  assert.ok(report.weeks[0]!.estimated_dose !== null);
  assert.equal(report.weeks[0]!.end_ctl, null);
  assert.equal(report.weeks[0]!.end_atl, null);
  assert.equal(report.weeks[0]!.end_form, null);
  assert.equal(report.weeks[0]!.missing_dose_reason, "initial_pmc_state_missing");
});
