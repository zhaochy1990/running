import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CalibrationSourceSchema } from "./calibrationMetadata.js";

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
