/**
 * 日期分布优化·本地回放对照（devops#1043 验收）：票面「三周、每周四跑」样例走
 * 真实排位入口，输出逐日日历、连跑/连休、含关键课三日负荷与硬约束结果的对照
 * ——原排法（整批贪心）vs 选定，外加逐周全部候选明细与两个完整跨周窗口。
 *
 * 零 LLM、确定性；本地验收用：
 *   npm run replay:distribution
 * 报告写入 test-output/distribution-replay/report.md，原排法未被淘汰时以非零退出。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatDistributionMetrics, scheduleLabel } from "../graph/master_plan/phasing/content/schedule/distribution.js";
import { type CalendarDay, scheduleWeeks, type WeekDistributionAudit, type WeekSchedule } from "../graph/master_plan/phasing/content/schedule/scheduler.js";
import { completeMetricsOf, fourRunBag, greedyBatch, normalRow, scheduleCtxOf } from "../graph/master_plan/phasing/content/schedule/testSupport.js";

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
const keptOriginal = result.distribution.filter((audit) => audit.chosen === 0).map((audit) => `W${audit.week}`);
if (keptOriginal.length > 0) {
  console.error(`原排法未被淘汰：${keptOriginal.join(", ")}`);
  process.exitCode = 1;
}

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

const report = [
  "# 日期分布优化回放对照（devops#1043）",
  "",
  "样例：三周、每周四跑（长跑 20km + 阈值 6km + 普通 E + 间隔 E），周量 55km；仅天数上限（具体可跑日未知）；PMC 种子 ATL 33 / CTL 38；零 LLM。",
  "",
  "## 逐周对照：原排法（整批贪心）vs 选定（完整跨周窗口的指标）",
  "",
  `| 周 | 原排法 | 选定 | 连跑（原→选定） | 连休（原→选定） | 含关键课三日负荷峰（原→选定） | 硬约束 |`,
  "|---|---|---|---|---|---|---|",
  ...result.distribution.map((audit) => {
    const before = completeMetricsOf(original, audit.week - 1);
    const after = completeMetricsOf(result.weeks, audit.week - 1);
    const failed = result.weeks[audit.week - 1]!.checks.filter((check) => !check.pass).map((check) => check.id);
    return `| W${audit.week} | ${scheduleLabel(original[audit.week - 1]!)} | ${scheduleLabel(result.weeks[audit.week - 1]!)} | ${before.longestRun.days}→${after.longestRun.days} | ${before.longestRest.days}→${after.longestRest.days} | ${before.maxKey3DayLoad}→${after.maxKey3DayLoad} | ${failed.length === 0 ? "全过" : failed.join(",")} |`;
  }),
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
