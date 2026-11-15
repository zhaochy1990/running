import assert from "node:assert/strict";
import test from "node:test";
import { describeSnapshot } from "./facts.js";
import { layeredView } from "./files.js";
import { type Evidence, type Profile, type Snapshot, SnapshotSchema, validConclusions } from "./types.js";

const row = (id: string, kind: string, content: Record<string, unknown>): Evidence => ({
  id,
  kind,
  content,
  revision: "r1",
  eventTime: null,
  reportedAt: null,
  active: true,
});
const fixture = (): Snapshot => ({
  userId: "one",
  startDay: "2026-05-20",
  endDay: "2026-11-15",
  capturedAt: "2026-11-15T01:00:00Z",
  coverage: {},
  evidence: [
    row("run", "activity", {
      sport: "run_outdoor",
      date: "2026-11-14T22:00:00Z",
      shanghaiDay: "2026-11-15",
      distanceM: 30000,
      durationS: 7500,
      feelNote: "今天感觉还能继续跑。",
    }),
    row("strength", "activity", { sport: "strength", date: "2026-11-15T04:00:00Z", shanghaiDay: "2026-11-15", distanceM: 99999, durationS: 1000 }),
    row("mixed-feedback", "user_report", { weekStart: "2026-06-22", markdown: "客观分析：默认无伤病不适。本周无主观文字反馈。" }),
    row("calibration", "calibration", { as_of_date: "2026-11-15", algorithm_version: 3, threshold_speed_mps: 4, threshold_hr: 167 }),
  ],
});

test("separates running, Shanghai timing and literal self-report from retrospective analysis", () => {
  const result = describeSnapshot(fixture());
  assert.match(result.conclusions.find((c) => c.id === "recorded-structure")?.text ?? "", /跑步 1 条.*30.0 公里/);
  assert.match(result.conclusions.find((c) => c.id === "recorded-timing")?.text ?? "", /1 条在上海时间/);
  const reports = result.conclusions.filter((c) => c.kind === "user_report");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.text, "今天感觉还能继续跑。");
  assert.equal(reports[0]?.lifecycle, "historical");
  assert(!result.conclusions.some((c) => c.evidence.some((e) => e.id === "mixed-feedback")));
  assert(!result.conclusions.some((c) => c.text.includes("无伤病")));
});

test("corrected/withdrawn evidence invalidates old conclusions without mutating history", () => {
  const snapshot = fixture();
  const profile: Profile = {
    prototype: true,
    userId: "one",
    inputHash: "a",
    evaluatedAt: snapshot.capturedAt,
    window: { startDay: snapshot.startDay, endDay: snapshot.endDay },
    method: "test",
    conclusions: describeSnapshot(snapshot).conclusions,
    unknowns: [],
    change: { previousInputHash: null, removedConclusionIds: [], reason: "test" },
  };
  const before = JSON.stringify(profile);
  const calibration = snapshot.evidence.find((e) => e.id === "calibration");
  const run = snapshot.evidence.find((e) => e.id === "run");
  assert(calibration && run);
  calibration.active = false;
  run.revision = "r2";
  const valid = validConclusions(profile, snapshot);
  assert(!valid.some((c) => c.kind === "estimate" || c.kind === "user_report"));
  assert.equal(JSON.stringify(profile), before);
});

test("layered projection preserves exactly the same conclusions and allows empty long-term layer", () => {
  const snapshot = fixture();
  const profile: Profile = {
    prototype: true,
    userId: "one",
    inputHash: "a",
    evaluatedAt: snapshot.capturedAt,
    window: { startDay: snapshot.startDay, endDay: snapshot.endDay },
    method: "test",
    conclusions: describeSnapshot(snapshot).conclusions,
    unknowns: [],
    change: { previousInputHash: null, removedConclusionIds: [], reason: "test" },
  };
  const before = JSON.stringify(profile);
  const layers = layeredView(profile);
  const flatten = layers.flatMap((l) => l.dimensions.flatMap((d) => d.items));
  assert.deepEqual(
    flatten.toSorted((a, b) => a.id.localeCompare(b.id)),
    profile.conclusions.toSorted((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(layers.find((l) => l.lifecycle === "long_term")?.dimensions.length, 0);
  assert.equal(JSON.stringify(profile), before);
});

test("rejects duplicate source identities and impossible input dates", () => {
  const snapshot = fixture();
  const first = snapshot.evidence[0];
  assert(first);
  snapshot.evidence.push(first);
  assert.throws(() => SnapshotSchema.parse(snapshot), /Duplicate source IDs/);
  assert.throws(() => SnapshotSchema.parse({ ...fixture(), endDay: "2026-02-30" }));
});
