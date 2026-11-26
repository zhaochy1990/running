function run(input) {
  const start = input.artifact.plan.start_date;
  const planWeeks = input.artifact.plan.weeks;
  const violations = input.artifact.weekly_docs.flatMap((week, i) => {
    const expectedIndex = i + 1;
    const expectedDate = new Date(Date.parse(start + "T00:00:00Z") + i * 7 * 86400000).toISOString().slice(0, 10);
    const actualDate = week.week_name.slice(0, 10);
    return week.week_index === expectedIndex && actualDate === expectedDate && planWeeks.some(row => row.week_index === expectedIndex && row.week_start === expectedDate)
      ? [] : [{week_name: week.week_name, expected: {week_index: expectedIndex, week_start: expectedDate}, actual: {week_index: week.week_index === undefined ? null : week.week_index, week_start: actualDate}}];
  });
  return violations.length ? {status: "fail", reason: "首批周课须从第 1 周起，周号与赛季日历连续对应。", violations} : {status: "pass", reason: "首批周课从第 1 周起连续且日期一致。"};
}
