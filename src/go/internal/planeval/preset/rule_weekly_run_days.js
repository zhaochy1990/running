// 每周跑步日上限（devops#1049 首批固定规则）：同一上海日历日多次跑步计为一天，
// 上限取自快照明确给出的 constraints.max_run_days_per_week。
function run(input) {
  const expected = input.snapshot.constraints.max_run_days_per_week;
  if (!Number.isInteger(expected)) {
    return { status: "error", error: { code: "rule_input_missing", message: "快照缺少每周跑步日上限。" } };
  }
  const violations = input.artifact.weekly_docs.flatMap((week) => {
    const actual = new Set(week.sessions.filter((session) => session.kind === "run").map((session) => session.date)).size;
    return actual > expected ? [{ week_name: week.week_name, expected, actual }] : [];
  });
  return violations.length
    ? { status: "fail", reason: "存在超出每周跑步日上限的周。", violations }
    : { status: "pass", reason: "各周均符合每周跑步日上限。" };
}
