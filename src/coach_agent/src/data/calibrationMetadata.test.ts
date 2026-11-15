import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CalibrationSourceSchema } from "./calibrationMetadata.js";

test("bounded source retains actual producer stale reason/date without reviving support", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../docs/calibration/fixtures/client-display-v1.json", import.meta.url), "utf8"));
  const item = fixture.cases.find((item: { name: string }) => item.name === "producer-stale-hr");
  const source = CalibrationSourceSchema.parse(item.response.threshold.source);
  assert.match(JSON.stringify(source.hr), /"latest_rejected_evidence_date":"2026-09-14"/);
  assert.ok(source.hr?.reasons?.includes("stale_HR_support"));
  assert.equal(source.hr?.support, "none");
  assert.equal(source.hr?.evidence_count, 0);
  assert.equal(source.hr?.evidence_date, undefined);
});
