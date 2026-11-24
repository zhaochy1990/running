/**
 * 日期分布优化·本地回放对照（devops#1043 验收；devops#1054 补自检）：票面「三周、
 * 每周四跑」样例走真实排位入口，输出逐日日历、连跑/连休、含关键课三日负荷与硬约束
 * 结果的对照——原排法（整批贪心）vs 选定，外加逐周全部候选明细与两个完整跨周窗口。
 *
 * 回放自检（任一条不成立以非零退出，报告写明哪一条）：
 *   - 每周课数保持 4 节（固定课包不丢课）；
 *   - 原排法与选定都过全部硬约束（排位 P 门 + 课程 C 门）；
 *   - 完整跨周窗口里最长连跑 4→2 天、最长连休 3→1 天（首周没有上一周，只报告不判）。
 *
 * 零 LLM、确定性；本地验收用：
 *   npm run replay:distribution
 * 报告写入 test-output/distribution-replay/report.md。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatDistributionMetrics, scheduleLabel } from "../graph/master_plan/phasing/content/schedule/distribution.js";
import { type CalendarDay, scheduleWeeks, type WeekDistributionAudit, type WeekSchedule } from "../graph/master_plan/phasing/content/schedule/scheduler.js";
import { cChecksOf, completeMetricsOf, fourRunBag, greedyBatch, normalRow, scheduleCtxOf } from "../graph/master_plan/phasing/content/schedule/testSupport.js";

const OUT_DIR = resolve(import.meta.dirname, "../../test-output/distribution-replay");
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const dayCn = (date: string): string => `周${WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]}`;
const sessionText = (day: CalendarDay): string => (day.sessions.length === 0 ? "休" : day.sessions.map((session) => session.name).join(" + "));

const rows = [normalRow(1), normalRow(2), normalRow(3)];
const bags = rows.map((row) => fourRunBag(row.week));
const ctx = scheduleCtxOf(rows);
const result = scheduleWeeks(bags, ctx);
if (!result.ok) throw new Error(`排位失败：${result.failures.join(";")}`);
const original = greedyBatch(bags, ctx);

/** 一周的全部硬约束结果（排位 P 门 + 课程 C 门）；空=全过。 */
const hardFailuresOf = (week: WeekSchedule, index: number): string[] => [
  ...week.checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.detail}`),
  ...cChecksOf(rows[index]!, week.sessions)
    .filter((check) => !check.pass)
    .map((check) => `${check.id}: ${check.detail}`),
];

// ── 回放自检（devops#1054）────────────────────────────────────────────────────
const problems: string[] = [];
const keptOriginal = result.distribution.filter((audit) => audit.chosen === 0).map((audit) => `W${audit.week}`);
if (keptOriginal.length > 0) problems.push(`原排法未被淘汰：${keptOriginal.join(", ")}`);
for (const [index, audit] of result.distribution.entries()) {
  const label = `W${audit.week}`;
  if (original[index]!.sessions.length !== 4 || result.weeks[index]!.sessions.length !== 4)
    problems.push(`${label} 课数不是每周 4 节（原 ${original[index]!.sessions.length} / 选定 ${result.weeks[index]!.sessions.length}）`);
  for (const [name, week] of [
    ["原排法", original[index]!],
    ["选定", result.weeks[index]!],
  ] as const) {
    const failed = hardFailuresOf(week, index);
    if (failed.length > 0) problems.push(`${label} ${name}硬约束挂：${failed.join("; ")}`);
  }
  if (index === 0) continue; // 首周没有上一周（边界未知）：跨周连跑只报告不判
  const before = completeMetricsOf(original, index);
  const after = completeMetricsOf(result.weeks, index);
  if (before.longestRun.days !== 4 || before.longestRest.days !== 3)
    problems.push(`${label} 原排法连跑/连休不是 4/3 天（${formatDistributionMetrics(before)}）`);
  if (after.longestRun.days !== 2 || after.longestRest.days !== 1) problems.push(`${label} 选定连跑/连休不是 2/1 天（${formatDistributionMetrics(after)}）`);
}
for (const problem of problems) console.error(`回放自检不过：${problem}`);
if (problems.length > 0) process.exitCode = 1;

/** 跨周窗口（上周六、上周日、本周一、本周二）的逐日文本。 */
const junction = (weeks: WeekSchedule[], week: number): string =>
  [...weeks[week - 2]!.calendar.slice(5), ...weeks[week - 1]!.calendar.slice(0, 2)]
    .map((day) => `${day.date} ${dayCn(day.date)}：${sessionText(day)}`)
    .join(" → ");

const candidateTable = (audit: WeekDistributionAudit): string =>
  "| # | 落位（周一→周日） | 硬约束 | 连跑 | 连休 | 三日峰 | 关键课次日未恢复 | 被谁超过 |\n|---|---|---|---|---|---|---|---|\n" +
  audit.candidates
    .map((candidate, index) => {
      const mark = index === audit.chosen ? "**选定** " : index === 0 ? "**原排法** " : "";
      const gate = candidate.feasible ? "过" : `挂：${candidate.failures.join("; ")}`;
      const metrics = candidate.metrics;
      return metrics == null
        ? `| ${index} | ${mark}${candidate.label} | ${gate} | — | — | — | — | — |`
        : `| ${index} | ${mark}${candidate.label} | ${gate} | ${metrics.longestRun.days} | ${metrics.longestRest.days} | ${metrics.maxKey3DayLoad ?? "—"} | ${metrics.unrecoveredKeyDays} | ${candidate.dominatedBy == null ? "—" : `#${candidate.dominatedBy}`} |`;
    })
    .join("\n");

const doseChange = (before: number | null, after: number | null): string =>
  before == null || after == null ? "不可评" : `${before}→${after}（${after <= before ? "−" : "+"}${Math.round(Math.abs(after - before) * 10) / 10}）`;

const report = [
  "# 日期分布优化回放对照（devops#1043）",
  "",
  "样例：三周、每周四跑（长跑 20km + 阈值 6km + 普通 E + 间隔 E），周量 55km；仅天数上限（具体可跑日未知）；PMC 种子 ATL 33 / CTL 38；零 LLM。",
  "",
  `## 回放自检（devops#1054）`,
  "",
  problems.length === 0
    ? "全部通过：每周课数保持 4 节；原排法与选定都过全部硬约束（排位 P 门 + 课程 C 门）；完整跨周窗口最长连跑 4→2 天、最长连休 3→1 天。"
    : `未通过 ${problems.length} 条：`,
  ...(problems.length === 0 ? [] : problems.map((problem) => `- ${problem}`)),
  "",
  "## 逐周对照：原排法（整批贪心）vs 选定（完整跨周窗口的指标）",
  "",
  `| 周 | 课数（原→选定） | 原排法 | 选定 | 连跑（原→选定） | 连休（原→选定） | 含关键课三日负荷峰（原→选定） | 硬约束 P 门 + C 门（原 / 选定） |`,
  "|---|---|---|---|---|---|---|---|",
  ...result.distribution.map((audit) => {
    const index = audit.week - 1;
    const before = completeMetricsOf(original, index);
    const after = completeMetricsOf(result.weeks, index);
    const gateOf = (week: WeekSchedule) => (hardFailuresOf(week, index).length === 0 ? "全过" : "挂");
    return `| W${audit.week} | ${original[index]!.sessions.length}→${result.weeks[index]!.sessions.length} | ${scheduleLabel(original[index]!)} | ${scheduleLabel(result.weeks[index]!)} | ${before.longestRun.days}→${after.longestRun.days} | ${before.longestRest.days}→${after.longestRest.days} | ${doseChange(before.maxKey3DayLoad, after.maxKey3DayLoad)} | ${gateOf(original[index]!)} / ${gateOf(result.weeks[index]!)} |`;
  }),
  "",
  "首周没有上一周（边界未知），连跑只统计可观测部分；W2、W3 是两个完整跨周窗口。",
  "",
  "## 逐日日历",
  "",
  ...result.weeks.flatMap((week, index) => [
    `### W${week.week}`,
    "",
    "原排法：",
    "",
    ...original[index]!.calendar.map((day) => `- ${day.date} ${dayCn(day.date)}：${sessionText(day)}`),
    "",
    "选定：",
    "",
    ...week.calendar.map((day) => `- ${day.date} ${dayCn(day.date)}：${sessionText(day)}`),
    "",
  ]),
  "## 跨周窗口（上周六 → 本周二）",
  "",
  ...[2, 3].flatMap((week) => [
    `### W${week - 1}→W${week}`,
    "",
    `- 原排法：${junction(original, week)}（最长连跑 ${completeMetricsOf(original, week - 1).longestRun.days} 天）`,
    `- 选定：${junction(result.weeks, week)}（最长连跑 ${completeMetricsOf(result.weeks, week - 1).longestRun.days} 天）`,
    "",
  ]),
  "## 逐周候选明细",
  "",
  `指标列口径：连跑 / 连休 / 三日峰 / 关键课次日未恢复（只统计与本周相交的段——票面「受候选影响的日期」）。`,
  "",
  ...result.distribution.flatMap((audit) => [
    `### W${audit.week}`,
    "",
    `- 可行候选 ${audit.candidates.filter((candidate) => candidate.feasible).length}/${audit.candidates.length}；交界复核${audit.converged ? "已收敛" : "未收敛"}`,
    `- 选择原因：${audit.reason}`,
    `- 选定（最终日历）：${formatDistributionMetrics(audit.finalMetrics)}`,
    `- 约束现状：${audit.constraints.join("；")}`,
    "",
    candidateTable(audit),
    "",
  ]),
].join("\n");

await mkdir(OUT_DIR, { recursive: true });
await writeFile(resolve(OUT_DIR, "report.md"), `${report}\n`);
console.log(report);
console.log(`\n报告已写入 ${resolve(OUT_DIR, "report.md")}`);
