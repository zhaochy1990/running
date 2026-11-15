import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import { MySqlDataProvider } from "../../src/data/mysqlDataProvider.js";

const url = process.env.STRIDE_989_ISOLATED_MYSQL_URL;
const fixturePath = process.env.STRIDE_989_CALIBRATION_FIXTURE;

test("Go-published calibration bundles agree with the real TS MySQL adapter", { skip: !url || !fixturePath }, async () => {
  if (!url || !fixturePath) throw new Error("missing isolated calibration fixture");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^\/[\w-]+_test$/.test(parsed.pathname)) {
    throw new Error("STRIDE_989_ISOLATED_MYSQL_URL must point to an isolated local test database");
  }
  // Go storage owns migration, seed, policy mutation and cleanup. This test only
  // reads the exported cases while its coordinator holds policy fixed.
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
  const pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 2 });
  try {
    const provider = new MySqlDataProvider(pool);
    for (const item of fixture.cases) {
      const expected = item.bundle;
      const actual = await provider.getLatestRunningCalibration(item.user_id, item.cutoff, item.mode);
      if (!expected.snapshot) {
        assert.equal(actual, null, item.name);
        continue;
      }
      assert.ok(actual, item.name);
      assert.equal(actual.calibrationId, expected.snapshot.ID, item.name);
      assert.equal(actual.algorithmVersion, expected.snapshot.AlgorithmVersion, item.name);
      assert.equal(actual.asOfDate, expected.snapshot.AsOfDate, item.name);
      assert.equal(actual.thresholdHr, expected.snapshot.ThresholdHR, item.name);
      assert.equal(actual.thresholdSpeedMps, expected.snapshot.ThresholdSpeedMps, item.name);
      assert.equal(actual.rhrBaseline, expected.snapshot.RHRBaseline, item.name);
      assert.deepEqual(actual.selection, expected.selection, item.name);
      assert.deepEqual(actual.source, expected.source, item.name);
      assert.equal(actual.fingerprint ?? "", expected.fingerprint, item.name);
      assert.deepEqual(
        actual.paceZones,
        expected.pace_zones.map((row: Record<string, unknown>) => ({
          name: row.Name,
          minPaceSPerKm: row.MinPaceSPerKm,
          maxPaceSPerKm: row.MaxPaceSPerKm,
        })),
        item.name,
      );
      assert.deepEqual(
        actual.heartRateZones,
        expected.hr_zones.map((row: Record<string, unknown>) => ({
          name: row.Name,
          minBpm: row.MinBpm,
          maxBpm: row.MaxBpm,
        })),
        item.name,
      );
    }
  } finally {
    await pool.end();
  }
});
