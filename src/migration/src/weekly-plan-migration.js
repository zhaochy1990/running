import { randomUUID } from "node:crypto";

import {
  WeeklyPlanTransformError,
  describeMarkdownSource,
  describeStructuredSource,
  markdownWeeklyPlanRow,
  masterPlanCandidates,
  selectPlanSources,
  structuredWeeklyPlanRow,
  weeklyPlanContentEqual,
} from "./weekly-plan-transform.js";

function manualRecord(userId, issue, sourceRef = null) {
  return {
    user_id: userId,
    week_start: issue.weekStart ?? null,
    source: sourceRef,
    reason: issue.reason,
    message: issue.message,
  };
}

/** Run the migration over injected Azure/MySQL adapters. */
export async function migrateWeeklyPlans({
  userIds,
  source,
  target,
  apply = false,
  uuidFactory = randomUUID,
  allowUnownedUserIds = new Set(),
}) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    stats: { planned: 0, inserted: 0, existing: 0, conflicts: 0, manual: 0 },
    actions: [],
    manual: [],
  };

  for (const userId of userIds) {
    const [rawStructured, rawMarkdown, existingRows, masterPlans] = await Promise.all([
      source.listStructured(userId),
      source.listMarkdown(userId),
      target.listActiveWeeklyPlans(userId),
      target.listMasterPlans(userId),
    ]);

    const structured = [];
    const structuredBlockedWeeks = new Set();
    for (const raw of rawStructured) {
      const described = describeStructuredSource(raw);
      if (described.source) structured.push(described.source);
      else {
        for (const weekStart of described.blockedWeeks ?? []) {
          structuredBlockedWeeks.add(weekStart);
        }
        report.manual.push(manualRecord(userId, described.issue, raw.rowKey ?? null));
      }
    }
    const markdown = [];
    for (const raw of rawMarkdown) {
      const described = describeMarkdownSource(raw);
      if (
        described.source &&
        !structuredBlockedWeeks.has(described.source.weekStart)
      ) {
        markdown.push(described.source);
      } else if (!described.source) {
        report.manual.push(manualRecord(userId, described.issue, raw.name ?? null));
      }
    }

    const { selected, issues } = selectPlanSources(structured, markdown);
    for (const issue of issues) report.manual.push(manualRecord(userId, issue));

    const existingByWeek = new Map();
    for (const row of existingRows) {
      const rows = existingByWeek.get(row.week_start) ?? [];
      rows.push(row);
      existingByWeek.set(row.week_start, rows);
    }

    for (const selectedSource of selected) {
      const ownership = masterPlanCandidates(masterPlans, selectedSource.weekStart);
      if (ownership.length > 1) {
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: selectedSource.weekStart,
              reason: "master_plan_ambiguity",
              message: `${selectedSource.weekStart} belongs to ${ownership.length} master plans`,
            },
            selectedSource.sourceRef,
          ),
        );
        continue;
      }
      if (
        ownership.length === 0 &&
        masterPlans.some((plan) => Number(plan.content_version) === 1)
      ) {
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: selectedSource.weekStart,
              reason: "master_plan_ownership_unknown",
              message: `${selectedSource.weekStart} may belong to an opaque legacy master plan`,
            },
            selectedSource.sourceRef,
          ),
        );
        continue;
      }
      if (
        ownership.length === 0 &&
        masterPlans.length === 0 &&
        !allowUnownedUserIds.has(userId)
      ) {
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: selectedSource.weekStart,
              reason: "master_plan_prerequisite_missing",
              message: "no migrated master plan exists; explicitly confirm this user has independent weekly plans",
            },
            selectedSource.sourceRef,
          ),
        );
        continue;
      }

      let candidate;
      try {
        if (selectedSource.kind === "markdown" && selectedSource.value.text === undefined) {
          selectedSource.value.text = await source.readMarkdown(selectedSource.value);
        }
        candidate = selectedSource.kind === "structured"
          ? structuredWeeklyPlanRow(selectedSource, userId, ownership[0] ?? null)
          : markdownWeeklyPlanRow(selectedSource, userId, ownership[0] ?? null);
      } catch (error) {
        const reason = error instanceof WeeklyPlanTransformError ? error.reason : "invalid_content";
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: selectedSource.weekStart,
              reason,
              message: String(error?.message ?? error),
            },
            selectedSource.sourceRef,
          ),
        );
        continue;
      }

      const matches = existingByWeek.get(candidate.week_start) ?? [];
      if (matches.length > 1) {
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: candidate.week_start,
              reason: "conflict",
              message: `${matches.length} active target rows exist for ${candidate.week_start}`,
            },
            selectedSource.sourceRef,
          ),
        );
        report.stats.conflicts++;
        continue;
      }
      if (matches.length === 1) {
        if (weeklyPlanContentEqual(matches[0], candidate)) {
          report.stats.existing++;
          report.actions.push({ user_id: userId, week_start: candidate.week_start, action: "existing" });
        } else {
          report.stats.conflicts++;
          report.manual.push(
            manualRecord(
              userId,
              {
                weekStart: candidate.week_start,
                reason: "conflict",
                message: `target active row has different content for ${candidate.week_start}`,
              },
              selectedSource.sourceRef,
            ),
          );
        }
        continue;
      }

      report.stats.planned++;
      if (!apply) {
        report.actions.push({ user_id: userId, week_start: candidate.week_start, action: "would_insert" });
        continue;
      }
      const row = { plan_id: uuidFactory(), ...candidate };
      try {
        await target.insertWeeklyPlan(row);
        report.stats.inserted++;
        report.actions.push({ user_id: userId, week_start: candidate.week_start, action: "inserted" });
      } catch (error) {
        report.stats.conflicts++;
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: candidate.week_start,
              reason: "conflict",
              message: `insert failed without overwrite: ${String(error?.message ?? error)}`,
            },
            selectedSource.sourceRef,
          ),
        );
      }
    }
  }

  report.stats.manual = report.manual.length;
  return report;
}
