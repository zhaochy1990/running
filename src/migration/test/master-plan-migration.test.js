import assert from "node:assert/strict";
import test from "node:test";

import {
  ManifestBindingError,
  assertManifestUserSelection,
  buildMasterPlanManifest,
  commitMasterPlanManifest,
} from "../src/master-plan-migration.js";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const PLAN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GOAL_ID = "99999999-8888-4777-8666-555555555555";

function structuredEntity(overrides = {}) {
  const plan = {
    plan_id: PLAN_ID,
    user_id: USER_ID,
    status: "active",
    version: 4,
    goal: { goal_id: GOAL_ID, target_time: "3:30:00" },
    start_date: "2026-08-10",
    end_date: "2026-12-20",
    total_weeks: 19,
    phases: [],
    milestones: [],
    weeks: [],
    training_principles: [],
    generated_by: "migration-test",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...(overrides.plan ?? {}),
  };
  return {
    partitionKey: USER_ID,
    rowKey: PLAN_ID,
    status: "active",
    version: 4,
    plan_json: JSON.stringify(plan),
    ...overrides.entity,
  };
}

function activeGoal(overrides = {}) {
  return {
    goal_id: GOAL_ID,
    user_id: USER_ID,
    status: "active",
    active_flag: 1,
    ...overrides,
  };
}

function currentRow(entity = structuredEntity(), overrides = {}) {
  return {
    plan_id: entity.rowKey,
    user_id: entity.partitionKey,
    content_version: 2,
    content: entity.plan_json,
    goal_id: GOAL_ID,
    status: "active",
    active_flag: 1,
    revision: 4,
    created_at: "2026-08-01 00:00:00.000",
    updated_at: "2026-08-02 00:00:00.000",
    ...overrides,
  };
}

function adapters({ structured = [], markdown = null, current = [], goals = [] } = {}) {
  const calls = [];
  return {
    calls,
    source: {
      async listStructured(userId) {
        calls.push(["structured", userId]);
        return structured;
      },
      async readMarkdown(userId) {
        calls.push(["markdown", userId]);
        return markdown;
      },
    },
    target: {
      async listCurrentMasterPlans(userId) {
        calls.push(["target", userId]);
        return current;
      },
      async listCurrentRaceGoals(userId) {
        calls.push(["goals", userId]);
        return goals;
      },
    },
  };
}

test("dry-run reads both Azure forms and MySQL before classifying a missing user", async () => {
  const io = adapters();
  const manifest = await buildMasterPlanManifest({
    userIds: [USER_ID],
    source: io.source,
    target: io.target,
  });

  assert.deepEqual(io.calls, [
    ["structured", USER_ID],
    ["markdown", USER_ID],
    ["target", USER_ID],
    ["goals", USER_ID],
  ]);
  assert.equal(manifest.users.length, 1);
  assert.deepEqual(manifest.users[0], {
    user_id: USER_ID,
    source_kind: null,
    source_plan_id: null,
    target_plan_id: null,
    source_content_hash: null,
    target_content_hash: null,
    content_version: null,
    revision: null,
    goal_id: null,
    action: "missing",
    reason: "no_source",
    post_commit_hash: null,
  });
  assert.match(manifest.manifest_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(manifest).includes("plan_json"), false);
});

test("structured source supersedes Markdown and maps source version to revision", async () => {
  const entity = structuredEntity();
  const io = adapters({
    structured: [entity],
    markdown: { text: "# legacy secret plan", lastModified: new Date("2026-08-01T00:00:00Z") },
    goals: [activeGoal()],
  });

  const first = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  const second = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  const record = first.users[0];

  assert.equal(record.source_kind, "structured");
  assert.equal(record.source_plan_id, PLAN_ID);
  assert.equal(record.target_plan_id, PLAN_ID);
  assert.equal(record.content_version, 2);
  assert.equal(record.revision, 4);
  assert.equal(record.goal_id, GOAL_ID);
  assert.equal(record.action, "insert");
  assert.equal(record.reason, "target_missing");
  assert.match(record.source_content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.target_content_hash, null);
  assert.equal(first.manifest_hash, second.manifest_hash);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("legacy secret plan"), false);
  assert.equal(serialized.includes(entity.plan_json), false);
});

