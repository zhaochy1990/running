import assert from "node:assert/strict";
import test from "node:test";

import { parseWeeklyFeedbackCli } from "../src/migrate-weekly-feedback.js";
import { selectUserIds } from "../src/profiles.js";
import { users as REAL_USERS } from "../src/users.js";

test("CLI is dry-run by default and parses repeated/comma users, limit, and local paths", () => {
  const options = parseWeeklyFeedbackCli([
    "--user", `${REAL_USERS[0]},${REAL_USERS[1]}`,
    "--user", REAL_USERS[2],
    "--limit", "2",
    "--data-dir", "./fixture-data",
    "--manifest-out", "./manifest.json",
  ], { defaultDataDir: "/repo/data" });
  assert.equal(options.commit, false);
  assert.deepEqual(options.requestedUsers, REAL_USERS.slice(0, 3));
  assert.equal(options.limit, 2);
  assert.match(options.dataDir, /fixture-data$/);
  assert.match(options.manifestOut, /manifest\.json$/);
});

test("commit requires both reviewed manifest path and exact hash", () => {
  for (const argv of [
    ["--commit"],
    ["--commit", "--reviewed-manifest", "review.json"],
    ["--commit", "--reviewed-hash", `sha256:${"a".repeat(64)}`],
  ]) assert.throws(() => parseWeeklyFeedbackCli(argv), /requires/);

  const parsed = parseWeeklyFeedbackCli([
    "--commit", "--reviewed-manifest", "review.json",
    "--reviewed-hash", `sha256:${"a".repeat(64)}`,
  ]);
  assert.equal(parsed.commit, true);
});

test("CLI rejects invalid limits and reviewed options in dry-run", () => {
  for (const value of ["0", "-1", "1.5", "nope"]) {
    assert.throws(() => parseWeeklyFeedbackCli([`--limit=${value}`]), /positive integer/);
  }
  assert.throws(() => parseWeeklyFeedbackCli(["--reviewed-manifest", "x"]), /only with --commit/);
});

test("parsed selectors remain bound to the REAL_USERS allowlist", () => {
  const outsider = "11111111-2222-4333-8444-555555555555";
  const options = parseWeeklyFeedbackCli(["--user", `${REAL_USERS[0]},${outsider}`]);
  const selected = selectUserIds(REAL_USERS, options.requestedUsers, options.limit);
  assert.deepEqual(selected.ids, [REAL_USERS[0]]);
  assert.deepEqual(selected.rejected, [outsider]);
});
