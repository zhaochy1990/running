function run(input) {
  const records = input.snapshot.records;
  const active = records && records.active_master_plan;
  const plan = active && active.content;
  const rows = records && records.weekly_plan_weeks;
  const endDate = plan && (plan.end_date || (Array.isArray(plan.phases) && plan.phases.map(phase => phase && phase.end_date).filter(day => typeof day === "string").sort().pop()));
  if (!plan || !plan.start_date || !endDate || !Number.isInteger(plan.total_weeks) || !Array.isArray(rows) || !Array.isArray(plan.weeks || (plan.skeleton && plan.skeleton.weeks))) {
    return {status: "error", error: {code: "rule_input_missing", message: "滚动检查需要赛季起止日、总周数、计划周及已排周记录。"}};
  }
  const weekOf = day => Math.floor((Date.parse(day + "T00:00:00Z") - Date.parse(plan.start_date + "T00:00:00Z")) / (7 * 86400000)) + 1;
  const day = new Date(Date.parse(input.as_of) + 8 * 3600000).toISOString().slice(0, 10);
  const current = weekOf(day);
  const generated = (plan.weeks || []).filter(week => Number(week.week_index) > 0 && Array.isArray(week.key_sessions) && week.key_sessions.length).map(week => Number(week.week_index));
  // Worker snapshotLastGeneratedWeek: candidate weekly_docs are previews, not applied weeks.
  const snapshotLast = Array.isArray(plan.weekly_docs) ? 0 : generated.length ? Math.max(...generated) : Math.min(6, plan.total_weeks);
  const last = Math.max(snapshotLast, 0, ...rows.map(row => weekOf(row.week_start)).filter(week => week >= 1));
  const expected = Number.isInteger(input.snapshot.expected_start_week) ? input.snapshot.expected_start_week : Math.max(last + 1, current);
  const expectedMode = current > last ? "catch_up" : "boundary";
  const artifact = input.artifact;
  const violations = [];
  if (artifact.master_plan_id !== (plan.master_plan_id || active.planId)) violations.push({field: "master_plan_id", expected: plan.master_plan_id || active.planId, actual: artifact.master_plan_id});
  if (artifact.window.mode !== expectedMode) violations.push({field: "window.mode", expected: expectedMode, actual: artifact.window.mode});
  if (artifact.window.start_week !== expected || artifact.window.end_week > plan.total_weeks) violations.push({field: "window", expected: {start_week: expected, end_week_max: plan.total_weeks}, actual: artifact.window});
  artifact.weekly_docs.forEach((week, i) => {
    const expectedIndex = expected + i;
    const expectedDate = new Date(Date.parse(plan.start_date + "T00:00:00Z") + (expectedIndex - 1) * 7 * 86400000).toISOString().slice(0, 10);
    if (week.week_index !== expectedIndex || week.week_name.slice(0, 10) !== expectedDate) violations.push({week_name: week.week_name, expected: {week_index: expectedIndex, week_start: expectedDate}, actual: {week_index: week.week_index, week_start: week.week_name.slice(0, 10)}});
    week.sessions.filter(session => session.date > endDate).forEach(session => violations.push({date: session.date, expected: "课程不晚于 " + endDate, actual: session.date}));
  });
  return violations.length ? {status: "fail", reason: "滚动起始周、赛季身份或日期窗口不符合冻结输入。", violations} : {status: "pass", reason: "滚动周号、日期与赛季终点一致。"};
}