test("source identity mismatch is a conflict rather than a candidate", async () => {
  const io = adapters({
    structured: [structuredEntity({ plan: { user_id: "22222222-2222-4222-8222-222222222222" } })],
    goals: [activeGoal()],
  });
  const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(manifest.users[0].action, "conflict");
  assert.equal(manifest.users[0].reason, "source_identity_mismatch");
});

test("an exact canonical target row is identical", async () => {
  const entity = structuredEntity();
  const row = currentRow(entity);
  const io = adapters({ structured: [entity], current: [row], goals: [activeGoal()] });
  const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  const record = manifest.users[0];
  assert.equal(record.action, "identical");
  assert.equal(record.reason, "content_and_identity_match");
  assert.equal(record.target_plan_id, PLAN_ID);
  assert.equal(record.target_content_hash, record.post_commit_hash);
});

test("target current candidates reject duplicates and both marker-drift directions", async () => {
  const cases = [
    { current: [currentRow(), currentRow(undefined, { plan_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })], reason: "target_multiple_current" },
    { current: [currentRow(undefined, { active_flag: null })], reason: "target_marker_drift" },
    { current: [currentRow(undefined, { status: "archived" })], reason: "target_marker_drift" },
  ];
  for (const item of cases) {
    const io = adapters({ structured: [structuredEntity()], current: item.current, goals: [activeGoal()] });
    const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
    assert.equal(manifest.users[0].action, "conflict");
    assert.equal(manifest.users[0].reason, item.reason);
  }
});

test("a different existing MySQL current row is always a conflict", async () => {
  const io = adapters({
    structured: [structuredEntity()],
    current: [currentRow(undefined, { plan_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })],
    goals: [activeGoal()],
  });
  const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(manifest.users[0].action, "conflict");
  assert.equal(manifest.users[0].reason, "target_identity_mismatch");
});

test("Markdown source produces deterministic identity-bound insert manifest", async () => {
  const markdown = {
    user_id: USER_ID,
    blob_name: `users/${USER_ID}/TRAINING_PLAN.md`,
    text: "# Legacy season plan\n",
    lastModified: new Date("2026-08-03T01:02:03Z"),
  };
  const io = adapters({ markdown });
  const goalSeeds = { [USER_ID]: { race_date: "2026-12-20", race_distance: "FM" } };
  const first = await buildMasterPlanManifest({
    userIds: [USER_ID], source: io.source, target: io.target, goalSeeds,
  });
  const second = await buildMasterPlanManifest({
    userIds: [USER_ID], source: io.source, target: io.target, goalSeeds,
  });
  const record = first.users[0];

  assert.equal(record.source_kind, "markdown");
  assert.equal(record.source_plan_id, null);
  assert.match(record.target_plan_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(record.content_version, 1);
  assert.equal(record.revision, null);
  assert.match(record.goal_id, /^[0-9a-f-]{36}$/);
  assert.equal(record.action, "insert");
  assert.equal(record.reason, "target_missing");
  assert.equal(first.manifest_hash, second.manifest_hash);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes(markdown.text), false);
});

test("Markdown ownership mismatch and blank content are conflicts", async () => {
  for (const markdown of [
    { user_id: "22222222-2222-4222-8222-222222222222", text: "# plan", lastModified: new Date() },
    { user_id: USER_ID, text: "   \n", lastModified: new Date() },
  ]) {
    const io = adapters({ markdown });
    const manifest = await buildMasterPlanManifest({
      userIds: [USER_ID],
      source: io.source,
      target: io.target,
      goalSeeds: { [USER_ID]: { race_date: "2026-12-20", race_distance: "FM" } },
    });
    assert.equal(manifest.users[0].action, "conflict");
  }
});

