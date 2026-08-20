import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActivityStartGPSCli,
  runActivityStartGPSBackfill,
} from "../src/activity-start-gps-backfill.js";

const USER = "11111111-1111-4111-8111-111111111111";

test("CLI is dry-run by default and validates safety limits", () => {
  assert.deepEqual(parseActivityStartGPSCli(["--user", USER]), {
    commit: false,
    requestedUsers: [USER],
    maxActivities: Infinity,
    batchSize: 25,
    delayMs: 25,
    help: false,
  });
  assert.throws(() => parseActivityStartGPSCli(["--batch-size", "501"]), /1 to 500/);
  assert.throws(() => parseActivityStartGPSCli(["--limit", "0"]), /positive integer/);
  assert.throws(() => parseActivityStartGPSCli(["--delay-ms=-1"]), /non-negative/);
});

function fakeConnection({ activities, points }) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM activities") && sql.includes("COUNT(*)")) {
        const rows = activities.filter((a) => a.user_id === params[0]);
        return [[{
          total: rows.length,
          cached: rows.filter((a) => a.start_gps_lat != null && a.start_gps_lon != null).length,
          missing: rows.filter((a) => a.start_gps_lat == null && a.start_gps_lon == null).length,
          partial: rows.filter((a) => (a.start_gps_lat == null) !== (a.start_gps_lon == null)).length,
        }]];
      }
      if (sql.includes("FROM activities") && sql.includes("label_id > ?")) {
        const [userId, cursor] = params;
        const limit = Number(sql.match(/LIMIT (\d+)\s*$/)?.[1]);
        const rows = activities
          .filter((a) => a.user_id === userId && a.label_id > cursor)
          .filter((a) => a.start_gps_lat == null && a.start_gps_lon == null)
          .sort((a, b) => a.label_id.localeCompare(b.label_id))
          .slice(0, limit)
          .map(({ label_id }) => ({ label_id }));
        return [rows];
      }
      if (sql.includes("FROM timeseries")) {
        const [userId, labelId] = params;
        if (points[labelId] instanceof Error) throw points[labelId];
        const row = (points[labelId] || []).find(
          ([lat, lon]) =>
            lat != null && lon != null && lat >= -90 && lat <= 90 &&
            lon >= -180 && lon <= 180 && (lat !== 0 || lon !== 0),
        );
        return [row ? [{ gps_lat: row[0], gps_lon: row[1] }] : []];
      }
      if (/^\s*UPDATE activities/m.test(sql)) {
        const [lat, lon, userId, labelId] = params;
        const activity = activities.find(
          (a) => a.user_id === userId && a.label_id === labelId,
        );
        if (!activity || activity.start_gps_lat != null || activity.start_gps_lon != null) {
          return [{ affectedRows: 0 }];
        }
        activity.start_gps_lat = lat;
        activity.start_gps_lon = lon;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SELECT start_gps_lat, start_gps_lon")) {
        const [userId, labelId] = params;
        const activity = activities.find(
          (a) => a.user_id === userId && a.label_id === labelId,
        );
        return [activity ? [{
          start_gps_lat: activity.start_gps_lat,
          start_gps_lon: activity.start_gps_lon,
        }] : []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test("dry-run finds activity-level starts without writing", async () => {
  const connection = fakeConnection({
    activities: [
      { user_id: USER, label_id: "a", start_gps_lat: null, start_gps_lon: null },
      { user_id: USER, label_id: "b", start_gps_lat: null, start_gps_lon: null },
      { user_id: USER, label_id: "done", start_gps_lat: 31.2, start_gps_lon: 121.4 },
    ],
    points: {
      a: [[0, 0], [95, 121], [31.2304, 121.4737]],
      b: [[null, 121], [31.1, null]],
    },
  });

  const report = await runActivityStartGPSBackfill({
    connection,
    userIds: [USER],
    commit: false,
    batchSize: 2,
    delayMs: 0,
  });

  assert.deepEqual(report, {
    mode: "dry-run",
    users: 1,
    total: 3,
    already_cached: 1,
    missing: 2,
    scanned: 2,
    fillable: 1,
    updated: 0,
    verified: 0,
    no_valid_gps: 1,
    skipped_concurrent: 0,
    failed: 0,
  });
  assert.equal(connection.calls.some(({ sql }) => /^\s*UPDATE /m.test(sql)), false);
  const timeseriesCalls = connection.calls.filter(({ sql }) => sql.includes("FROM timeseries"));
  assert.equal(timeseriesCalls.length, 2);
  for (const { sql, params } of timeseriesCalls) {
    assert.match(sql, /user_id = \? AND label_id = \?/);
    assert.match(sql, /ORDER BY id\s+LIMIT 1/);
    assert.doesNotMatch(sql, /GROUP BY/i);
    assert.equal(params[0], USER);
  }
  const pageCalls = connection.calls.filter(
    ({ sql }) => sql.includes("FROM activities") && sql.includes("label_id > ?"),
  );
  assert.ok(pageCalls.length > 0);
  for (const { sql, params } of pageCalls) {
    assert.match(sql, /LIMIT 2\s*$/);
    assert.equal(params.length, 2);
  }
});

test("commit conditionally updates and verifies each fillable activity", async () => {
  const activities = [
    { user_id: USER, label_id: "a", start_gps_lat: null, start_gps_lon: null },
    { user_id: USER, label_id: "b", start_gps_lat: null, start_gps_lon: null },
  ];
  const connection = fakeConnection({
    activities,
    points: { a: [[31.2304, 121.4737]], b: [] },
  });

  const first = await runActivityStartGPSBackfill({
    connection, userIds: [USER], commit: true, batchSize: 1, delayMs: 0,
  });
  assert.equal(first.updated, 1);
  assert.equal(first.verified, 1);
  assert.equal(first.no_valid_gps, 1);
  assert.deepEqual(
    activities.find((a) => a.label_id === "a"),
    { user_id: USER, label_id: "a", start_gps_lat: 31.2304, start_gps_lon: 121.4737 },
  );
  const update = connection.calls.find(({ sql }) => /^\s*UPDATE activities/m.test(sql));
  assert.match(update.sql, /start_gps_lat IS NULL AND start_gps_lon IS NULL/);

  const second = await runActivityStartGPSBackfill({
    connection, userIds: [USER], commit: true, batchSize: 2, delayMs: 0,
  });
  assert.equal(second.already_cached, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.no_valid_gps, 1);
});

test("commit reports a concurrent winner without overwriting it", async () => {
  const activities = [
    { user_id: USER, label_id: "a", start_gps_lat: null, start_gps_lon: null },
  ];
  const connection = fakeConnection({
    activities, points: { a: [[31.2304, 121.4737]] },
  });
  const originalExecute = connection.execute.bind(connection);
  connection.execute = async (sql, params) => {
    if (/^\s*UPDATE activities/m.test(sql)) {
      activities[0].start_gps_lat = 39.9042;
      activities[0].start_gps_lon = 116.4074;
      return [{ affectedRows: 0 }];
    }
    return originalExecute(sql, params);
  };

  const report = await runActivityStartGPSBackfill({
    connection, userIds: [USER], commit: true, delayMs: 0,
  });
  assert.equal(report.updated, 0);
  assert.equal(report.skipped_concurrent, 1);
  assert.deepEqual(activities[0], {
    user_id: USER, label_id: "a", start_gps_lat: 39.9042, start_gps_lon: 116.4074,
  });
});

test("one activity failure is reported and later activities continue", async () => {
  const activities = [
    { user_id: USER, label_id: "a", start_gps_lat: null, start_gps_lon: null },
    { user_id: USER, label_id: "b", start_gps_lat: null, start_gps_lon: null },
  ];
  const connection = fakeConnection({
    activities,
    points: { a: new Error("temporary read failure"), b: [[31.2304, 121.4737]] },
  });

  const report = await runActivityStartGPSBackfill({
    connection, userIds: [USER], commit: true, batchSize: 2, delayMs: 0,
  });
  assert.equal(report.failed, 1);
  assert.equal(report.updated, 1);
  assert.equal(report.verified, 1);
  assert.equal(activities[1].start_gps_lat, 31.2304);
});
