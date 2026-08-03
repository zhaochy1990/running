import assert from "node:assert/strict";
import test from "node:test";

import {
  isoToMysqlDatetime6,
  maskDob,
  onboardingRowFromJson,
  ProfileTransformError,
  profileRowFromJson,
  redactProfileRow,
} from "../src/profile-transform.js";

const UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";

test("profileRowFromJson maps the five core fields from a full profile", () => {
  const row = profileRowFromJson(UUID, {
    display_name: "gaohan",
    dob: "2003-09-25",
    sex: "male",
    height_cm: 170.0,
    weight_kg: 58.0,
    // ignored extras:
    target_race: null,
    weekly_mileage_km: null,
  });
  assert.deepEqual(row, {
    user_id: UUID,
    display_name: "gaohan",
    dob: "2003-09-25",
    sex: "male",
    height_cm: 170.0,
    weight_kg: 58.0,
  });
});

test("profileRowFromJson collapses missing fields to Go zero values", () => {
  // A display_name-only legacy profile (e.g. dehua).
  const row = profileRowFromJson(UUID, { display_name: "dehua" });
  assert.equal(row.display_name, "dehua");
  assert.equal(row.dob, "");
  assert.equal(row.sex, "");
  assert.equal(row.height_cm, 0);
  assert.equal(row.weight_kg, 0);
});

test("profileRowFromJson ignores legacy CJK keys and a missing sex", () => {
  // zhaochaoyi's profile: rich, with CJK keys and NO sex.
  const row = profileRowFromJson(UUID, {
    display_name: "Chaoyi",
    dob: "1990-07-22",
    height_cm: 182.0,
    weight_kg: 70.5,
    手表: "COROS PACE 4",
    目标配速_km: { 轻松跑: "5:20-5:40" },
    target_race: "2026-10 马拉松",
    target_distance: "FM",
  });
  assert.equal(row.display_name, "Chaoyi");
  assert.equal(row.dob, "1990-07-22");
  assert.equal(row.sex, ""); // absent → Go zero value
  assert.equal(row.height_cm, 182.0);
  assert.equal(row.weight_kg, 70.5);
  assert.equal("target_race" in row, false);
  assert.equal("手表" in row, false);
});

test("profileRowFromJson parses numeric strings and accepts a JSON string arg", () => {
  const row = profileRowFromJson(UUID, '{"height_cm":"180","weight_kg":"72.3"}');
  assert.equal(row.height_cm, 180);
  assert.equal(row.weight_kg, 72.3);
});

test("profileRowFromJson rejects non-object JSON", () => {
  assert.throws(() => profileRowFromJson(UUID, "[]"), ProfileTransformError);
  assert.throws(() => profileRowFromJson(UUID, "not json"), ProfileTransformError);
});

test("onboardingRowFromJson maps coros_ready → watch_ready and parses completed_at", () => {
  const row = onboardingRowFromJson(UUID, {
    coros_ready: true,
    profile_ready: true,
    completed_at: "2026-04-27T09:02:55.015190+00:00",
    sync_state: "done",
  });
  assert.equal(row.user_id, UUID);
  assert.equal(row.watch_ready, true);
  assert.equal(row.profile_ready, true);
  assert.equal(row.completed_at, "2026-04-27 09:02:55.015190");
});

test("onboardingRowFromJson handles a Z offset and a missing completed_at", () => {
  const zulu = onboardingRowFromJson(UUID, {
    coros_ready: true,
    profile_ready: false,
    completed_at: "2026-04-27T08:38:00.379975Z",
  });
  assert.equal(zulu.completed_at, "2026-04-27 08:38:00.379975");
  assert.equal(zulu.profile_ready, false);

  const none = onboardingRowFromJson(UUID, { coros_ready: false, profile_ready: false });
  assert.equal(none.watch_ready, false);
  assert.equal(none.completed_at, null);
});

test("onboardingRowFromJson accepts an already-renamed watch_ready", () => {
  const row = onboardingRowFromJson(UUID, { watch_ready: true, profile_ready: true });
  assert.equal(row.watch_ready, true);
});

test("isoToMysqlDatetime6 preserves microseconds and shifts non-UTC offsets", () => {
  // +08:00 → subtract 8h to reach UTC; micros are offset-invariant.
  assert.equal(
    isoToMysqlDatetime6("2026-07-09T18:46:16.804290+08:00"),
    "2026-07-09 10:46:16.804290",
  );
  // Sub-second padding to 6 digits.
  assert.equal(isoToMysqlDatetime6("2026-01-02T03:04:05.5Z"), "2026-01-02 03:04:05.500000");
  // No fractional part → .000000
  assert.equal(isoToMysqlDatetime6("2026-01-02T03:04:05Z"), "2026-01-02 03:04:05.000000");
  // Day rollover across the offset.
  assert.equal(
    isoToMysqlDatetime6("2026-01-01T05:00:00+08:00"),
    "2025-12-31 21:00:00.000000",
  );
});

test("isoToMysqlDatetime6 rejects a non-datetime string", () => {
  assert.throws(() => isoToMysqlDatetime6("nope"), ProfileTransformError);
});

test("redactProfileRow masks dob and hides body metrics; maskDob coarsens to year", () => {
  const red = redactProfileRow({
    user_id: UUID,
    display_name: "Chaoyi",
    dob: "1990-07-22",
    sex: "male",
    height_cm: 182,
    weight_kg: 70.5,
  });
  assert.equal(red.dob, "1990-**-**");
  assert.equal(red.height_cm, "set");
  assert.equal(red.weight_kg, "set");
  assert.equal(red.display_name, "Chaoyi");

  assert.equal(maskDob(""), null);
  assert.equal(maskDob("bad"), "****");
  assert.equal(maskDob("2003-09-25"), "2003-**-**");
});