function commitAdapters() {
  const entity = structuredEntity();
  const rows = [];
  const events = [];
  const source = {
    async listStructured() { return [entity]; },
    async readMarkdown() { return null; },
  };
  const target = {
    async listCurrentMasterPlans() { return rows.map((row) => ({ ...row })); },
    async listCurrentRaceGoals() { return [activeGoal()]; },
    async transaction(userId, operation) {
      events.push(["begin", userId]);
      try {
        await operation({
          async insertRaceGoal(row) { events.push(["goal", row.goal_id]); },
          async insertMasterPlan(row) { events.push(["plan", row.plan_id]); rows.push({ ...row }); },
        });
        events.push(["commit", userId]);
      } catch (error) {
        events.push(["rollback", userId]);
        throw error;
      }
    },
  };
  return { source, target, rows, events, entity };
}

test("commit re-reads reviewed inputs, writes one user transaction, and verifies readback", async () => {
  const io = commitAdapters();
  const reviewed = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  const result = await commitMasterPlanManifest({
    reviewedManifest: reviewed,
    reviewedHash: reviewed.manifest_hash,
    source: io.source,
    target: io.target,
  });

  assert.deepEqual(io.events, [
    ["begin", USER_ID],
    ["plan", PLAN_ID],
    ["commit", USER_ID],
  ]);
  assert.equal(result.users[0].action, "inserted");
  assert.equal(result.users[0].post_commit_hash, reviewed.users[0].post_commit_hash);
});

test("commit rejects reviewed hash, source drift, and target drift before writing", async () => {
  const badHash = commitAdapters();
  const badHashManifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: badHash.source, target: badHash.target });
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: badHashManifest,
      reviewedHash: "sha256:" + "0".repeat(64),
      source: badHash.source,
      target: badHash.target,
    }),
    ManifestBindingError,
  );
  assert.deepEqual(badHash.events, []);

  const sourceDrift = commitAdapters();
  const sourceManifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: sourceDrift.source, target: sourceDrift.target });
  sourceDrift.entity.plan_json = sourceDrift.entity.plan_json.replace("migration-test", "changed-after-review");
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: sourceManifest,
      reviewedHash: sourceManifest.manifest_hash,
      source: sourceDrift.source,
      target: sourceDrift.target,
    }),
    /drift/i,
  );
  assert.deepEqual(sourceDrift.events, []);

  const targetDrift = commitAdapters();
  const targetManifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: targetDrift.source, target: targetDrift.target });
  targetDrift.rows.push(currentRow(undefined, { plan_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: targetManifest,
      reviewedHash: targetManifest.manifest_hash,
      source: targetDrift.source,
      target: targetDrift.target,
    }),
    /drift/i,
  );
  assert.deepEqual(targetDrift.events, []);
});

test("post-commit verification rejects missing or mismatched current readback", async () => {
  const io = commitAdapters();
  const reviewed = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  let reads = 0;
  io.target.listCurrentMasterPlans = async () => {
    reads++;
    return reads === 1 ? [] : [];
  };
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: reviewed,
      reviewedHash: reviewed.manifest_hash,
      source: io.source,
      target: io.target,
    }),
    /post-commit verification/i,
  );
  assert.deepEqual(io.events.slice(0, 3), [
    ["begin", USER_ID],
    ["plan", PLAN_ID],
    ["commit", USER_ID],
  ]);
});

test("no source is missing only when no target current row exists", async () => {
  for (const current of [
    [currentRow()],
    [currentRow(undefined, { active_flag: null })],
    [currentRow(), currentRow(undefined, { plan_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })],
  ]) {
    const io = adapters({ current });
    const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
    assert.equal(manifest.users[0].action, "conflict");
  }
});

test("invalid structured revision or timestamps are source conflicts", async () => {
  const cases = [
    structuredEntity({ plan: { version: 0 } }),
    structuredEntity({ plan: { created_at: null } }),
    structuredEntity({ plan: { updated_at: "invalid" } }),
  ];
  for (const entity of cases) {
    const io = adapters({ structured: [entity], goals: [activeGoal()] });
    const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
    assert.equal(manifest.users[0].action, "conflict");
    assert.equal(manifest.users[0].reason, "source_invalid");
  }
});

test("commit re-reads reviewed missing records and rejects newly appeared source", async () => {
  const structured = [];
  const io = adapters({ structured });
  const reviewed = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  structured.push(structuredEntity());
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: reviewed,
      reviewedHash: reviewed.manifest_hash,
      source: io.source,
      target: io.target,
    }),
    /drift/i,
  );
});

