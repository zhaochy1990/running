import assert from "node:assert/strict";
import test from "node:test";

import { selectUserIds } from "../src/profiles.js";

const ALLOW = [
  "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9",
  "5ee229a6-cdc1-4260-84d3-71ec622126c2",
  "f10bc353-01ab-4db1-af9f-d9305ea9a532",
];

test("selectUserIds returns the whole allowlist when nothing is requested", () => {
  const { ids, rejected } = selectUserIds(ALLOW);
  assert.deepEqual(ids, ALLOW);
  assert.deepEqual(rejected, []);
});

test("selectUserIds narrows to requested users within the allowlist", () => {
  const { ids, rejected } = selectUserIds(ALLOW, [
    "f10bc353-01ab-4db1-af9f-d9305ea9a532",
  ]);
  assert.deepEqual(ids, ["f10bc353-01ab-4db1-af9f-d9305ea9a532"]);
  assert.deepEqual(rejected, []);
});

test("selectUserIds rejects a requested UUID outside the allowlist (test account)", () => {
  const testAcct = "00000000-0000-4000-8000-000000000000";
  const { ids, rejected } = selectUserIds(ALLOW, [
    testAcct,
    "5ee229a6-cdc1-4260-84d3-71ec622126c2",
  ]);
  assert.deepEqual(ids, ["5ee229a6-cdc1-4260-84d3-71ec622126c2"]);
  assert.deepEqual(rejected, [testAcct]);
});

test("selectUserIds is case-insensitive and de-duplicates", () => {
  const { ids } = selectUserIds(ALLOW, [
    "F10BC353-01AB-4DB1-AF9F-D9305EA9A532",
    "f10bc353-01ab-4db1-af9f-d9305ea9a532",
  ]);
  assert.deepEqual(ids, ["f10bc353-01ab-4db1-af9f-d9305ea9a532"]);
});

test("selectUserIds honors the limit", () => {
  const { ids } = selectUserIds(ALLOW, [], 2);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids, ALLOW.slice(0, 2));
});
