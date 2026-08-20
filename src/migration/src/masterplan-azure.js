// masterplan-azure.js — rewrite the embedded goal_id inside a user's master-plan
// snapshots in Azure Table Storage, so a slug goal_id that was re-minted to a
// uuid for the MySQL race_goal row stays consistent with the plans that
// reference it.
//
// The master-plan store lives in two Azure tables (mirrors the Python backend
// src/stride_storage/azure/master_plan_backend.py):
//   - <tableName>          "stridemasterplan"        PK=user_id, RK=plan_id,
//                          column `plan_json`     = MasterPlan.model_dump_json()
//   - <tableName>versions  "stridemasterplanversions" PK=plan_id, RK=version_id,
//                          column `snapshot_json` = a full plan snapshot
// Both JSON blobs embed the goal at `.goal.goal_id` (see stride_core/master_plan.py
// MasterPlanGoal). This module rewrites that one field slug→uuid, in place.
//
// Auth is DefaultAzureCredential — the same credential the Python backend and
// akv.js use (run `az login` first, or set AZURE_* SP env vars). The pure
// rewrite core (rewriteGoalIdInJson / parseMasterPlanConfig) is dependency-free
// and unit-tested; the Table I/O wrapper is a thin shell over @azure/data-tables.

import { DefaultAzureCredential } from "@azure/identity";
import { odata, TableClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";

const DEFAULT_TABLE_NAME = "stridemasterplan";

/**
 * Resolve the master-plan Table config from env, matching the server's
 * STRIDE_MASTER_PLAN_* wiring (src/stride_server/config/sources.py). The
 * versions table name is the plans table name + "versions" (backend convention).
 *
 * @returns {{ accountUrl: string, tableName: string, versionsTableName: string }}
 */
export function parseMasterPlanConfig(env) {
  const accountUrl = (env.STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL || "").trim();
  const tableName =
    (env.STRIDE_MASTER_PLAN_TABLE_NAME || "").trim() || DEFAULT_TABLE_NAME;
  return {
    accountUrl,
    tableName,
    versionsTableName: tableName + "versions",
  };
}

export function parseMasterPlanSourceConfig(env) {
  const table = parseMasterPlanConfig(env);
  return {
    tableAccountUrl: table.accountUrl,
    tableName: table.tableName,
    blobAccountUrl: (env.STRIDE_CONTENT_BLOB_ACCOUNT_URL || "").trim(),
    container: (
      env.STRIDE_CONTENT_BLOB_CONTAINER || env.STRIDE_CONTENT_CONTAINER || "stride-data"
    ).trim(),
    prefix: (
      env.STRIDE_CONTENT_BLOB_PREFIX ?? env.STRIDE_CONTENT_PREFIX ?? "users"
    ).trim().replace(/^\/+|\/+$/g, ""),
  };
}

/**
 * Pure: rewrite `.goal.goal_id` (and a legacy top-level `.goal_id`) from `oldId`
 * to `newId` inside a serialized plan/snapshot JSON string. Returns the
 * re-serialized JSON and whether anything changed. Idempotent: a snapshot whose
 * goal_id is already `newId` (or anything other than `oldId`) is returned
 * unchanged with `changed:false`. Key order and compactness round-trip through
 * JSON.parse/stringify, which the downstream Pydantic re-validation ignores.
 *
 * @returns {{ json: string, changed: boolean }}
 */
export function rewriteGoalIdInJson(jsonStr, oldId, newId) {
  let doc;
  try {
    doc = JSON.parse(jsonStr);
  } catch {
    throw new Error("master-plan snapshot is not valid JSON");
  }
  let changed = false;
  if (doc && typeof doc === "object") {
    if (
      doc.goal &&
      typeof doc.goal === "object" &&
      doc.goal.goal_id === oldId
    ) {
      doc.goal.goal_id = newId;
      changed = true;
    }
    // Legacy plans that stored goal_id at the top level (pre-embedded-goal).
    if (doc.goal_id === oldId) {
      doc.goal_id = newId;
      changed = true;
    }
  }
  return { json: changed ? JSON.stringify(doc) : jsonStr, changed };
}

/**
 * Build the two TableClients (plans + versions). Credential defaults to
 * DefaultAzureCredential; pass one in for tests/other identities.
 */
export function makeMasterPlanSource(config, credential = new DefaultAzureCredential(), clients = {}) {
  const table = clients.table ?? new TableClient(
    config.tableAccountUrl,
    config.tableName,
    credential,
  );
  const container = clients.container ?? new BlobServiceClient(config.blobAccountUrl, credential)
    .getContainerClient(config.container);
  return {
    async listStructured(userId) {
      const entities = [];
      for await (const entity of table.listEntities({
        queryOptions: {
          filter: odata`PartitionKey eq ${userId} and kind eq ${"plan"} and status eq ${"active"}`,
        },
      })) {
        entities.push(entity);
      }
      return entities;
    },
    async readMarkdown(userId) {
      const blobName = `${config.prefix ? config.prefix + "/" : ""}${userId}/TRAINING_PLAN.md`;
      const blob = container.getBlobClient(blobName);
      if (!(await blob.exists())) return null;
      const [buffer, properties] = await Promise.all([
        blob.downloadToBuffer(),
        blob.getProperties(),
      ]);
      return {
        user_id: userId,
        blob_name: blobName,
        text: buffer.toString("utf8"),
        lastModified: properties.lastModified ?? null,
      };
    },
  };
}

export function makeTableClients(config, credential = new DefaultAzureCredential()) {
  if (!config.accountUrl) {
    throw new Error(
      "STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL is required to rewrite master-plan snapshots",
    );
  }
  return {
    plans: new TableClient(config.accountUrl, config.tableName, credential),
    versions: new TableClient(
      config.accountUrl,
      config.versionsTableName,
      credential,
    ),
  };
}

/**
 * Rewrite the embedded goal_id slug→uuid across all of one user's master-plan
 * snapshots (every plan in the plans table + every version of those plans in the
 * versions table). In dry-run (`commit:false`) it only scans and counts what
 * would change; with `commit:true` it MERGE-updates the changed entities.
 *
 * @param {{plans: TableClient, versions: TableClient}} clients
 * @returns {Promise<{plansScanned:number, plansRewritten:number, versionsScanned:number, versionsRewritten:number}>}
 */
export async function rewriteUserGoalId(
  clients,
  userId,
  oldId,
  newId,
  { commit = false } = {},
) {
  const stats = {
    plansScanned: 0,
    plansRewritten: 0,
    versionsScanned: 0,
    versionsRewritten: 0,
  };

  const planIds = [];
  const plansIter = clients.plans.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${userId}` },
  });
  for await (const entity of plansIter) {
    stats.plansScanned++;
    planIds.push(entity.rowKey);
    const raw = entity.plan_json;
    if (typeof raw !== "string" || raw === "") continue;
    const { json, changed } = rewriteGoalIdInJson(raw, oldId, newId);
    if (!changed) continue;
    stats.plansRewritten++;
    if (commit) {
      await clients.plans.updateEntity(
        { partitionKey: entity.partitionKey, rowKey: entity.rowKey, plan_json: json },
        "Merge",
      );
    }
  }

  for (const planId of planIds) {
    const versionsIter = clients.versions.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${planId}` },
    });
    for await (const entity of versionsIter) {
      stats.versionsScanned++;
      const raw = entity.snapshot_json;
      if (typeof raw !== "string" || raw === "") continue;
      const { json, changed } = rewriteGoalIdInJson(raw, oldId, newId);
      if (!changed) continue;
      stats.versionsRewritten++;
      if (commit) {
        await clients.versions.updateEntity(
          {
            partitionKey: entity.partitionKey,
            rowKey: entity.rowKey,
            snapshot_json: json,
          },
          "Merge",
        );
      }
    }
  }

  return stats;
}