test("commit refuses a reviewed manifest containing unresolved conflicts", async () => {
  const io = adapters({ current: [currentRow()] });
  const reviewed = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(reviewed.users[0].action, "conflict");
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: reviewed,
      reviewedHash: reviewed.manifest_hash,
      source: io.source,
      target: io.target,
    }),
    /conflict/i,
  );
});

test("target rows with missing audit timestamps are conflicts", async () => {
  for (const overrides of [{ created_at: null }, { updated_at: null }]) {
    const io = adapters({
      structured: [structuredEntity()],
      current: [currentRow(undefined, overrides)],
      goals: [activeGoal()],
    });
    const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
    assert.equal(manifest.users[0].action, "conflict");
    assert.equal(manifest.users[0].reason, "target_invalid");
  }
});

test("manifest user selection must exactly match selected real users", async () => {
  const io = adapters();
  const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.doesNotThrow(() => assertManifestUserSelection(manifest, [USER_ID]));
  assert.throws(
    () => assertManifestUserSelection(manifest, ["22222222-2222-4222-8222-222222222222"]),
    ManifestBindingError,
  );
});

test("Markdown without a source audit timestamp is a conflict", async () => {
  const io = adapters({ markdown: { user_id: USER_ID, text: "# plan", lastModified: null } });
  const manifest = await buildMasterPlanManifest({
    userIds: [USER_ID],
    source: io.source,
    target: io.target,
    goalSeeds: { [USER_ID]: { race_date: "2026-12-20", race_distance: "FM" } },
  });
  assert.equal(manifest.users[0].action, "conflict");
  assert.equal(manifest.users[0].reason, "source_invalid");
});

test("invalid target goal identity is classified as a conflict", async () => {
  const io = adapters({
    structured: [structuredEntity()],
    goals: [activeGoal({ goal_id: "legacy-goal-slug" })],
  });
  const manifest = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(manifest.users[0].action, "conflict");
  assert.equal(manifest.users[0].reason, "active_goal_identity_mismatch");
});

test("post-commit verification requires persisted audit timestamps", async () => {
  const io = commitAdapters();
  const reviewed = await buildMasterPlanManifest({ userIds: [USER_ID], source: io.source, target: io.target });
  let reads = 0;
  io.target.listCurrentMasterPlans = async () => {
    reads++;
    if (reads === 1) return [];
    return [{ ...io.rows[0], updated_at: null }];
  };
  await assert.rejects(
    commitMasterPlanManifest({
      reviewedManifest: reviewed,
      reviewedHash: reviewed.manifest_hash,
      source: io.source,
      target: io.target,
    }),
    /post-commit verification/i,
  );
});

test("Markdown race-goal insert carries the source audit timestamp", async () => {
  const markdown = {
    user_id: USER_ID,
    text: "# plan\n",
    lastModified: new Date("2026-08-03T01:02:03Z"),
  };
  const rows = [];
  let insertedGoal;
  const source = {
    async listStructured() { return []; },
    async readMarkdown() { return markdown; },
  };
  const target = {
    async listCurrentMasterPlans() { return rows; },
    async listCurrentRaceGoals() { return []; },
    async transaction(_userId, operation) {
      await operation({
        async insertRaceGoal(row) { insertedGoal = row; },
        async insertMasterPlan(row) { rows.push(row); },
      });
    },
  };
  const goalSeeds = { [USER_ID]: { race_date: "2026-12-20", race_distance: "FM", weekly_training_days: 5 } };
  const reviewed = await buildMasterPlanManifest({ userIds: [USER_ID], source, target, goalSeeds });
  await commitMasterPlanManifest({
    reviewedManifest: reviewed,
    reviewedHash: reviewed.manifest_hash,
    source,
    target,
    goalSeeds,
  });
  assert.equal(insertedGoal.created_at, "2026-08-03 01:02:03.000");
  assert.equal(insertedGoal.updated_at, "2026-08-03 01:02:03.000");
});
