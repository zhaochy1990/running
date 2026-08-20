export class MasterPlanSchemaConflictError extends Error {}

const CANONICAL_CHECKS = {
  ck_master_plan_content_version: "content_versionin1,2",
  ck_master_plan_revision:
    "content_version=1andrevisionisnullorcontent_version=2andrevision>=1",
  ck_master_plan_current_marker:
    "status='active'andactive_flag=1orstatus<>'active'andactive_flagisnull",
};

function normalizeClause(clause) {
  return String(clause)
    .toLowerCase()
    .replace(/_[a-z0-9]+(?=')/g, "")
    .replace(/[`\s()]/g, "");
}

function assertCanonicalInspection(inspection) {
  if (
    !inspection.revisionColumn ||
    String(inspection.revisionColumn.data_type).toLowerCase() !== "bigint" ||
    String(inspection.revisionColumn.is_nullable).toUpperCase() !== "YES"
  ) {
    throw new MasterPlanSchemaConflictError("revision column does not match canonical schema");
  }
  for (const [name, expected] of Object.entries(CANONICAL_CHECKS)) {
    const clause = inspection.checks?.[name];
    if (typeof clause !== "string" || normalizeClause(clause) !== expected) {
      throw new MasterPlanSchemaConflictError("canonical constraints are missing or invalid");
    }
  }
  const activeIndex = inspection.uniqueIndexes?.uidx_master_plan_active;
  if (!Array.isArray(activeIndex) || activeIndex.join(",") !== "user_id,active_flag") {
    throw new MasterPlanSchemaConflictError("canonical active unique index is missing");
  }
}

async function assertRows(adapter, column) {
  const result = await adapter.validateRows(column);
  if (!result?.valid) {
    throw new MasterPlanSchemaConflictError(
      `master_plan has ${result?.invalid_count ?? "unknown"} invalid rows for ${column}`,
    );
  }
}

export async function upgradeMasterPlanSchema(adapter) {
  const before = await adapter.inspect();
  const hasVersion = before.columns.includes("version");
  const hasRevision = before.columns.includes("revision");
  if (hasVersion === hasRevision) {
    throw new MasterPlanSchemaConflictError(
      hasVersion
        ? "master_plan has both version and revision columns"
        : "master_plan has neither version nor revision column",
    );
  }

  if (hasRevision) {
    await assertRows(adapter, "revision");
    assertCanonicalInspection(before);
    return { state: "validated", column: "revision" };
  }

  await assertRows(adapter, "version");
  await adapter.renameVersionAndReplaceChecks();
  const after = await adapter.inspect();
  if (after.columns.includes("version") || !after.columns.includes("revision")) {
    throw new MasterPlanSchemaConflictError("schema upgrade did not produce revision-only state");
  }
  await assertRows(adapter, "revision");
  assertCanonicalInspection(after);
  return { state: "upgraded", from: "version", to: "revision" };
}
