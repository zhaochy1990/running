import assert from "node:assert/strict";
import test from "node:test";

import { goBackfillArgs, goBackfillEnv } from "../src/activity-start-gps-backfill.js";
import { users as REAL_USERS } from "../src/users.js";

test("backfill wrapper passes the canonical real-user allowlist to Go", () => {
  const args = goBackfillArgs(["--commit", "--limit", "2"]);
  assert.deepEqual(args, [
    "run", "./cmd/stride", "backfill-activity-start-gps",
    "--commit", "--limit", "2",
  ]);
  const env = goBackfillEnv({ STRIDE_ACTIVITY_START_GPS_REAL_USERS: "test-user" });
  assert.equal(env.STRIDE_ACTIVITY_START_GPS_REAL_USERS, REAL_USERS.join(","));
});
