function run(input) {
  const reportingCatchUp = input.artifact.window && input.artifact.window.mode === "catch_up";
  if (input.snapshot.generation_kind !== "rolling_catch_up" && !reportingCatchUp) return {status: "pass", reason: "非追赶场景，无需剔除过去课程。"};
  const day = new Date(Date.parse(input.as_of) + 8 * 3600000).toISOString().slice(0, 10);
  const violations = input.artifact.weekly_docs.flatMap(week => week.sessions.filter(session => session.date <= day)
    .map(session => ({week_name: week.week_name, date: session.date, expected: "课程日期晚于 " + day, actual: session.date})));
  return violations.length ? {status: "fail", reason: "追赶排课补排了截止日或已过去的课程（营养项不参与）。", violations} : {status: "pass", reason: "追赶课程均晚于上海截止日。"};
}
