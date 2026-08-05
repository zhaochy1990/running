import assert from "node:assert/strict";
import test from "node:test";

import { parseWeeklyPlanSourceConfig } from "../src/weekly-plan-azure.js";

test("parseWeeklyPlanSourceConfig reuses server env names and defaults", () => {
  assert.deepEqual(
    parseWeeklyPlanSourceConfig({
      STRIDE_WEEKLY_PLAN_TABLE_ACCOUNT_URL: "https://table.example/",
      STRIDE_CONTENT_BLOB_ACCOUNT_URL: "https://blob.example/",
    }),
    {
      tableAccountUrl: "https://table.example/",
      tableName: "strideweeklyplan",
      blobAccountUrl: "https://blob.example/",
      container: "stride-data",
      prefix: "users",
    },
  );
});

test("parseWeeklyPlanSourceConfig accepts table and Blob path overrides", () => {
  const config = parseWeeklyPlanSourceConfig({
    STRIDE_WEEKLY_PLAN_TABLE_NAME: "customweekly",
    STRIDE_CONTENT_BLOB_CONTAINER: "custom-container",
    STRIDE_CONTENT_BLOB_PREFIX: "/archive/users/",
  });
  assert.equal(config.tableName, "customweekly");
  assert.equal(config.container, "custom-container");
  assert.equal(config.prefix, "archive/users");
});
