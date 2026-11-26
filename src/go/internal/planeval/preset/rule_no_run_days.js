function run(input) {
  const days = input.snapshot.constraints && input.snapshot.constraints.no_run_days;
  if (!Array.isArray(days)) return {status: "error", error: {code: "rule_input_missing", message: "快照缺少禁训日；无禁训日须明确给出 []。"}};
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const violations = input.artifact.weekly_docs.flatMap(week =>
    week.sessions.filter(session => session.kind === "run" && days.includes(weekdays[new Date(session.date + "T00:00:00Z").getUTCDay()]))
      .map(session => ({week_name: week.week_name, date: session.date, expected: "禁训日不跑步", actual: "run"})));
  return violations.length ? {status: "fail", reason: "禁训日安排了跑步课程。", violations} : {status: "pass", reason: "禁训日未安排跑步。"};
}
