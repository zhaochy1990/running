import { randomUUID } from "node:crypto";

import {
  WeeklyPlanTransformError,
  describeMarkdownSource,
  describeStructuredSource,
  markdownWeeklyPlanRow,
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
  preferMarkdownUserIds = new Set(),
  replaceExistingUserIds = new Set(),
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

    const { selected, issues } = selectPlanSources(structured, markdown, {
      preferMarkdown: preferMarkdownUserIds.has(userId),
    });
    for (const issue of issues) report.manual.push(manualRecord(userId, issue));

    const existingByWeek = new Map();
    for (const row of existingRows) {
      const rows = existingByWeek.get(row.week_start) ?? [];
      rows.push(row);
      existingByWeek.set(row.week_start, rows);
    }

    for (const selectedSource of selected) {
      if (masterPlans.length > 1) {
        report.manual.push(
          manualRecord(
            userId,
            {
              weekStart: selectedSource.weekStart,
              reason: "master_plan_ambiguity",
              message: `${selectedSource.weekStart} has ${masterPlans.length} active master plan candidates`,
            },
            selectedSource.sourceRef,
          ),
        );
        continue;
      }
      // A user has at most one active season plan, so every weekly plan belongs
      // to it regardless of source format or date-window completeness.
      const masterPlanId = masterPlans[0]?.plan_id ?? null;

      let candidate;
      try {
        if (selectedSource.kind === "markdown" && selectedSource.value.text === undefined) {
          selectedSource.value.text = await source.readMarkdown(selectedSource.value);
        }
        candidate = selectedSource.kind === "structured"
          ? structuredWeeklyPlanRow(selectedSource, userId, masterPlanId)
          : markdownWeeklyPlanRow(selectedSource, userId, masterPlanId);
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
        } else if (apply && replaceExistingUserIds.has(userId)) {
          await target.replaceWeeklyPlan({ ...matches[0], ...candidate });
          report.stats.updated = (report.stats.updated ?? 0) + 1;
          report.actions.push({ user_id: userId, week_start: candidate.week_start, action: "updated" });
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
