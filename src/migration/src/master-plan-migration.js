import { createHash } from "node:crypto";

import {
  MasterPlanTransformError,
  markdownRow,
  raceGoalRowFromSeed,
  rebindStructuredGoal,
  structuredRowFromEntity,
} from "./masterplan-transform.js";

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export class ManifestBindingError extends Error {}

export function assertManifestUserSelection(manifest, selectedUserIds) {
  const manifestIds = (manifest?.users ?? []).map((record) => record.user_id).sort();
  const selectedIds = [...selectedUserIds].sort();
  if (stableJson(manifestIds) !== stableJson(selectedIds)) {
    throw new ManifestBindingError("reviewed manifest users do not match selected real users");
  }
}

function emptyRecord(userId) {
  return {
    user_id: userId,
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
  };
}

function conflictRecord(userId, reason, fields = {}) {
  return { ...emptyRecord(userId), ...fields, action: "conflict", reason };
}

function selectCurrentGoal(userId, rows) {
  if (rows.length !== 1) {
    return { reason: rows.length === 0 ? "active_goal_missing" : "active_goal_ambiguous" };
  }
  const row = rows[0];
  if (
    row.user_id !== userId ||
    typeof row.goal_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.goal_id) ||
    row.status !== "active" || Number(row.active_flag) !== 1
  ) {
    return { reason: "active_goal_identity_mismatch" };
  }
  return { row };
}

