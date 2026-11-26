function run(input) {
  const goals = input.scenario.request.goals;
  const expected = Array.isArray(goals) && (goals.find(goal => goal.priority === "A") || goals[0]);
  if (!expected || !expected.distance || !expected.race_date || !expected.target_time) return {status: "error", error: {code: "rule_input_missing", message: "冻结请求缺少主比赛的距离、日期或目标成绩。"}};
  const plan = input.artifact.plan;
  const violations = [];
  const time = value => {
    const parts = typeof value === "string" && /^\d{1,2}:[0-5]\d:[0-5]\d$/.test(value) ? value.split(":").map(Number) : null;
    return parts ? parts.reduce((sum, part) => sum * 60 + part, 0) : NaN;
  };
  for (const field of ["distance", "race_date", "target_time"]) {
    const actual = plan.goal[field];
    const matches = field === "target_time" ? time(actual) === time(expected[field]) : actual === expected[field];
    if (!matches) violations.push({field: "goal." + field, date: expected.race_date, expected: expected[field], actual});
  }
  if (plan.start_date > expected.race_date || plan.end_date < expected.race_date || !plan.weeks.some(week => week.week_start <= expected.race_date && expected.race_date < new Date(Date.parse(week.week_start + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10))) {
    violations.push({field: "plan.weeks", date: expected.race_date, expected: "赛季覆盖比赛周", actual: {start_date: plan.start_date, end_date: plan.end_date}});
  }
  return violations.length ? {status: "fail", reason: "主比赛目标或比赛周覆盖与冻结请求不一致。", violations} : {status: "pass", reason: "主比赛目标一致且赛季覆盖比赛周。"};
}
