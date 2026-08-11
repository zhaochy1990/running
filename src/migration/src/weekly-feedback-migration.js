import { createHash } from "node:crypto";

import { formatDatetimeMs } from "./masterplan-transform.js";
import { parseWeekFolder } from "./weekly-plan-transform.js";

export class FeedbackManifestError extends Error {}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function parseFeedbackWeek(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})(?:\(([^()]+)\))?$/.exec(value);
  if (!match) return null;
  return parseWeekFolder(match[1])?.weekStart ?? null;
}

function normalizeContent(value) {
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

/**
 * Convert a source timestamp to MySQL DATETIME(3). SQLite's legacy naive
 * timestamps have no zone metadata and are explicitly interpreted as UTC.
 */
function timestamp(value, kind) {
  if (kind === "sqlite") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)) return null;
    const iso = `${value.replace(" ", "T")}Z`;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
    return formatDatetimeMs(iso);
  }
  const input = value instanceof Date ? value.toISOString() : value;
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) return null;
  const parsed = new Date(input);
  return Number.isNaN(parsed.valueOf()) ? null : formatDatetimeMs(input);
}

function issue(userId, sourceKind, sourceRef, weekStart, reason) {
  return {
    user_id: userId, week_start: weekStart, source_kind: sourceKind,
    source_ref: sourceRef, content_hash: null, target_hash: null,
    created_at: null, updated_at: null, action: "conflict", reason,
  };
}

function sourceCandidate(userId, kind, row) {
  const sourceRef = String(kind === "sqlite" ? row.week ?? "" : row.folder ?? row.name ?? "");
  const weekStart = parseFeedbackWeek(sourceRef);
  if (!weekStart) return { record: issue(userId, kind, sourceRef, null, "invalid_week") };
  const rawContent = kind === "sqlite" ? row.content_md : row.text;
  if (typeof rawContent !== "string") {
    return { record: issue(userId, kind, sourceRef, weekStart, "invalid_content") };
  }
  const createdAt = timestamp(kind === "sqlite" ? row.created_at : row.lastModified, kind);
  const updatedAt = timestamp(kind === "sqlite" ? row.updated_at : row.lastModified, kind);
  if (!createdAt || !updatedAt || createdAt > updatedAt) {
    return { record: issue(userId, kind, sourceRef, weekStart, "invalid_timestamp") };
  }
  const content = normalizeContent(rawContent);
  return {
    content,
    row: { user_id: userId, week_start: weekStart, content_md: content, created_at: createdAt, updated_at: updatedAt },
    record: {
      user_id: userId, week_start: weekStart, source_kind: kind, source_ref: sourceRef,
      content_hash: hash(content), target_hash: null, created_at: createdAt, updated_at: updatedAt,
      action: "insert", reason: "target_missing",
    },
  };
}

function normalizedTarget(row) {
  return {
    ...row,
    week_start: row.week_start instanceof Date ? row.week_start.toISOString().slice(0, 10) : String(row.week_start),
    created_at: timestamp(row.created_at instanceof Date ? row.created_at : `${row.created_at.replace(" ", "T")}Z`, "markdown"),
    updated_at: timestamp(row.updated_at instanceof Date ? row.updated_at : `${row.updated_at.replace(" ", "T")}Z`, "markdown"),
  };
}

function exactTarget(target, candidate) {
  return target.user_id === candidate.user_id && target.week_start === candidate.week_start &&
    String(target.content_md) === candidate.content_md &&
    target.created_at === candidate.created_at && target.updated_at === candidate.updated_at;
}

