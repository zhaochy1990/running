/**
 * 丹尼尔斯符合性审计（2026-11-02 用户拍板）：生成后逐周逐课与原书口径比对，
 * 产出人读报告。判定分三档：pass=符合原书；warn=合法但偏离原书首选形态（C 门
 * 不拦的取舍）；fail=硬校验挂（引用 C/P 门结果）。独立判定的项不重复实现门
 * 逻辑，只按原书口径重述+引用。
 */
import { type DanielsAuditItem as AuditItem, addDays } from "@stride/contract";
import { hasQualitySegment } from "./derive.js";
import type { ContentGeneratorInput } from "./doctrine.js";
import type { ScheduledOutcome } from "./generate.js";
import { formatDistributionMetrics } from "./schedule/distribution.js";
import { courseMinutes } from "./schedule/dose.js";

const pace = (s: number | null | undefined) => (s == null ? "?" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const wdOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export function danielsAudit(outcome: ScheduledOutcome, input: ContentGeneratorInput): AuditItem[] {
  const items: AuditItem[] = [];
  const rows = input.rows;
  const raceRow = rows.find((r) => r.role === "race");
  const raceDate = raceRow != null ? input.race.date : null;
  const raceWd = raceDate != null ? wdOf(raceDate) : null;
  const goal = input.race.goalPaceSKm;

  // 硬门引用（fail 汇总）
  const failedIds = [
    ...outcome.checks.flatMap((wc) => wc.filter((c) => !c.pass).map((c) => c.id)),
    ...outcome.scheduleChecks.flatMap((wc) => wc.filter((c) => !c.pass).map((c) => c.id)),
  ];
  if (failedIds.length > 0)
    items.push({ item: "硬校验门", verdict: "fail", expectation: "C1-C17/P1-P8 全绿（丹系构造约束）", actual: `挂：${failedIds.join(";")}` });

  const flat = outcome.weeks.flatMap(({ week, sessions }) => sessions.map((w) => ({ week, w })));
  const wkOf = (n: number) => outcome.weeks.find((x) => x.week === n)?.sessions ?? [];
  const mKm = (w: (typeof flat)[number]["w"]) =>
    w.blocks.reduce((t, b) => t + b.repeat * b.steps.reduce((u, st) => u + (st.duration.kind === "distance_m" ? (st.duration.value ?? 0) : 0), 0), 0) / 1000;

  if (input.race.distance === "HM") {
    items.push({
      item: "半马项目检查",
      verdict: failedIds.length === 0 ? "pass" : "fail",
      expectation: "按半马距离、当周专项配速、长跑上限和周量守恒校验",
      actual: failedIds.length === 0 ? `${input.rows.length}周全部硬校验通过` : failedIds.join("；"),
    });
    return items;
  }

  // 1. 周量弧：taper 递减 + 赛周日常量
  const taperRows = rows.filter((r) => r.role === "taper").sort((a, b) => a.week - b.week);
  for (let i = 1; i < taperRows.length; i++) {
    const previous = taperRows[i - 1]!;
    const current = taperRows[i]!;
    const consecutive = current.week === previous.week + 1;
    const down = current.totalKm <= previous.totalKm + 0.5;
    items.push({
      item: `W${current.week} 周量弧`,
      verdict: consecutive && down ? "pass" : "warn",
      expectation: "taper 段逐周递减（原书最后 1-3 周减量）",
      actual: consecutive
        ? `W${previous.week} ${previous.totalKm}km → W${current.week} ${current.totalKm}km`
        : `W${previous.week} 与 W${current.week} 不连续，本次窗口未覆盖中间减量周，未比较逐周递减`,
    });
  }
  if (raceRow != null) {
    const progressRows = rows.filter((r) => r.role === "progress");
    const daily = raceRow.totalKm - 42.195;
    if (progressRows.length === 0) {
      items.push({
        item: "赛周日常量",
        verdict: "warn",
        expectation: "赛周日常量（不含比赛）≈峰值 0.17-0.25×（原书 71-85mph 档 40mi 总/14mi 日常实证）",
        actual: `${daily.toFixed(1)}km；本次窗口无 progress 周，峰值比例未覆盖`,
      });
    } else {
      const peak = Math.max(...progressRows.map((r) => r.totalKm));
      const share = daily / peak;
      items.push({
        item: "赛周日常量",
        verdict: share >= 0.15 && share <= 0.32 ? "pass" : "warn",
        expectation: "赛周日常量（不含比赛）≈峰值 0.17-0.25×（原书 71-85mph 档 40mi 总/14mi 日常实证）",
        actual: `${daily.toFixed(1)}km = 本批 progress 峰值 ${peak}km 的 ${(share * 100).toFixed(0)}%`,
      });
    }
  }

  // 2. Q 配额
  for (const row of rows) {
    const qs = wkOf(row.week).filter((w) => w.type !== "LR" && w.type !== "E" && w.name !== input.race.name && !(raceDate != null && w.date === raceDate));
    // recovery 周 q=0 是 L3 设计（纯 E+strides）——不审 Q 配额也不审频率下限
    if (row.phase === "recovery") continue;
    // Q 配额按 L3 骨架对账（权威=qualitySessions：foundation km≥60=1、final_quality=2），
    // 不硬编码 2Q——2Q 是专项期形态，基础期 1Q 是设计（第六轮验收 foundation 首块实证）
    if (row.role === "progress")
      items.push({
        item: `W${row.week} Q 配额`,
        verdict: qs.length >= row.qualitySessions ? "pass" : "warn",
        expectation: `L3 配额 ${row.qualitySessions} 节（${row.phase === "final_quality" ? "2Q 专项期" : row.phase === "foundation" ? "基础期 1Q" : "按骨架"}；+可选轻量 M 段位）`,
        actual: `${qs.length} 节：${qs.map((q) => q.name.slice(0, 12)).join("/")}`,
      });
    if (row.role === "taper")
      items.push({
        item: `W${row.week} Q 配额`,
        verdict: qs.length === 2 ? "pass" : "warn",
        expectation: "taper 仍 2Q 足量（原书 W17 两节 T 合计可观阈值里程）",
        actual: `${qs.length} 节`,
      });
  }

  // 3. 段长谱（引用 C16）
  const c16 = outcome.checks
    .flatMap((wc) => wc.filter((c) => c.id.startsWith("C16")).map((c) => c.detail))
    .filter((d) => d !== "全过" && !d.includes("跳过") && !d.includes("豁免"));
  items.push({
    item: "段长谱",
    verdict: c16.length === 0 ? "pass" : "fail",
    expectation: "T 巡航 ≥2km、M 段 ≥3km 连续优先、I 仅前段 ≥1km（原书 Phase 4）",
    actual: c16.length === 0 ? "全过" : c16.join(";"),
  });

  // 4. taper LR 形态（warn 级：纯有氧合法但原书首选嵌 T 段）
  for (const row of rows.filter((r) => r.role === "taper")) {
    const lr = wkOf(row.week).find((w) => w.type === "LR");
    if (lr == null) continue;
    const fastKm = lr.blocks
      .flatMap((b) => Array.from({ length: b.repeat }, () => b.steps))
      .flat()
      .filter((st) => st.target.kind === "pace_s_km" && (st.target.low + st.target.high) / 2 < goal && st.duration.kind === "distance_m")
      .reduce((t, st) => t + (st.duration.value ?? 0) / 1000, 0);
    items.push({
      item: `W${row.week} 长跑形态`,
      verdict: fastKm >= 7 ? "pass" : "warn",
      expectation: "原书 W17「9E+6T」：20-25km 嵌 8-12km@T（纯有氧合法但非原书首选）",
      actual: fastKm > 0.1 ? `嵌 ${fastKm.toFixed(1)}km 快于 goal 的段` : "纯有氧/慢渐加速",
    });
  }

  // 5. 赛周形态：周二位 T 触感 + shakeout + 通勤日空
  if (raceRow != null && raceWd != null && raceDate != null) {
    const act = wkOf(raceRow.week).filter((w) => w.date !== raceDate && w.type !== "E");
    const actWd = act.length > 0 ? wdOf(act[0]!.date) : null;
    items.push({
      item: "赛周激活课",
      verdict: act.length === 1 && act[0]!.type === "M" && actWd != null && actWd >= 1 && actWd <= raceWd - 2 ? "pass" : "warn",
      expectation: "周二位 M 配速触感激活（3-5km@goal+strides，教练基准 2026-11-09 拍板）",
      actual: act.length === 1 ? `${act[0]!.type} ${act[0]!.name.slice(0, 16)}@周${"一二三四五六"[actWd ?? 0]}` : `${act.length} 节非 E 课`,
    });
    // 既有赛周例外的可见性（devops#1043）：激活课落周一且上周日长跑带质量尾段
    // （专项期/减量周形态）——P2 的跨周判定对赛周豁免，这里如实提示
    if (actWd === 0) {
      const sundayLr = flat.find(({ w }) => w.date === addDays(raceDate, -raceWd - 1) && w.type === "LR");
      const sundayZones = rows.find((r) => r.week === raceRow.week - 1)?.zones;
      if (sundayLr != null && sundayZones != null && hasQualitySegment(sundayLr.w, sundayZones))
        items.push({
          item: "赛周激活课接长跑",
          verdict: "warn",
          expectation: "质量课之间留恢复日（赛周激活课是既有例外）",
          actual: `周一激活课紧接上周日长跑 ${sundayLr.w.name.slice(0, 16)}——既有赛周位型，未按跨周背靠背判`,
        });
    }
    const shake = wkOf(raceRow.week).some((w) => w.type === "E" && w.date !== raceDate && raceWd - wdOf(w.date) >= 1 && raceWd - wdOf(w.date) <= 2);
    items.push({
      item: "赛前 shakeout",
      verdict: shake ? "pass" : "warn",
      expectation: "通勤前一天 25-30min shakeout（赛前一天保持状态）",
      actual: shake ? "在场" : "缺",
    });
    const travelWd = input.race.travelDay === "friday" ? 4 : 5;
    const travelEmpty = wkOf(raceRow.week).every((w) => wdOf(w.date) !== travelWd);
    items.push({
      item: "通勤日休息",
      verdict: travelEmpty ? "pass" : "warn",
      expectation: `周${"一二三四五六"[travelWd]}通勤日无课（默认周六通勤）`,
      actual: travelEmpty ? "空" : "有课",
    });
  }

  // 6. 大彩排：全程/大块 MP 长跑在赛前 2-3 周、不在 taper
  const rehearsal = flat.filter(
    ({ w }) =>
      w.type === "LR" &&
      w.blocks.some((b) =>
        b.steps.some(
          (st) =>
            st.target.kind === "pace_s_km" &&
            Math.abs((st.target.low + st.target.high) / 2 - goal) <= 8 &&
            st.duration.kind === "distance_m" &&
            (st.duration.value ?? 0) >= 18000,
        ),
      ),
  );
  if (rehearsal.length > 0) {
    const r0 = rehearsal[0]!;
    const daysToRace = raceDate != null ? (new Date(`${raceDate}T00:00:00Z`).getTime() - new Date(`${r0.w.date}T00:00:00Z`).getTime()) / 86400000 : null;
    const okPos = daysToRace != null && daysToRace >= 13 && daysToRace <= 24;
    items.push({
      item: "大 MP 彩排位置",
      verdict: okPos ? "pass" : "warn",
      expectation: "原书 W16：赛前 3 周 16mi@MP 大彩排（唯一一次）",
      actual: `W${r0.week} ${mKm(r0.w).toFixed(1)}km@${pace(goal)}/km，距赛 ${daysToRace ?? "?"} 天`,
    });
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

  // 7. 日期分布（devops#1043）：审计解释最终选择——同约束可行候选中三项分布指标
  // （最长连跑/最长连休/含关键课三日负荷峰）不被超过；集中若仍在，写明由什么
  // 约束造成。有明确更优解却没选=分布优化与审计不一致（fail）——不以警告放行
  // 扎堆安排。没有留痕的产物（#1043 之前）退回周内最长连休提示。
  const auditsByWeek = new Map(outcome.distribution.map((audit) => [audit.week, audit]));
  for (const row of rows.filter((r) => r.role !== "race")) {
    const audit = auditsByWeek.get(row.week);
    const chosen = audit?.candidates[audit.chosen];
    // 生产上每个常规周都经日期分布选择（scheduleWeeks）——没有留痕=选择没有发生，不放行
    if (audit == null || chosen?.metrics == null) {
      items.push({
        item: `W${row.week} 日期分布`,
        verdict: "fail",
        expectation: "同约束可行候选中三项分布指标不被超过：最长连跑/最长连休/含关键课三日负荷峰；关键课次日留恢复日",
        actual: "无分布留痕——日期分布优化未运行",
      });
      continue;
    }
    // 指标报最终日历的（finalMetrics）；自检读留痕里的支配关系（选择时已算）：选定解
    // 出自非被超过前沿，被超过=选择与审计不一致
    const superseding = chosen.dominatedBy == null ? undefined : audit.candidates[chosen.dominatedBy];
    items.push({
      item: `W${row.week} 日期分布`,
      verdict: superseding == null ? "pass" : "fail",
      expectation: "同约束可行候选中三项分布指标不被超过：最长连跑/最长连休/含关键课三日负荷峰；关键课次日留恢复日",
      actual:
        superseding?.metrics == null
          ? `选定 ${chosen.label}：${formatDistributionMetrics(audit.finalMetrics)}；可行候选 ${audit.candidates.filter((candidate) => candidate.feasible).length}/${audit.candidates.length}；${audit.reason}；${audit.constraints.join("，")}`
          : `选定 ${chosen.label}（${formatDistributionMetrics(chosen.metrics)}）被候选 ${superseding.label}（${formatDistributionMetrics(superseding.metrics)}）超过——分布优化与审计不一致`,
    });
  }

  // 8. 单课时长上限（devops#1043）：E 课由排位钳到用户许可值；长跑/质量课时长
  // 由课包决定、排位不裁剪——超限如实告警（解在 L3 压长跑量或 L4a 改课）
  const capMin = input.availability?.maxSessionDurationMin;
  if (capMin != null) {
    for (const row of rows) {
      const over = wkOf(row.week).flatMap((workout) => {
        // 比赛课是目标事件不是训练课，不计
        if (workout.type === "E" || (row.role === "race" && workout.date === input.race.date)) return [];
        const minutes = courseMinutes(workout);
        return minutes != null && minutes > capMin ? [`${workout.name}≈${Math.round(minutes)}min`] : [];
      });
      if (over.length > 0)
        items.push({
          item: `W${row.week} 单课时长上限`,
          verdict: "warn",
          expectation: `单课 ≤${capMin} 分钟（用户可用性）`,
          actual: `${over.join("、")} 超限（结构课时长由课包决定，排位不裁剪）`,
        });
    }
  }

  return items;
}

export function auditToMarkdown(items: AuditItem[], title: string): string {
  const n = (v: AuditItem["verdict"]) => ({ pass: "✅", warn: "⚠️", fail: "❌" })[v];
  const lines = [`# ${title}`, "", "| 维度 | 原书口径 | 实际 | 判定 |", "|---|---|---|---|"];
  for (const it of items) lines.push(`| ${it.item} | ${it.expectation} | ${it.actual} | ${n(it.verdict)} |`);
  const counts = {
    pass: items.filter((i) => i.verdict === "pass").length,
    warn: items.filter((i) => i.verdict === "warn").length,
    fail: items.filter((i) => i.verdict === "fail").length,
  };
  lines.push("", `**✅ ${counts.pass} 符合 ｜ ⚠️ ${counts.warn} 偏离首选形态 ｜ ❌ ${counts.fail} 硬校验挂**`);
  return lines.join("\n");
}
