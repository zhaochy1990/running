import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizePhaseNames,
  PhaseNameMigrationError,
  PHASE_NAME_ENUM,
} from "../src/master-plan-phase-enum.js";

function samplePlan(userId, phaseNames, weekPhaseIds) {
  const phases = phaseNames.map((name, index) => ({
    id: `phase-${index}`,
    name,
    start_date: "2026-01-01",
    end_date: "2026-02-01",
    focus: "test",
  }));
  const weeks = weekPhaseIds.map((phaseId, index) => ({
    week_index: index + 1,
    week_start: "2026-01-05",
    phase_id: phaseId,
    phase_name: null,
    target_weekly_km_low: 50,
    target_weekly_km_high: 60,
    key_sessions: [],
    is_recovery_week: false,
  }));
  return { phases, weeks, start_date: "2026-01-01", end_date: "2026-02-01" };
}

test("PHASE_NAME_ENUM is the canonical six-value enum", () => {
  assert.deepEqual(PHASE_NAME_ENUM, [
    "base",
    "build",
    "speed",
    "marathon",
    "taper",
    "recovery",
  ]);
});

test("normalizePhaseNames maps free-text names and back-fills phase_name", () => {
  const userId = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
  const plan = samplePlan(
    userId,
    ["马拉松专项 build 期", "减量与比赛期"],
    ["phase-0", "phase-1", "phase-0"],
  );
  const { content, changes } = normalizePhaseNames(plan, userId);
  assert.deepEqual(
    content.phases.map((phase) => phase.name),
    ["marathon", "taper"],
  );
  assert.deepEqual(
    content.weeks.map((week) => week.phase_name),
    ["marathon", "taper", "marathon"],
  );
  assert.equal(changes.length, 5);
  assert.ok(changes[0].includes('"马拉松专项 build 期" -> "marathon"'));
  assert.ok(changes[1].includes('"减量与比赛期" -> "taper"'));
  assert.ok(changes[2].includes('week 1 phase_name -> "marathon"'));
  assert.equal(content.start_date, "2026-01-01");
});

test("normalizePhaseNames is idempotent on already-normalized content", () => {
  const userId = "db2470c4-885b-496f-896a-764c0dedbaea";
  const plan = samplePlan(userId, ["base", "taper"], ["phase-0", "phase-1"]);
  plan.weeks[0].phase_name = "base";
  plan.weeks[1].phase_name = "taper";
  const { content, changes } = normalizePhaseNames(plan, userId);
  assert.deepEqual(changes, []);
  assert.deepEqual(content.phases.map((phase) => phase.name), ["base", "taper"]);
});

test("normalizePhaseNames throws on an unmapped phase name", () => {
  const userId = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
  const plan = samplePlan(userId, ["未知阶段期"], ["phase-0"]);
  assert.throws(
    () => normalizePhaseNames(plan, userId),
    PhaseNameMigrationError,
  );
});

test("normalizePhaseNames throws for a user without a mapping", () => {
  const plan = samplePlan("00000000-0000-0000-0000-000000000000", ["base"], ["phase-0"]);
  assert.throws(
    () => normalizePhaseNames(plan, "00000000-0000-0000-0000-000000000000"),
    PhaseNameMigrationError,
  );
});

test("normalizePhaseNames throws when a phase lacks an id", () => {
  const userId = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
  const plan = samplePlan(userId, ["base"], ["phase-0"]);
  delete plan.phases[0].id;
  assert.throws(() => normalizePhaseNames(plan, userId), PhaseNameMigrationError);
});

test("normalizePhaseNames throws when a week references an unknown phase_id", () => {
  const userId = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
  const plan = samplePlan(userId, ["base"], ["missing-phase"]);
  assert.throws(() => normalizePhaseNames(plan, userId), PhaseNameMigrationError);
});

test("normalizePhaseNames maps every real user's full phase list", () => {
  const cases = {
    "f10bc353-01ab-4db1-af9f-d9305ea9a532": ["base", "speed", "marathon", "marathon", "taper"],
    "db2470c4-885b-496f-896a-764c0dedbaea": ["base", "speed", "build", "marathon", "taper"],
    "ba103cff-ad2c-4f9e-9920-983337544a2c": ["base", "speed", "marathon", "marathon", "taper"],
    "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9": ["base", "speed", "marathon", "marathon", "taper"],
    "0a74ac88-629e-4b8e-97c8-d49ccf5a986b": ["base", "build", "marathon", "marathon", "taper"],
  };
  for (const [userId, expected] of Object.entries(cases)) {
    const freeText = {
      "f10bc353-01ab-4db1-af9f-d9305ea9a532": ["已完成的有氧基础期", "夏季速度衔接期", "马拉松专项 build 期", "马拉松专项峰值期", "减量与比赛期"],
      "db2470c4-885b-496f-896a-764c0dedbaea": ["已完成基础期", "速度期", "专项建设期", "半马峰值期", "减量比赛期"],
      "ba103cff-ad2c-4f9e-9920-983337544a2c": ["已完成基础期", "夏训速度期", "马拉松专项建设期", "马拉松峰值期", "减量比赛期"],
      "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9": ["已完成基础期", "速度专项期", "马拉松建设期", "峰值演练期", "减量比赛期"],
      "0a74ac88-629e-4b8e-97c8-d49ccf5a986b": ["已完成基础重建期", "专项准备期", "马拉松专项建设期", "峰值巩固期", "减量比赛期"],
    }[userId];
    const plan = samplePlan(
      userId,
      freeText,
      freeText.map((_, index) => `phase-${index}`),
    );
    const { content, changes } = normalizePhaseNames(plan, userId);
    assert.deepEqual(
      content.phases.map((phase) => phase.name),
      expected,
      `user ${userId}`,
    );
    assert.equal(changes.length, freeText.length * 2);
    assert.deepEqual(
      content.weeks.map((week) => week.phase_name),
      expected,
      `user ${userId} weeks`,
    );
  }
});