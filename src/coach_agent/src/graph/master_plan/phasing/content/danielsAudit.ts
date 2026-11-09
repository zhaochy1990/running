/**
 * 丹尼尔斯符合性审计（2026-11-02 用户拍板）：生成后逐周逐课与原书口径比对，
 * 产出人读报告。判定分三档：pass=符合原书；warn=合法但偏离原书首选形态（C 门
 * 不拦的取舍）；fail=硬校验挂（引用 C/P 门结果）。独立判定的项不重复实现门
 * 逻辑，只按原书口径重述+引用。
 */
import type { DanielsAuditItem as AuditItem } from "@stride/contract";
import type { ContentGeneratorInput } from "./doctrine.js";
import type { ScheduledOutcome } from "./generate.js";

const pace = (s: number | null | undefined) => (s == null ? "?" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const wdOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export function danielsAudit(outcome: ScheduledOutcome, input: ContentGeneratorInput): AuditItem[] {
  const items: AuditItem[] = [];
  const rows = input.rows;
  const raceRow = rows.at(-1)!;
  const raceDate = raceRow.role === "race" ? input.race.date : null;
  const raceWd = raceDate != null ? wdOf(raceDate) : null;
  const goal = input.race.goalPaceSKm;

  // 硬门引用（fail 汇总）
  const failedIds = [
    ...outcome.checks.flatMap((wc) => wc.filter((c) => !c.pass).map((c) => c.id)),
    ...outcome.scheduleChecks.flatMap((wc) => wc.filter((c) => !c.pass).map((c) => c.id)),
  ];
  if (failedIds.length > 0) items.push({ item: "硬校验门", verdict: "fail", expectation: "C1-C17/P1-P7 全绿（丹系构造约束）", actual: `挂：${failedIds.join(";")}` });

  const flat = outcome.weeks.flatMap(({ week, sessions }) => sessions.map((w) => ({ week, w })));
  const wkOf = (n: number) => outcome.weeks.find((x) => x.week === n)?.sessions ?? [];
  const mKm = (w: (typeof flat)[number]["w"]) => w.blocks.reduce((t, b) => t + b.repeat * b.steps.reduce((u, st) => u + (st.duration.kind === "distance_m" ? (st.duration.value ?? 0) : 0), 0), 0) / 1000;

  // 1. 周量弧：taper 递减 + 赛周日常量
  const taperWeeks = rows.filter((r) => r.role === "taper").map((r) => r.week);
  for (let i = 1; i < taperWeeks.length; i++) {
    const down = rows[taperWeeks[i]! - 1]!.totalKm <= rows[taperWeeks[i - 1]! - 1]!.totalKm + 0.5;
    items.push({ item: `W${taperWeeks[i]} 周量弧`, verdict: down ? "pass" : "warn", expectation: "taper 段逐周递减（原书最后 1-3 周减量）", actual: `W${taperWeeks[i - 1]} ${rows[taperWeeks[i - 1]! - 1]!.totalKm}km → W${taperWeeks[i]} ${rows[taperWeeks[i]! - 1]!.totalKm}km` });
  }
  if (raceRow.role === "race") {
    const peak = Math.max(...rows.filter((r) => r.role === "progress").map((r) => r.totalKm));
    const daily = raceRow.totalKm - 42.195;
    const share = daily / peak;
    items.push({ item: "赛周日常量", verdict: share >= 0.15 && share <= 0.32 ? "pass" : "warn", expectation: "赛周日常量（不含比赛）≈峰值 0.17-0.25×（原书 71-85mph 档 40mi 总/14mi 日常实证）", actual: `${daily.toFixed(1)}km = 峰值 ${peak}km 的 ${(share * 100).toFixed(0)}%` });
  }

  // 2. Q 配额
  for (const row of rows) {
    const qs = wkOf(row.week).filter((w) => w.type !== "LR" && w.type !== "E" && w.name !== input.race.name && !(raceDate != null && w.date === raceDate));
    // recovery 周 q=0 是 L3 设计（纯 E+strides）——不审 Q 配额也不审频率下限
    if (row.phase === "recovery") continue;
    if (row.role === "progress") items.push({ item: `W${row.week} Q 配额`, verdict: qs.length >= 2 ? "pass" : "warn", expectation: "2Q 体系：progress 周 2 节质量课（+可选轻量 M 段位）", actual: `${qs.length} 节：${qs.map((q) => q.name.slice(0, 12)).join("/")}` });
    if (row.role === "taper") items.push({ item: `W${row.week} Q 配额`, verdict: qs.length === 2 ? "pass" : "warn", expectation: "taper 仍 2Q 足量（原书 W17 两节 T 合计可观阈值里程）", actual: `${qs.length} 节` });
  }

  // 3. 段长谱（引用 C16）
  const c16 = outcome.checks.flatMap((wc) => wc.filter((c) => c.id.startsWith("C16")).map((c) => c.detail)).filter((d) => d !== "全过" && !d.includes("跳过") && !d.includes("豁免"));
  items.push({ item: "段长谱", verdict: c16.length === 0 ? "pass" : "fail", expectation: "T 巡航 ≥2km、M 段 ≥3km 连续优先、I 仅前段 ≥1km（原书 Phase 4）", actual: c16.length === 0 ? "全过" : c16.join(";") });

  // 4. taper LR 形态（warn 级：纯有氧合法但原书首选嵌 T 段）
  for (const row of rows.filter((r) => r.role === "taper")) {
    const lr = wkOf(row.week).find((w) => w.type === "LR");
    if (lr == null) continue;
    const fastKm = lr.blocks.flatMap((b) => Array.from({ length: b.repeat }, () => b.steps)).flat().filter((st) => st.target.kind === "pace_s_km" && (st.target.low + st.target.high) / 2 < goal && st.duration.kind === "distance_m").reduce((t, st) => t + (st.duration.value ?? 0) / 1000, 0);
    items.push({ item: `W${row.week} 长跑形态`, verdict: fastKm >= 7 ? "pass" : "warn", expectation: "原书 W17「9E+6T」：20-25km 嵌 8-12km@T（纯有氧合法但非原书首选）", actual: fastKm > 0.1 ? `嵌 ${fastKm.toFixed(1)}km 快于 goal 的段` : "纯有氧/慢渐加速" });
  }

  // 5. 赛周形态：周二位 T 触感 + shakeout + 通勤日空
  if (raceWd != null && raceDate != null) {
    const act = wkOf(raceRow.week).filter((w) => w.date !== raceDate && w.type !== "E");
    const actWd = act.length > 0 ? wdOf(act[0]!.date) : null;
    items.push({ item: "赛周激活课", verdict: act.length === 1 && act[0]!.type === "T" && actWd != null && actWd >= 1 && actWd <= raceWd - 2 ? "pass" : "warn", expectation: "原书赛周唯一 Q=周二位 2×1-2km@T+strides", actual: act.length === 1 ? `${act[0]!.type} ${act[0]!.name.slice(0, 16)}@周${"一二三四五六"[actWd ?? 0]}` : `${act.length} 节非 E 课` });
    const shake = flat.some(({ w }) => w.type === "E" && w.date !== raceDate && raceWd - wdOf(w.date) >= 1 && raceWd - wdOf(w.date) <= 2);
    items.push({ item: "赛前 shakeout", verdict: shake ? "pass" : "warn", expectation: "通勤前一天 25-30min shakeout（赛前一天保持状态）", actual: shake ? "在场" : "缺" });
    const travelWd = input.race.travelDay === "friday" ? 4 : 5;
    const travelEmpty = wkOf(raceRow.week).every((w) => wdOf(w.date) !== travelWd);
    items.push({ item: "通勤日休息", verdict: travelEmpty ? "pass" : "warn", expectation: `周${"一二三四五六"[travelWd]}通勤日无课（默认周六通勤）`, actual: travelEmpty ? "空" : "有课" });
  }

  // 6. 大彩排：全程/大块 MP 长跑在赛前 2-3 周、不在 taper
  const rehearsal = flat.filter(({ w }) => w.type === "LR" && w.blocks.some((b) => b.steps.some((st) => st.target.kind === "pace_s_km" && Math.abs((st.target.low + st.target.high) / 2 - goal) <= 8 && st.duration.kind === "distance_m" && (st.duration.value ?? 0) >= 18000)));
  if (rehearsal.length > 0) {
    const r0 = rehearsal[0]!;
    const daysToRace = raceDate != null ? (new Date(`${raceDate}T00:00:00Z`).getTime() - new Date(`${r0.w.date}T00:00:00Z`).getTime()) / 86400000 : null;
    const okPos = daysToRace != null && daysToRace >= 13 && daysToRace <= 24;
    items.push({ item: "大 MP 彩排位置", verdict: okPos ? "pass" : "warn", expectation: "原书 W16：赛前 3 周 16mi@MP 大彩排（唯一一次）", actual: `W${r0.week} ${mKm(r0.w).toFixed(1)}km@${pace(goal)}/km，距赛 ${daysToRace ?? "?"} 天` });
  } else {
    // 首块门控（2026-11-09）：赛周不在本次生成窗口（长跑道只生成首块）——彩排属
    // final_quality 块，到界滚动生成时再审计；短跑道未检出才是真缺失。
    const deferred = raceDate == null && input.race?.date != null;
    items.push({
      item: "大 MP 彩排位置",
      verdict: deferred ? "pass" : "warn",
      expectation: "赛前 3 周应有 ≥18km@goal 的大彩排长跑",
      actual: deferred ? "赛周未在本次生成窗口（首块门控，块界滚动生成时审计）" : "未检出",
    });
  }

  // 7. 频率：非赛周最长连休 ≤2 天
  for (const row of rows.filter((r) => r.role !== "race" && r.phase !== "recovery")) {
    const days = new Set(wkOf(row.week).map((w) => wdOf(w.date)));
    let maxRun = 0;
    let cur = 0;
    for (let d = 0; d < 7; d++) {
      cur = days.has(d) ? 0 : cur + 1;
      maxRun = Math.max(maxRun, cur);
    }
    items.push({ item: `W${row.week} 训练频率`, verdict: maxRun <= 2 ? "pass" : "warn", expectation: "减量=保持频率砍单课体积（原书赛前每天 20-30min）", actual: `最长连休 ${maxRun} 天` });
  }

  return items;
}

export function auditToMarkdown(items: AuditItem[], title: string): string {
  const n = (v: AuditItem["verdict"]) => ({ pass: "✅", warn: "⚠️", fail: "❌" })[v];
  const lines = [`# ${title}`, "", "| 维度 | 原书口径 | 实际 | 判定 |", "|---|---|---|---|"];
  for (const it of items) lines.push(`| ${it.item} | ${it.expectation} | ${it.actual} | ${n(it.verdict)} |`);
  const counts = { pass: items.filter((i) => i.verdict === "pass").length, warn: items.filter((i) => i.verdict === "warn").length, fail: items.filter((i) => i.verdict === "fail").length };
  lines.push("", `**✅ ${counts.pass} 符合 ｜ ⚠️ ${counts.warn} 偏离首选形态 ｜ ❌ ${counts.fail} 硬校验挂**`);
  return lines.join("\n");
}
