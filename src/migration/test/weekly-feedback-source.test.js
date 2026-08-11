import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { makeWeeklyFeedbackSource } from "../src/weekly-feedback-source.js";

const USER = "11111111-2222-4333-8444-555555555555";

test("local source reads SQLite rows and feedback.md metadata without writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weekly-feedback-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDir = join(root, USER);
  const weekDir = join(userDir, "logs", "2025-12-29_01-04(P1W1)");
  mkdirSync(weekDir, { recursive: true });
  const db = new DatabaseSync(join(userDir, "coros.db"));
  db.exec("CREATE TABLE weekly_feedback (week TEXT, content_md TEXT, created_at TEXT, updated_at TEXT)");
  db.prepare("INSERT INTO weekly_feedback VALUES (?, ?, ?, ?)").run("2025-12-29_01-04(P1W1)", "db", "2025-12-29 00:00:00", "2026-01-04 00:00:00");
  db.close();
  const feedbackPath = join(weekDir, "feedback.md");
  writeFileSync(feedbackPath, "file");
  const modified = new Date("2026-01-04T05:06:07Z");
  await utimes(feedbackPath, modified, modified);

  const source = makeWeeklyFeedbackSource(root);
  assert.deepEqual(await source.listSQLite(USER), [{
    week: "2025-12-29_01-04(P1W1)", content_md: "db",
    created_at: "2025-12-29 00:00:00", updated_at: "2026-01-04 00:00:00",
  }]);
  const markdown = await source.listMarkdown(USER);
  assert.equal(markdown[0].folder, "2025-12-29_01-04(P1W1)");
  assert.equal(markdown[0].text, "file");
  assert.equal(new Date(markdown[0].lastModified).toISOString(), modified.toISOString());
});

test("missing local source files produce empty candidate lists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weekly-feedback-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = makeWeeklyFeedbackSource(root);
  assert.deepEqual(await source.listSQLite(USER), []);
  assert.deepEqual(await source.listMarkdown(USER), []);
});
