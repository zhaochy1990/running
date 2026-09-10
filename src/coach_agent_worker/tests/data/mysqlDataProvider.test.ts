import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDataProvider } from "../../src/data/mysqlDataProvider.js";

test("getVendorHrvBaseline reads the latest non-null daily vendor band", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const provider = new MySqlDataProvider({
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return [
        [
          {
            date: "20260819",
            baseline_balanced_low: 28,
            baseline_balanced_upper: 36,
            provider: "coros",
          },
        ],
      ];
    },
  } as never);

  assert.deepEqual(await provider.getVendorHrvBaseline("athlete-1", "2026-08-19"), { low: 28, high: 36, provider: "coros", date: "2026-08-19" });
  assert.deepEqual(calls[0]?.values, ["athlete-1", "2026-08-19"]);
  assert.match(calls[0]?.sql ?? "", /baseline_balanced_low IS NOT NULL/);
  assert.match(calls[0]?.sql ?? "", /JOIN dashboard/);
  assert.match(calls[0]?.sql ?? "", /REPLACE\(h.date, '-', ''\) <=/);
});

test("personal best loader preserves label ID and decimal precision contract", async () => {
  let sql = "";
  const provider = new MySqlDataProvider({
    async query(query: string) {
      sql = query;
      return [
        [
          {
            distance: "5K",
            pb_time_sec: "1170.34",
            achieved_at: "2026-05-27",
            activity_label_id: "activity-5k-pb",
          },
        ],
      ];
    },
  } as never);
  assert.deepEqual(await provider.getPersonalBests("athlete", "2026-08-14"), [
    {
      distance: "5K",
      timeSec: 1170.3,
      achievedAt: "2026-05-27",
      activityLabelId: "activity-5k-pb",
    },
  ]);
  assert.match(sql, /entry_json, '\$\.label_id'/);
});

test("plan reads are scoped to user, active version, and week start", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const provider = new MySqlDataProvider({
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      const content =
        calls.length === 1
          ? {
              id: 1,
              start_date: "2026-08-01",
              end_date: "2026-08-31",
            }
          : { id: 2 };
      return [[{ content: JSON.stringify(content) }]];
    },
  } as never);
  assert.deepEqual(await provider.getMasterPlan("athlete", "2026-08-14"), {
    id: 1,
    start_date: "2026-08-01",
    end_date: "2026-08-31",
  });
  assert.deepEqual(await provider.getWeeklyPlan("athlete", "2026-07-20_07-26"), { id: 2 });
  const [masterCall, weeklyCall] = calls;
  assert.ok(masterCall);
  assert.ok(weeklyCall);
  assert.match(masterCall.sql, /user_id = \?[\s\S]*content_version = 2[\s\S]*status IN \('active', 'archived'\)/);
  assert.deepEqual(masterCall.values, ["athlete"]);
  assert.deepEqual(weeklyCall.values, ["athlete", "2026-07-20"]);
});

test("running calibration omits zone confidence and speed details", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const provider = new MySqlDataProvider({
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("running_calibration_snapshot")) {
        return [
          [
            {
              id: 42,
              as_of_date: "2026-08-08",
              threshold_hr: 168,
              threshold_speed_mps: 3.9,
              threshold_hr_confidence: "high",
              threshold_speed_confidence: "medium",
            },
          ],
        ];
      }
      if (sql.includes("pace_zone"))
        return [
          [
            {
              name: "threshold",
              min_pace_s_per_km: 270,
              max_pace_s_per_km: 250,
            },
          ],
        ];
      return [[{ name: "threshold", min_bpm: 160, max_bpm: 170 }]];
    },
  } as never);
  assert.deepEqual((await provider.getLatestRunningCalibration("athlete", "2026-08-14"))?.paceZones, [
    { name: "threshold", minPaceSPerKm: 270, maxPaceSPerKm: 250 },
  ]);
  for (const sql of calls.slice(1).map((call) => call.sql)) {
    assert.doesNotMatch(sql, /confidence|min_speed_mps|max_speed_mps/);
  }
});

