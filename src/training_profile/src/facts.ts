/** Descriptive window summaries only. No new athlete baseline algorithms. */
import { addDays, shanghaiIso } from "@stride/contract";
import { type Conclusion, type Evidence, finite, refs, runningEvidence, type Snapshot } from "./types.js";

const day = (e: Evidence) => String(e.kind === "activity" ? (e.content.shanghaiDay ?? "") : (e.content.date ?? ""));
function measurement(rows: Evidence[], key: string, divisor: number) {
  const values = rows.map((e) => finite(e.content[key])).filter((v): v is number => v !== null && v >= 0);
  const missing = rows.length - values.length;
  const value = missing === rows.length && missing > 0 ? null : values.reduce((a, b) => a + b, 0) / divisor;
  return { value, missing, text: `${value === null ? "未知" : value.toFixed(1)}${missing ? `（${missing}条缺失，仅合计有值记录）` : ""}` };
}
const km = (rows: Evidence[]) => measurement(rows, "distanceM", 1000).text;
const days = (rows: Evidence[]) => new Set(rows.map(day)).size;
const sourceDates = (rows: Evidence[]) => [...new Set(rows.map(day).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();

export function describeSnapshot(snapshot: Snapshot) {
  const active = snapshot.evidence.filter((e) => e.active);
  const activities = active.filter((e) => e.kind === "activity" && day(e) >= snapshot.startDay && day(e) <= snapshot.endDay);
  // Explicit watch sport codes in this POC's source contract. Unknown sports stay excluded;
  // no distance-based guessing and no dependency on the Coach runtime for classification.
  const runs = runningEvidence(snapshot);
  const strength = activities.filter((e) => e.content.sport === "strength");
  const conclusions: Conclusion[] = [];
  function add(id: string, title: string, text: string, dimension: string, rows: Evidence[], options: Partial<Conclusion> = {}) {
    if (!rows.length) return;
    conclusions.push({
      id,
      kind: "fact",
      title,
      text,
      dimension,
      lifecycle: "rolling",
      conditions: `仅适用于 ${snapshot.startDay} 至 ${snapshot.endDay} 的已取得记录。`,
      limitations: ["无记录的日期不等于休息；活动记录数不等于训练课次数，热身／放松可能分开记录。"],
      evidence: refs(rows),
      sourceDates: sourceDates(rows),
      ...options,
    });
  }
  add(
    "recorded-structure",
    "窗口训练记录的构成",
    `取得 ${activities.length} 条活动：其中跑步 ${runs.length} 条，分布在 ${days(runs)} 个上海日期，累计 ${km(runs)} 公里、${measurement(runs, "durationS", 3600).text} 小时；力量 ${strength.length} 条，分布在 ${days(strength)} 天。`,
    "训练经历与结构",
    activities,
  );
  const recentStart = addDays(snapshot.endDay, -27),
    previousStart = addDays(snapshot.endDay, -55);
  const recent = runs.filter((e) => day(e) >= recentStart);
  const previous = runs.filter((e) => day(e) >= previousStart && day(e) < recentStart);
  add(
    "recent-volume",
    "最近两个28天窗口的记录跑量",
    `${recentStart} 至 ${snapshot.endDay}：${km(recent)} 公里、${days(recent)} 个跑步日；此前 ${previousStart} 至 ${addDays(recentStart, -1)}：${km(previous)} 公里、${days(previous)} 个跑步日。`,
    "近期训练连续性",
    [...recent, ...previous],
    { limitations: ["这是等长窗口记录对照，不据此认定能力升降或训练是否合适；缺失距离不当成真实零距离。"] },
  );
  const timed = runs.filter((e) => typeof e.content.date === "string");
  const morning = timed.filter((e) => {
    const hour = Number(shanghaiIso(String(e.content.date)).slice(11, 13));
    return hour >= 4 && hour < 10;
  });
  add(
    "recorded-timing",
    "已记录跑步的发生时段",
    `有开始时间的 ${timed.length} 条跑步记录中，${morning.length} 条在上海时间 04:00–09:59 开始。`,
    "训练习惯观察",
    timed,
    { limitations: ["只能说明实际发生时段，不能认定本人喜欢晨跑、有固定空闲时间或今后都应晨跑。"] },
  );
  const long = runs.filter((e) => (finite(e.content.distanceM) ?? -1) >= 25000);
  add(
    "long-exposure",
    "已记录的长距离经历",
    `窗口内有 ${long.length} 条至少25公里的跑步记录，其中最近28天 ${long.filter((e) => day(e) >= recentStart).length} 条；这些是单条活动的距离。`,
    "长距离经历",
    long,
    { limitations: ["这是随窗口滚动的经历汇总；分段保存的同次训练未合并，不等于当前可安全承受的距离或已验证的耐力上限。"] },
  );
  for (const e of runs.filter((e) => e.content.strideSessionClass === "race")) {
    const duration = finite(e.content.durationS),
      distance = finite(e.content.distanceM);
    if (duration === null || distance === null) continue;
    add(
      `event-${e.id}`,
      "已有测试／比赛标签的活动记录",
      `${day(e)}「${String(e.content.name)}」：记录距离 ${(distance / 1000).toFixed(3)} 公里、用时 ${Math.floor(duration / 3600)}小时${Math.floor((duration % 3600) / 60)}分${Math.round(duration % 60)}秒，平均心率 ${String(e.content.avgHr ?? "未知")} bpm。`,
      "参赛与表现经历",
      [e],
      {
        lifecycle: "historical",
        conditions: "引用系统已有 race 标签及手表记录。",
        limitations: ["不是官方认证成绩，不能称为完整参赛史、正式PB或当前极限能力。"],
      },
    );
  }
  const instant = (e: Evidence) => {
    const time = Date.parse(String(e.content.date));
    return Number.isFinite(time) ? time : 0;
  };
  const latest = runs.toSorted((a, b) => day(a).localeCompare(day(b)) || instant(a) - instant(b)).at(-1);
  if (latest)
    add(
      "latest-run",
      "最近一次跑步表现记录",
      `${day(latest)}：${km([latest])} 公里，${measurement([latest], "durationS", 60).text} 分钟，平均配速 ${String(latest.content.avgPaceSKm ?? "未知")} 秒/公里，平均心率 ${String(latest.content.avgHr ?? "未知")} bpm。`,
      "近期运动表现",
      [latest],
      { lifecycle: "historical", limitations: ["单次表现不等于长期能力，也不证明某种环境或补给产生了效果。"] },
    );
  for (const e of active.filter((e) => e.kind === "calibration")) {
    const speed = finite(e.content.threshold_speed_mps),
      hr = finite(e.content.threshold_hr);
    add(
      `calibration-${e.id}`,
      "已有 Go 能力校准估计",
      `参考日 ${String(e.content.as_of_date)}、算法 ${String(e.content.algorithm_version)}：阈值配速 ${speed && speed > 0 ? `${Math.round(1000 / speed)} 秒/公里` : "未知"}，阈值心率 ${hr === null ? "未知" : `${Math.round(hr)} bpm`}。`,
      "跑步能力",
      [e],
      {
        kind: "estimate",
        sourceDates: [String(e.content.as_of_date)],
        conditions: "直接引用已有校准，不重新估计个人基线。",
        limitations: ["是模型估计，不是实测生理阈值；原算法 high confidence 不等于新关联规律的最高支持程度。"],
      },
    );
  }
  for (const e of activities.filter((e) => typeof e.content.feelNote === "string" && e.content.feelNote.trim())) {
    add(`self-report-${e.id}`, "单次活动的本人感受与做法", String(e.content.feelNote), "主观体验与补给", [e], {
      kind: "user_report",
      lifecycle: "historical",
      conditions: `归属于 ${day(e)} 的单次活动；来源为活动 feelNote，提交时间${e.reportedAt ? `为 ${e.reportedAt}` : "未知"}。`,
      limitations: ["原文保留；本人描述不等于客观验证。不能将一次补给做法当成稳定偏好，也不能把‘还能跑’视为已完成距离。"],
    });
  }
  const load = active.filter((e) => e.kind === "load" && day(e) >= recentStart && day(e) <= snapshot.endDay).toSorted((a, b) => day(a).localeCompare(day(b)));
  const currentLoad = load.at(-1);
  if (currentLoad)
    add(
      "current-load",
      "已有 STRIDE 负荷快照",
      `${day(currentLoad)}：急性负荷 ${String(currentLoad.content.acuteLoad ?? "未知")}、慢性负荷 ${String(currentLoad.content.chronicLoad ?? "未知")}、form ${String(currentLoad.content.form ?? "未知")}、负荷比 ${String(currentLoad.content.loadRatio ?? "未知")}；资料覆盖标记 ${String(currentLoad.content.coverageStatus ?? "未知")}。`,
      "近期训练状态",
      [currentLoad],
      { limitations: ["引用已有7/42天EWMA结果；保留真实日期。单独数值不能诊断疲劳或决定加减量，覆盖未知不能假装为零负荷。"] },
    );
  const recovery = active.filter((e) => e.kind === "recovery" && day(e) >= addDays(snapshot.endDay, -13) && day(e) <= snapshot.endDay);
  const valid = (key: string) => recovery.filter((e) => (finite(e.content[key]) ?? 0) > 0);
  const range = (rows: Evidence[], key: string) =>
    rows.length ? `${Math.min(...rows.map((e) => Number(e.content[key])))}–${Math.max(...rows.map((e) => Number(e.content[key])))}` : "未知";
  add(
    "recent-measurements",
    "近14天原始恢复测量覆盖",
    `${addDays(snapshot.endDay, -13)} 至 ${snapshot.endDay}：RHR有值 ${days(valid("rhr"))} 天，范围 ${range(valid("rhr"), "rhr")} bpm；HRV有值 ${days(valid("hrv"))} 天，范围 ${range(valid("hrv"), "hrv")}。`,
    "近期恢复测量",
    recovery,
    { limitations: ["只给窗口内测量范围，没有新建个体基线。缺少HRV厂商、单位及基线带元数据，不能判定恢复良好／异常，也不能推定睡眠时长。"] },
  );

  const weekly = [];
  for (let end = snapshot.endDay; end >= snapshot.startDay; end = addDays(end, -7)) {
    const start = [snapshot.startDay, addDays(end, -6)].sort().at(-1) ?? snapshot.startDay;
    const rows = runs.filter((e) => day(e) >= start && day(e) <= end);
    const distance = measurement(rows, "distanceM", 1000);
    weekly.push({
      start,
      end,
      recordedKm: distance.value === null ? null : Number(distance.value.toFixed(1)),
      missingDistances: distance.missing,
      runDays: days(rows),
      records: rows.length,
    });
  }
  const fullWeeks = weekly.filter((w) => addDays(w.start, 6) === w.end);
  const completeDistances = fullWeeks.flatMap((w) => (w.missingDistances === 0 && w.recordedKm !== null ? [w.recordedKm] : []));
  const weeklyRange = completeDistances.length ? `${Math.min(...completeDistances)}–${Math.max(...completeDistances)} 公里` : "未知";
  if (runs.length && fullWeeks.length)
    add(
      "weekly-recorded-history",
      "训练经历的周序列",
      `本窗口含 ${fullWeeks.length} 个完整7天区间，其中 ${fullWeeks.filter((w) => w.records > 0).length} 个有跑步记录；距离字段完整的 ${completeDistances.length} 个区间，记录跑量范围 ${weeklyRange}。`,
      "训练历史与变化",
      runs,
      { limitations: ["7天区间以窗口结束日向前对齐，不保证都是自然周；只比较已记录跑量，不解释变化原因，也不把无记录当作确认休息。"] },
    );
  return {
    conclusions,
    context: {
      weeklyRecordedVolumes: weekly.reverse(),
      scope: { activities: activities.length, runs: runs.length, strength: strength.length, otherSports: activities.length - runs.length - strength.length },
      exclusions: {
        weeklyRetrospectives: active.filter((e) => e.kind === "user_report").length,
        reason: "旧快照的 user_report 分类不足以确认作者。周复盘混有客观分析且写明无主观文字反馈，不作为本人陈述或独立证明。",
      },
    },
    unknowns: [
      "稳定偏好、长期自我描述与完整训练／参赛史：本轮没有足够的可追溯本人陈述；原始对话未读取。",
      "正式PB：本次活动窗口和测试标签不能证明完整、经认证的个人最好成绩。",
      "伤病与疼痛现状：伤病表无记录不等于没有伤病；旧复盘的默认无不适不作为事实。",
      "睡眠与HRV个人基线带未进入本快照，不能判断睡眠足够或当前恢复良好。",
      "个体环境敏感性、恢复规律与精确影响量尚未验证，不能自动成为规划约束。",
    ],
  };
}
