import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CalibrationSelectionSchema, CalibrationSourceSchema } from "./calibrationMetadata.js";

test("bounded source retains actual producer stale reason/date without reviving support", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../docs/calibration/fixtures/client-display-v1.json", import.meta.url), "utf8"));
  const item = fixture.cases.find((item: { name: string }) => item.name === "producer-stale-hr");
  const source = CalibrationSourceSchema.parse(item.response.threshold.source);
  assert.match(JSON.stringify(source.hr), /"latest_rejected_evidence_date":"2026-09-14"/);
  assert.ok(source.hr?.rejected_reasons?.includes("stale_HR_support"));
  assert.equal(source.hr?.support, "none");
  assert.equal(source.hr?.evidence_count, 0);
  assert.equal(source.hr?.evidence_date, undefined);
});

test("mixed protocol dates remain separate in the bounded Coach contract", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../docs/calibration/fixtures/client-display-v1.json", import.meta.url), "utf8"));
  const item = fixture.cases.find((item: { name: string }) => item.name === "producer-stale-hr-mixed");
  const source = CalibrationSourceSchema.parse(item.response.threshold.source);
  assert.equal(source.hr?.latest_stale_evidence_date, "2026-09-14");
  assert.equal(source.hr?.latest_rejected_evidence_date, "2026-11-13");
  assert.equal(source.hr?.support, "none");
  assert.equal(source.hr?.evidence_count, 0);
});

test("current HR support and rejected historical reasons stay separate", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../docs/calibration/fixtures/client-display-v1.json", import.meta.url), "utf8"));
  for (const kind of ["stale", "quality"]) {
    const item = fixture.cases.find((item: { name: string }) => item.name === `producer-current-hr-with-${kind}`);
    const source = CalibrationSourceSchema.parse(item.response.threshold.source);
    assert.deepEqual(source.hr?.reasons, ["independent_HR_protocol_support"]);
    assert.ok(source.hr?.rejected_reasons?.includes(kind === "stale" ? "stale_HR_support" : "HR_abrupt_spike_or_recovery"));
    assert.equal(source.hr?.support, "low");
    assert.equal(source.hr?.evidence_count, 1);
    assert.equal(source.hr?.evidence_date, "2026-11-14");
  }
});

test("algorithm revision and estimation state stay optional for evolved v4 (#995)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../docs/calibration/fixtures/client-display-v1.json", import.meta.url), "utf8"));
  // Legacy v4 rows never carried the marker: it must stay absent, never inferred.
  const legacy = CalibrationSourceSchema.parse(fixture.cases[0].response.threshold.source);
  assert.equal(legacy.algorithm_revision, undefined);
  assert.equal(legacy.speed?.state, undefined);
  // Evolved-v4 summaries carry the revision marker and the five-label state.
  const evolved = CalibrationSourceSchema.parse({
    schema_version: 1,
    state: "available",
    strategy: "evolved_candidate",
    implementation: "evolved_joint_v2",
    parameter_version: "rev2-research-2026-11",
    algorithm_revision: "v4-rev3-2026-11",
    data_cutoff_day: "2026-11-16",
    speed: {
      method: "speed_duration_inference",
      target_type: "one_hour_running_capability",
      state: "prior_dominated",
      measurement_quality: "medium",
      effort_support: "submaximal",
      support: "low",
      range_low: 3.0,
      range_high: 4.2,
      range_meaning: "model_sensitivity_range_not_probability_interval",
      independent_activities: 2,
      independent_days: 2,
      reasons: ["identifiability_limited_prior_dominated"],
      limitations: ["research_uncalibrated_not_population_calibrated"],
      evidence_count: 0,
    },
  });
  assert.equal(evolved.algorithm_revision, "v4-rev3-2026-11");
  assert.equal(evolved.speed?.state, "prior_dominated");
});

test("selection override stays optional and bounded (#999)", () => {
  // Legacy selections (no per-user override) parse unchanged and never infer
  // an override block.
  const legacy = CalibrationSelectionSchema.parse({
    mode: "active",
    policy_revision: 0,
    requested_version: 3,
    effective_version: 3,
    state: "selected",
  });
  assert.equal(legacy.override, undefined);
  // An overridden read discloses the pinned identity and the authorizing
  // override row revision, including on fallback reads.
  const overridden = CalibrationSelectionSchema.parse({
    mode: "active",
    policy_revision: 0,
    requested_version: 4,
    effective_version: 3,
    state: "fallback",
    reason: "override_snapshot_missing",
    override: { revision: 2, algorithm_version: 4, algorithm_revision: "v4-rev3-2026-11" },
  });
  assert.deepEqual(overridden.override, { revision: 2, algorithm_version: 4, algorithm_revision: "v4-rev3-2026-11" });
  assert.equal(overridden.state, "fallback");
});