test("activity reads do not expose vendor-derived metrics to Coach", async () => {
  let sql = "";
  const provider = new MySqlDataProvider({
    async query(query: string) {
      if (query.includes("FROM laps")) {
        return [[], []];
      }
      sql = query;
      return [
        [
          {
            user_id: "athlete",
            label_id: "run-1",
            date: new Date("2026-08-01T00:00:00Z"),
            provider: "coros",
            training_load: 999,
            vo2max: 60,
            aerobic_effect: 4,
            anaerobic_effect: 3,
            train_kind: "threshold",
            stride_session_class: "tempo",
          },
        ],
      ];
    },
  } as never);
  const [activity] = await provider.getActivitiesByDateRange("athlete", "2026-08-01", "2026-08-01");
  assert.equal(activity?.strideSessionClass, "tempo");
  assert.deepEqual(activity?.laps, []);
  assert.match(sql, /t.training_dose AS stride_dose/);
  assert.match(sql, /t.session_class AS stride_session_class/);
  for (const key of ["trainingLoad", "vo2max", "aerobicEffect", "anaerobicEffect", "trainKind"]) {
    assert.equal(Object.hasOwn(activity ?? {}, key), false);
  }
});

test("activity reads attach laps grouped by label_id", async () => {
  const calls: Array<{ sql: string }> = [];
  const provider = new MySqlDataProvider({
    async query(query: string) {
      calls.push({ sql: query });
      if (query.includes("FROM laps")) {
        return [
          [
            {
              label_id: "run-1",
              lap_index: 1,
              lap_type: "autoKm",
              distance_m: 1000,
              duration_s: 300,
              avg_pace: 300,
              avg_hr: 160,
            },
            {
              label_id: "run-1",
              lap_index: 2,
              lap_type: "autoKm",
              distance_m: 1000,
              duration_s: 320,
              avg_pace: 320,
              avg_hr: 162,
            },
          ],
          [],
        ];
      }
      return [[{ user_id: "athlete", label_id: "run-1", date: new Date("2026-08-01T00:00:00Z"), provider: "coros" }], []];
    },
  } as never);
  const [activity] = await provider.getActivitiesByDateRange("athlete", "2026-08-01", "2026-08-01");
  assert.equal(activity?.laps?.length, 2);
  assert.equal(activity?.laps?.[1]?.lapIndex, 2);
  assert.match(calls[1]?.sql ?? "", /FROM laps[\s\S]*label_id IN \(\?\)/);
});

test("date-range reads reject a reversed start>end interval before querying", async () => {
  let queried = false;
  const provider = new MySqlDataProvider({
    async query() {
      queried = true;
      return [[], []];
    },
  } as never);
  await assert.rejects(
    provider.getDailyRecoveryByDateRange("athlete", "2026-08-10", "2026-08-01"),
    /startDay \(2026-08-10\) must not be after endDay \(2026-08-01\)/,
  );
  assert.equal(queried, false, "should reject without hitting the database");
});

test("activity detail reads a single activity with its laps, scoped by user and label", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const provider = new MySqlDataProvider({
    async query(query: string, values: unknown[]) {
      calls.push({ sql: query, values });
      if (query.includes("FROM laps")) {
        return [[{ label_id: "run-1", lap_index: 1, lap_type: "autoKm", distance_m: 1000, duration_s: 300, avg_pace: 300, avg_hr: 160 }], []];
      }
      return [[{ user_id: "athlete", label_id: "run-1", date: new Date("2026-08-01T00:00:00Z"), provider: "coros" }], []];
    },
  } as never);

  const activity = await provider.getActivityDetail("athlete", "run-1");
  assert.equal(activity?.labelId, "run-1");
  assert.equal(activity?.laps?.length, 1);
  assert.equal(activity?.laps?.[0]?.lapIndex, 1);
  assert.match(calls[0]?.sql ?? "", /WHERE a\.user_id = \? AND a\.label_id = \?/);
  assert.deepEqual(calls[0]?.values, ["athlete", "run-1"]);
  assert.deepEqual(calls[1]?.values, ["athlete", "run-1"]);
});

test("activity detail returns null for an unknown label within the user's scope", async () => {
  const provider = new MySqlDataProvider({
    async query() {
      return [[], []];
    },
  } as never);
  assert.equal(await provider.getActivityDetail("athlete", "missing"), null);
});

test("activity summaries never touch the laps table", async () => {
  const calls: string[] = [];
  const provider = new MySqlDataProvider({
    async query(query: string) {
      calls.push(query);
      return [[{ user_id: "athlete", label_id: "run-1", date: new Date("2026-08-01T00:00:00Z"), provider: "coros" }], []];
    },
  } as never);

  const [activity] = await provider.getActivitySummariesByDateRange("athlete", "2026-08-01", "2026-08-01");
  assert.equal(activity?.labelId, "run-1");
  assert.deepEqual(activity?.laps, []);
  assert.equal(calls.length, 1, "summaries should make exactly one query");
  assert.match(calls[0] ?? "", / FROM activities /);
  assert.doesNotMatch(calls[0] ?? "", / FROM laps /);
});