function uuidFromIdentity(kind, userId) {
  const bytes = createHash("sha256").update(`${kind}:${userId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function classifyTarget(userId, candidate, sourceFields, currentRows) {
  const common = {
    ...sourceFields,
    target_plan_id: currentRows[0]?.plan_id ?? candidate.plan_id,
    target_content_hash: currentRows[0]?.content == null ? null : sha256(String(currentRows[0].content)),
    content_version: candidate.content_version,
    revision: candidate.revision,
    goal_id: candidate.goal_id,
    post_commit_hash: sha256(candidate.content),
  };
  if (currentRows.length > 1) {
    return conflictRecord(userId, "target_multiple_current", common);
  }
  if (currentRows.length === 1) {
    const target = currentRows[0];
    if (target.status !== "active" || Number(target.active_flag) !== 1) {
      return conflictRecord(userId, "target_marker_drift", common);
    }
    if (!target.created_at || !target.updated_at) {
      return conflictRecord(userId, "target_invalid", common);
    }
    if (target.user_id !== userId || target.plan_id !== candidate.plan_id) {
      return conflictRecord(userId, "target_identity_mismatch", common);
    }
    const targetRevision = target.revision == null ? null : Number(target.revision);
    if (
      Number(target.content_version) !== candidate.content_version ||
      target.goal_id !== candidate.goal_id ||
      targetRevision !== candidate.revision
    ) {
      return conflictRecord(userId, "target_metadata_mismatch", common);
    }
    if (common.target_content_hash !== common.post_commit_hash) {
      return conflictRecord(userId, "target_content_mismatch", common);
    }
    return {
      user_id: userId,
      ...common,
      action: "identical",
      reason: "content_and_identity_match",
    };
  }
  return {
    user_id: userId,
    ...common,
    action: "insert",
    reason: "target_missing",
  };
}

function classifyStructured(userId, entities, currentRows, goalRows) {
  if (entities.length > 1) {
    return conflictRecord(userId, "structured_source_ambiguous");
  }

  let sourceRow;
  try {
    sourceRow = structuredRowFromEntity(entities[0]);
  } catch (error) {
    const identityMismatch =
      error instanceof MasterPlanTransformError && /does not match|status must be active/.test(error.message);
    return conflictRecord(
      userId,
      identityMismatch ? "source_identity_mismatch" : "source_invalid",
    );
  }
  if (sourceRow.user_id !== userId) {
    return conflictRecord(userId, "source_identity_mismatch");
  }

  const goal = selectCurrentGoal(userId, goalRows);
  if (!goal.row) {
    return conflictRecord(userId, goal.reason, {
      source_kind: "structured",
      source_plan_id: sourceRow.plan_id,
      target_plan_id: sourceRow.plan_id,
      source_content_hash: sha256(sourceRow.content),
      content_version: sourceRow.content_version,
      revision: sourceRow.revision,
      goal_id: sourceRow.goal_id,
    });
  }

  const candidate = rebindStructuredGoal(sourceRow, goal.row.goal_id);
  return classifyTarget(userId, candidate, {
    source_kind: "structured",
    source_plan_id: sourceRow.plan_id,
    source_content_hash: sha256(sourceRow.content),
  }, currentRows);
}

function classifyMarkdown(userId, markdown, currentRows, goalRows, goalSeed) {
  if (markdown.user_id !== userId) {
    return conflictRecord(userId, "source_identity_mismatch");
  }
  if (
    typeof markdown.text !== "string" || markdown.text.trim() === "" ||
    !markdown.lastModified || Number.isNaN(new Date(markdown.lastModified).getTime())
  ) {
    return conflictRecord(userId, "source_invalid");
  }
  if (!goalSeed) {
    return conflictRecord(userId, "markdown_goal_seed_missing", {
      source_kind: "markdown",
      source_content_hash: sha256(markdown.text),
      content_version: 1,
    });
  }
  if (goalRows.length > 1) {
    return conflictRecord(userId, "active_goal_ambiguous", {
      source_kind: "markdown",
      source_content_hash: sha256(markdown.text),
      content_version: 1,
    });
  }
  const goalId = goalRows.length === 1
    ? selectCurrentGoal(userId, goalRows).row?.goal_id
    : uuidFromIdentity("markdown-goal", userId);
  if (!goalId) {
    return conflictRecord(userId, "active_goal_identity_mismatch", {
      source_kind: "markdown",
      source_content_hash: sha256(markdown.text),
      content_version: 1,
    });
  }
  const planId = currentRows.length === 1 && currentRows[0].content_version === 1
    ? currentRows[0].plan_id
    : uuidFromIdentity("markdown-plan", userId);
  const candidate = markdownRow(userId, planId, markdown.text, goalId, {
    createdAt: markdown.lastModified,
    updatedAt: markdown.lastModified,
  });
  return classifyTarget(userId, candidate, {
    source_kind: "markdown",
    source_plan_id: null,
    source_content_hash: sha256(markdown.text),
  }, currentRows);
}

export async function buildMasterPlanManifest({ userIds, source, target, goalSeeds = {} }) {
  const users = [];
  for (const userId of userIds) {
    const [structured, markdown, current, goals] = await Promise.all([
      source.listStructured(userId),
      source.readMarkdown(userId),
      target.listCurrentMasterPlans(userId),
      target.listCurrentRaceGoals(userId),
    ]);

    if (structured.length > 0) {
      users.push(classifyStructured(userId, structured, current, goals));
      continue;
    }
    if (markdown) {
      users.push(classifyMarkdown(userId, markdown, current, goals, goalSeeds[userId]));
      continue;
    }
    if (current.length > 0) {
      const reason = current.length > 1
        ? "target_multiple_current"
        : current[0].status !== "active" || Number(current[0].active_flag) !== 1
          ? "target_marker_drift"
          : "target_without_source";
      users.push(conflictRecord(userId, reason, {
        target_plan_id: current[0]?.plan_id ?? null,
        target_content_hash: current[0]?.content == null ? null : sha256(String(current[0].content)),
        content_version: current[0]?.content_version == null ? null : Number(current[0].content_version),
        revision: current[0]?.revision == null ? null : Number(current[0].revision),
        goal_id: current[0]?.goal_id ?? null,
      }));
      continue;
    }
    users.push(emptyRecord(userId));
  }
  users.sort((left, right) => left.user_id.localeCompare(right.user_id));
  const body = { manifest_version: 1, users };
  return { ...body, manifest_hash: sha256(stableJson(body)) };
}

function manifestBody(manifest) {
  return {
    manifest_version: manifest.manifest_version,
    users: manifest.users,
  };
}

function assertReviewedManifest(reviewedManifest, reviewedHash) {
  if (!reviewedManifest || reviewedManifest.manifest_version !== 1 || !Array.isArray(reviewedManifest.users)) {
    throw new ManifestBindingError("reviewed manifest is invalid");
  }
  const computed = sha256(stableJson(manifestBody(reviewedManifest)));
  if (reviewedManifest.manifest_hash !== computed || reviewedHash !== computed) {
    throw new ManifestBindingError("reviewed manifest hash does not match manifest content");
  }
  const ids = reviewedManifest.users.map((record) => record.user_id);
  if (new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || id === "")) {
    throw new ManifestBindingError("reviewed manifest user identities are invalid");
  }
}

async function candidateForCommit(userId, record, source, target, goalSeed) {
  const [current, goals, structured, markdown] = await Promise.all([
    target.listCurrentMasterPlans(userId),
    target.listCurrentRaceGoals(userId),
    source.listStructured(userId),
    source.readMarkdown(userId),
  ]);
  if (record.source_kind === "structured") {
    const classified = classifyStructured(userId, structured, current, goals);
    if (structured.length !== 1) return { classified, row: null, goalRow: null };
    let row;
    try {
      row = structuredRowFromEntity(structured[0]);
      const goal = selectCurrentGoal(userId, goals);
      if (goal.row) row = rebindStructuredGoal(row, goal.row.goal_id);
    } catch {
      row = null;
    }
    return { classified, row, goalRow: null };
  }
  if (record.source_kind === "markdown") {
    const classified = structured.length > 0
      ? classifyStructured(userId, structured, current, goals)
      : markdown
        ? classifyMarkdown(userId, markdown, current, goals, goalSeed)
        : emptyRecord(userId);
    if (!markdown || !goalSeed) return { classified, row: null, goalRow: null };
    const goalId = goals.length === 1
      ? selectCurrentGoal(userId, goals).row?.goal_id
      : uuidFromIdentity("markdown-goal", userId);
    if (!goalId) return { classified, row: null, goalRow: null };
    const planId = current.length === 1 && Number(current[0].content_version) === 1
      ? current[0].plan_id
      : uuidFromIdentity("markdown-plan", userId);
    const row = markdownRow(userId, planId, markdown.text, goalId, {
      createdAt: markdown.lastModified,
      updatedAt: markdown.lastModified,
    });
    return {
      classified,
      row,
      goalRow: goals.length === 0
        ? {
            ...raceGoalRowFromSeed(userId, goalId, goalSeed),
            created_at: row.created_at,
            updated_at: row.updated_at,
          }
        : null,
    };
  }
  let classified;
  if (structured.length > 0) {
    classified = classifyStructured(userId, structured, current, goals);
  } else if (markdown) {
    classified = classifyMarkdown(userId, markdown, current, goals, goalSeed);
  } else if (current.length > 0) {
    const reason = current.length > 1
      ? "target_multiple_current"
      : current[0].status !== "active" || Number(current[0].active_flag) !== 1
        ? "target_marker_drift"
        : "target_without_source";
    classified = conflictRecord(userId, reason, {
      target_plan_id: current[0]?.plan_id ?? null,
      target_content_hash: current[0]?.content == null ? null : sha256(String(current[0].content)),
      content_version: current[0]?.content_version == null ? null : Number(current[0].content_version),
      revision: current[0]?.revision == null ? null : Number(current[0].revision),
      goal_id: current[0]?.goal_id ?? null,
    });
  } else {
    classified = emptyRecord(userId);
  }
  return { classified, row: null, goalRow: null };
}

function sameReviewedRecord(actual, reviewed) {
  return stableJson(actual) === stableJson(reviewed);
}

function validVerifiedRow(userId, expected, rows) {
  if (rows.length !== 1) return false;
  const row = rows[0];
  const revision = row.revision == null ? null : Number(row.revision);
  return row.user_id === userId &&
    row.plan_id === expected.target_plan_id &&
    row.status === "active" && Number(row.active_flag) === 1 &&
    Boolean(row.created_at) && Boolean(row.updated_at) &&
    Number(row.content_version) === expected.content_version &&
    revision === expected.revision &&
    row.goal_id === expected.goal_id &&
    sha256(String(row.content)) === expected.post_commit_hash;
}

export async function commitMasterPlanManifest({
  reviewedManifest,
  reviewedHash,
  source,
  target,
  goalSeeds = {},
}) {
  assertReviewedManifest(reviewedManifest, reviewedHash);
  if (reviewedManifest.users.some((record) => record.action === "conflict")) {
    throw new ManifestBindingError("reviewed manifest contains unresolved conflict records");
  }
  const reread = new Map();

  // Re-read every reviewed source and target before allowing the first write.
  for (const reviewed of reviewedManifest.users) {
    const snapshot = await candidateForCommit(
      reviewed.user_id,
      reviewed,
      source,
      target,
      goalSeeds[reviewed.user_id],
    );
    if (!sameReviewedRecord(snapshot.classified, reviewed)) {
      throw new ManifestBindingError(`source or target drift for user ${reviewed.user_id}`);
    }
    reread.set(reviewed.user_id, snapshot);
  }

  const users = [];
  for (const reviewed of reviewedManifest.users) {
    if (reviewed.action !== "insert") {
      users.push({ ...reviewed });
      continue;
    }
    const snapshot = reread.get(reviewed.user_id);
    if (!snapshot?.row) {
      throw new ManifestBindingError(`reviewed insert has no bound row for user ${reviewed.user_id}`);
    }
    await target.transaction(reviewed.user_id, async (tx) => {
      if (snapshot.goalRow) await tx.insertRaceGoal(snapshot.goalRow);
      await tx.insertMasterPlan(snapshot.row);
    });
    const verified = await target.listCurrentMasterPlans(reviewed.user_id);
    if (!validVerifiedRow(reviewed.user_id, reviewed, verified)) {
      throw new Error(`post-commit verification failed for user ${reviewed.user_id}`);
    }
    users.push({ ...reviewed, action: "inserted", reason: "committed_and_verified" });
  }

  return { manifest_version: 1, users, reviewed_manifest_hash: reviewedHash };
}
