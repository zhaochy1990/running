import assert from "node:assert/strict";
import test from "node:test";
import { CustomWorkoutCardSchema, CustomWorkoutLenientDirectResponseSchema, normalizeCustomWorkoutDraft } from "./schema.js";

// devops#587 用户例句的期望解析结果：两个 block、work 步带 rest 180s/90s、
// pace 230–240（3:50–4:00）/ 205–215（3:25–3:35）秒每公里。
const exampleDraft = {
  date: "2026-10-20",
  name: "4km×3 组 + 400m×6 间歇",
  summary: "3 组 4km 巡航 + 6 个 400m 冲刺间歇",
  spec: {
    name: "4km×3 组 + 400m×6 间歇",
    date: "2026-10-20",
    blocks: [
      {
        repeat: 3,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: 4000 },
            target: { kind: "pace_s_km", low: 230, high: 240 },
            rest: { kind: "time_s", value: 180 },
          },
        ],
      },
      {
        repeat: 6,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: 400 },
            target: { kind: "pace_s_km", low: 205, high: 215 },
            rest: { kind: "time_s", value: 90 },
          },
        ],
      },
    ],
  },
};

test("lenient envelope accepts the canonical example and normalizes to strict spec", () => {
  const envelope = CustomWorkoutLenientDirectResponseSchema.parse({ disposition: "return_direct", content: exampleDraft });
  const draft = normalizeCustomWorkoutDraft(envelope.content);
  assert.equal(draft.date, "2026-10-20");
  assert.equal(draft.spec.blocks.length, 2);
  const [first, second] = draft.spec.blocks;
  assert.equal(first?.repeat, 3);
  assert.deepEqual(first?.steps[0]?.rest, { kind: "time_s", value: 180 });
  assert.deepEqual(first?.steps[0]?.target, { kind: "pace_s_km", low: 230, high: 240 });
  assert.equal(second?.repeat, 6);
  assert.deepEqual(second?.steps[0]?.rest, { kind: "time_s", value: 90 });
  assert.deepEqual(second?.steps[0]?.target, { kind: "pace_s_km", low: 205, high: 215 });
  // lenient → strict：note/hr_cap_bpm/schema 判别符被 normalize 补齐。
  assert.equal(draft.spec.note, null);
  assert.equal(draft.spec.schema, "run-workout/v1");
});

test("model-supplied noise keys and node-owned scalars are stripped from the draft", () => {
  const envelope = CustomWorkoutLenientDirectResponseSchema.parse({
    disposition: "return_direct",
    content: {
      ...exampleDraft,
      save_token: "model-tried-to-set-it",
      estimated_dose: 999,
      total_distance_m: 42,
      spec: { ...exampleDraft.spec, note: "模型多写的备注", schema: "run-workout/v1" },
    },
  });
  const draft = normalizeCustomWorkoutDraft(envelope.content);
  assert.equal("save_token" in draft, false);
  assert.equal("estimated_dose" in draft, false);
  // note 属于 spec 本身，normalize 保留。
  assert.equal(draft.spec.note, "模型多写的备注");
});

test("missing key structure is rejected (no card without date/name/spec blocks)", () => {
  assert.equal(CustomWorkoutLenientDirectResponseSchema.safeParse({ disposition: "return_direct", content: { name: "缺日期" } }).success, false);
  assert.equal(
    CustomWorkoutLenientDirectResponseSchema.safeParse({
      disposition: "return_direct",
      content: { ...exampleDraft, spec: { ...exampleDraft.spec, blocks: [] } },
    }).success,
    false,
  );
  assert.equal(
    CustomWorkoutLenientDirectResponseSchema.safeParse({
      disposition: "return_direct",
      content: {
        ...exampleDraft,
        spec: { ...exampleDraft.spec, blocks: [{ repeat: 1, steps: [{ ...exampleDraft.spec.blocks[0]?.steps[0], rest: { kind: "time_s", value: 90 } }] }] },
      },
    }).success,
    true,
  );
});

test("card schema validates the node-enriched shape", () => {
  const card = {
    save_token: "0d6b07d8-0b7e-4f6e-9f2a-2a6f0b3c9d11",
    date: "2026-10-20",
    name: "x",
    summary: "y",
    total_distance_m: 14400,
    total_duration_s: null,
    estimated_dose: null,
    spec: {
      ...exampleDraft.spec,
      schema: "run-workout/v1",
      note: null,
      blocks: exampleDraft.spec.blocks.map((b) => ({ repeat: b.repeat, steps: b.steps.map((s) => ({ ...s, note: null, hr_cap_bpm: null })) })),
    },
  };
  assert.equal(CustomWorkoutCardSchema.safeParse(card).success, true);
  assert.equal(CustomWorkoutCardSchema.safeParse({ ...card, save_token: "" }).success, false);
});