async function classify({ userIds, source, target }) {
  const records = [];
  const rows = new Map();
  const candidatesReport = [];
  for (const userId of userIds) {
    const [sqliteRows, markdownRows, existingRows] = await Promise.all([
      source.listSQLite(userId), source.listMarkdown(userId), target.listWeeklyFeedback(userId),
    ]);
    const sqlite = sqliteRows.map((row) => sourceCandidate(userId, "sqlite", row));
    const markdown = markdownRows.map((row) => sourceCandidate(userId, "markdown", row));
    const invalid = [...sqlite, ...markdown].filter((candidate) => !candidate.row);
    records.push(...invalid.map((candidate) => candidate.record));

    const sqliteWeeks = new Set(sqlite.map((candidate) => candidate.row?.week_start ?? candidate.record.week_start).filter(Boolean));
    const everySourceWeek = new Set([...sqlite, ...markdown]
      .map((candidate) => candidate.row?.week_start ?? candidate.record.week_start).filter(Boolean));
    const selected = [
      ...sqlite.filter((candidate) => candidate.row),
      ...markdown.filter((candidate) => candidate.row && !sqliteWeeks.has(candidate.row.week_start)),
    ];
    for (const candidate of sqlite) {
      candidatesReport.push({
        user_id: userId, source_kind: "sqlite", source_ref: candidate.record.source_ref,
        week_start: candidate.row?.week_start ?? candidate.record.week_start,
        selected: Boolean(candidate.row), reason: candidate.row ? "sqlite_precedence" : candidate.record.reason,
      });
    }
    for (const candidate of markdown) {
      const weekStart = candidate.row?.week_start ?? candidate.record.week_start;
      candidatesReport.push({
        user_id: userId, source_kind: "markdown", source_ref: candidate.record.source_ref,
        week_start: weekStart, selected: Boolean(candidate.row) && !sqliteWeeks.has(weekStart),
        reason: !candidate.row ? candidate.record.reason : sqliteWeeks.has(weekStart) ? "shadowed_by_sqlite" : "markdown_fallback",
      });
    }
    const grouped = new Map();
    for (const candidate of selected) {
      const values = grouped.get(candidate.row.week_start) ?? [];
      values.push(candidate);
      grouped.set(candidate.row.week_start, values);
    }
    const targets = existingRows.map(normalizedTarget);
    for (const targetRow of targets.filter((row) => !everySourceWeek.has(row.week_start))) {
      records.push({
        ...issue(userId, "target", targetRow.week_start, targetRow.week_start, "target_without_source"),
        target_hash: hash(String(targetRow.content_md)),
      });
    }
    for (const [weekStart, candidates] of grouped) {
      if (candidates.length !== 1) {
        records.push(issue(userId, candidates[0].record.source_kind, candidates.map((c) => c.record.source_ref).join(","), weekStart, "duplicate_normalized_week"));
        continue;
      }
      const candidate = candidates[0];
      const matches = targets.filter((row) => row.week_start === weekStart);
      if (matches.length === 1 && exactTarget(matches[0], candidate.row)) {
        candidate.record.action = "identical";
        candidate.record.reason = "content_and_timestamps_match";
        candidate.record.target_hash = hash(String(matches[0].content_md));
      } else if (matches.length > 0) {
        candidate.record.action = "conflict";
        candidate.record.reason = "target_divergent";
        candidate.record.target_hash = matches.length === 1 ? hash(String(matches[0].content_md)) : null;
      }
      records.push(candidate.record);
      rows.set(`${userId}/${weekStart}`, candidate.row);
    }
  }
  records.sort((a, b) => `${a.user_id}/${a.week_start ?? ""}/${a.source_ref}`.localeCompare(`${b.user_id}/${b.week_start ?? ""}/${b.source_ref}`));
  candidatesReport.sort((a, b) => `${a.user_id}/${a.source_ref}`.localeCompare(`${b.user_id}/${b.source_ref}`));
  return { records, rows, candidates: candidatesReport };
}

function manifestBody(users, targetIdentity, records, candidates) {
  return {
    manifest_version: 1, users: [...users].sort(), target_identity: targetIdentity,
    error_count: records.filter((record) => record.action === "conflict").length,
    candidates, records,
  };
}

export async function buildWeeklyFeedbackManifest(options) {
  const targetIdentity = await options.target.getIdentity();
  const { records, candidates } = await classify(options);
  const body = manifestBody(options.userIds, targetIdentity, records, candidates);
  return { ...body, manifest_hash: hash(stableJson(body)) };
}

function validateReviewed(manifest, reviewedHash, userIds) {
  if (!manifest || manifest.manifest_version !== 1 || !Array.isArray(manifest.records)) {
    throw new FeedbackManifestError("reviewed manifest is invalid");
  }
  const body = manifestBody(manifest.users ?? [], manifest.target_identity, manifest.records, manifest.candidates ?? []);
  if (manifest.error_count !== body.error_count || body.error_count !== 0) {
    throw new FeedbackManifestError("reviewed manifest must contain zero errors");
  }
  const computed = hash(stableJson(body));
  if (manifest.manifest_hash !== computed || reviewedHash !== computed) {
    throw new FeedbackManifestError("reviewed manifest hash mismatch");
  }
  const reviewedUsers = [...new Set(manifest.users)].sort();
  const selectedUsers = [...userIds].sort();
  if (stableJson(reviewedUsers) !== stableJson(selectedUsers)) {
    throw new FeedbackManifestError("reviewed manifest users do not match selected users");
  }
}

export async function applyWeeklyFeedbackManifest({ reviewedManifest, reviewedHash, userIds, source, target }) {
  validateReviewed(reviewedManifest, reviewedHash, userIds);
  return target.transaction(async (tx) => {
    // The destination drift check, all inserts, and read-back verification share
    // one global transaction. This leaves no partial per-user commits.
    const current = await classify({ userIds, source, target: tx });
    const currentIdentity = await tx.getIdentity();
    const currentBody = manifestBody(userIds, currentIdentity, current.records, current.candidates);
    if (hash(stableJson(currentBody)) !== reviewedHash) {
      throw new FeedbackManifestError("source or target drift since review");
    }
    for (const record of current.records) {
      if (record.action === "insert") await tx.insertWeeklyFeedback(current.rows.get(`${record.user_id}/${record.week_start}`));
    }
    for (const userId of userIds) {
      const actual = (await tx.listWeeklyFeedback(userId)).map(normalizedTarget);
      for (const record of current.records.filter((item) => item.user_id === userId)) {
        const expected = current.rows.get(`${record.user_id}/${record.week_start}`);
        const matches = actual.filter((row) => row.week_start === record.week_start);
        if (matches.length !== 1 || !exactTarget(matches[0], expected)) {
          throw new Error(`weekly feedback readback verification failed for ${userId}/${record.week_start}`);
        }
      }
    }
    return {
      manifest_version: 1,
      reviewed_manifest_hash: reviewedHash,
      records: current.records.map((record) => record.action === "insert"
        ? { ...record, action: "inserted", reason: "committed_and_verified" }
        : record),
    };
  });
}
