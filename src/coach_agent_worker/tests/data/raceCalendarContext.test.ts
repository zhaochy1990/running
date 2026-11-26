import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { MySqlDataProvider } from "../../src/data/mysqlDataProvider.js";

test("race calendar context reads item reputation and tolerates missing or invalid values", async (t) => {
  const pool = mysql.createPool({});
  t.after(() => pool.end());
  const reputation = {
    summary: "后半程的五次桥坡打断配速节奏。",
    pros: ["前半程平缓"],
    cons: ["折返后连续过桥"],
  };
  t.mock.method(pool, "query", async (sql: string, values: unknown[]) => {
    assert.deepEqual(values, [632]);
    if (sql.includes("FROM race_calendar_item")) {
      assert.match(sql, /\breputation\b/);
      return [
        [
          { name: "全程", type: "Marathon", reputation },
          { name: "半程", type: "HalfMarathon", reputation: JSON.stringify({ summary: "平缓", pros: null, cons: null }) },
          { name: "10 公里", type: "10Km", reputation: null },
          { name: "5 公里", type: "5Km", reputation: "[]" },
        ],
      ];
    }
    assert.match(sql, /published = 1/);
    return [[{ name: "上海马拉松", race_date: "2026-12-06" }]];
  });

  const context = await new MySqlDataProvider(pool).getRaceCalendarContext(632);
  assert.deepEqual(
    context?.items.map((item) => item.reputation),
    [reputation, { summary: "平缓", pros: [], cons: [] }, null, null],
  );
});
