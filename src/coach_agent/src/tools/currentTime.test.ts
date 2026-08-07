import assert from "node:assert/strict";
import test from "node:test";
import { createCurrentTimeTools } from "./currentTime.js";

test("get_current_time returns Shanghai calendar weeks", async () => {
  const [tool] = createCurrentTimeTools(new Date("2026-08-07T16:30:00Z"));

  assert.equal(tool!.name, "get_current_time");
  assert.deepEqual(await tool!.invoke({}), {
    timezone: "Asia/Shanghai",
    today: "2026-08-08",
    current_week: "2026-08-03_08-09",
    next_week: "2026-08-10_08-16",
  });
});
