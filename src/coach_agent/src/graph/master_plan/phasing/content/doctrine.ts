import type { PromptMessage } from "@stride/common";
import { allocateRaceWeek, allocateWeek } from "./allocate.js";
import type { PaceZones } from "./derive.js";

/**
 * L4 内容层教义 prompt（devops#811，daniels-l4-content.md §2-§3 + contract.md
 * §5.3 用户拍板规则①-⑨ 的 prompt 化）。九条内容规则与校验集 C1-C9 同源——
 * prompt 教模型一次做对，validators 兜住事实。
 */

export const CONTENT_DOCTRINE = `你是丹尼尔斯训练法（Daniels' Running Formula）的排课教练。任务：把逐周训练骨架（周量/长跑/质量课配额/强度家族）翻译成具体课表——每节课的结构、配速处方、训练说明。一次输出全部周（整块），输出为严格 JSON（按给定 schema）。

【输出契约】
- weeks[]：每周 {week_no, sessions[]}；周号必须与输入 week_rows 完全一致、不缺不漏。
- 每节课：day（Mon-Sun 周内落位）+ name + type（E/M/T/I/R/LR 主刺激声明）+ purpose（必填，写实义：练什么/为什么/本节课在本周的位置）+ note（执行要点，可 null）+ blocks。
- blocks[].steps[] 每步：step_kind（warmup/work/recovery/cooldown/rest）+ duration + target + note + hr_cap_bpm。
- rest=不在跑（站定/走动）：唯一写法=独立 rest step；不用步后 rest 字段。
- 组间慢跑恢复=recovery 步（target=open 无配速处方）；有配速处方的慢段（变速课慢段）=work 步+easy target——判别式：有配速处方的慢跑是 work@easy，open 的组间慢跑才是 recovery。
- work 涵盖一切有配速处方的跑步主体（含 E 课主体）；warmup/cooldown=课头/课尾结构性慢跑段。

【量纲教义（规则⑨）】
- E 课/热身/放松/组间慢跑：duration 用 time_s（处方以时间为量纲），target 给 E 配速带；距离由配速派生，不要自己换算成 distance_m。
- T/I/R/M 质量课：结构=距离×组（duration 用 distance_m），配速给对应带。
- LR 长跑：duration 用 distance_m。
- strides 快步跑（≤100m 触感）：work 步 + distance_m + target=open，不计质量课。
- budget_hint（每周行内）=确定性量账可行解：里程分解已满足 C1 守恒与 C9 分层带，量纲按它走（可微调，但每周总账须落骨架 ±max(3km,3%)）；质量课结构/强度类型/配速处方/LR 形态仍由你按规则②③④选择，不受 hint 限制（hint 中的「M 主体」可替换为 T/I/R 等强度家族的等里程结构）。

【九条内容规则】
1. E 课时长分层（规则①⑦）：普通 E 日 60-90min、两节质量课之间的间隔日 30-60min（质量课含 LR 内嵌 work 尾段——周日 LR 带 M 尾段时，其前的周六按间隔日处理）；恢复周（输入标 regeneration）无质量课，E 全走 30-60min 短带。两个例外：比赛周比赛日前 1-3 天的短 E 激活/shakeout 可短于 60min，但仍 ≤60min（「短」激活）；LR 前日轻量（长跑前一日只排 ≤8km 的轻 E 或休息，不设时长下限——8km 帽按课实际里程判）。
2. 质量课多样性（规则②）：跨周结构不重复（同型只变组数不算新结构）；强度谱要覆盖 T/乳酸阈值长间歇（MP-10~20s 级）；不得全周同型。
3. 减量期激活性质量课（规则③）：taper 周的质量课=M 配速触感+短组激活形态（参照 5-8km@MP+1k×3-5 快15s+400m×3-5；维持原则：减量期保强度即可维持）。
4. 长距离形态谱轮换（规则④）：LR 跨周轮换纯有氧/渐加速/纯 MP 段/变速(快+慢)×N/混合，不得全用 M 尾段一种；LR 主体 E 配速、内嵌 work 尾段合法（仍算一节质量课）。
5. 比赛配速锚定目标（规则⑤，最严重项）：比赛课处方=goal_pace±5s/km，不得按当前带静默降级；完不成风险写进 purpose/note。比赛周 Sunday=比赛课本身（type=M、42.2km、name 含赛事名，无热身/放松步，该周无 LR；质量配额=比赛课+赛前 2-3 天一节 M 配速激活短课（3-5km@MP+strides，规则③维持原则——减量期保强度即可维持）；赛前 1-3 天其余日子只排短 E 激活 ≤60min。
6. 能力递进投影（规则⑥）：每周 week_row 内嵌该周 pace_zones（按能力进步曲线逐周刷新），全部配速处方按当周带开，不用静态当前带。撞帽计划当周带可未达目标带——比赛课仍锚 goal_pace。
7. step_kind 语义（#808）：见上「输出契约」——变速慢段=work@easy、组间 open 慢跑=recovery、不在跑=rest step。
8. E 时长与周量自洽（规则①+C1）：E 时长×E 配速=里程，先折算再定组；周量守恒目标=每周行的 c1_target_km ±max(3km,3%)（赛周由比赛里程 42.2km 托底——骨架可比它小，比赛课不可削），日数 ≤ athlete.weeklyRunDaysMax（每课独占一天）。
9. 时间量纲（规则⑨）：见上——E/热身/放松/组间慢跑 time_s，T/I/R/M 距离×组，LR 距离。

【校验清单（全部要过）】
C1 周量守恒｜C2 LR 唯一且=long_run_km ±1.5（赛周 0 节）｜C3 质量课数=quality_sessions（含 LR 内嵌尾段；比赛课与赛周 M 激活课各算一节）｜C4 训练日 ≤上限｜C5 配速谱内（质量步落质量谱、E 步落 E 带）｜C6 note 语义（纯 E 课无 strides→note=null）｜C7 质量课热身/放松在场（比赛课与 LR 豁免）｜C9 E 课时长落分层带（time_s 处方；赛周激活窗与 LR 前日 ≤8km 两项豁免）。

【其它】
- 每周 long_run_km=null 的周不排 LR（赛周）。
- 低温严格执行：不自由发明结构之外的形态；组数适配向 quality_family 倾斜。
- purpose 写人话（给用户看），note 只写执行要点（怎么跑），不混 purpose 内容。`;

/** L4 周骨架行（L3 LoadWeek + 该周投影带 + E 带折算锚）。 */
export interface ContentWeekRow {
  week: number;
  /** L2 canonical（recovery/foundation/early_quality/transition_quality/final_quality）。 */
  phase: string;
  /** L3 周角色：progress/absorb/taper/race。 */
  role: "progress" | "absorb" | "taper" | "race";
  totalKm: number;
  longRunKm: number | null;
  qualitySessions: number;
  /** 强度家族提示（L3 strength_policy.quality_family）。 */
  qualityFamily: string;
  /** 该周训练六带（projectZones 输出，s/km）。 */
  zones: PaceZones;
}

export interface ContentAthleteContext {
  weeklyRunDaysMax: number;
  /** 习惯周量（habitual.week_km）。 */
  weekKm: number;
  fitness: { ctl: number; atl: number; form: number };
}

export interface ContentRaceContext {
  name: string;
  /** 比赛日 ISO date。 */
  date: string;
  /** "2:50:00"。 */
  targetTime: string;
  /** 目标配速（s/km，数值）。 */
  goalPaceSKm: number;
}

export interface ContentGeneratorInput {
  rows: ContentWeekRow[];
  athlete: ContentAthleteContext;
  race: ContentRaceContext;
  /** 第 1 周周一 ISO date（周内落位换算锚：第 w 周周一 = 本日期 + (w−1)×7 天）。 */
  planStartMonday: string;
}

/** 秒→分:秒配速串（秒位四舍五入进位，239.7→「3:60」的进位坑已处理）。 */
export const fmtPace = (sPerKm: number) => {
  const totalSec = Math.round(sPerKm);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
};

/** E 带中点（s/km）：duration↔km 折算锚（easy 缺失返回 null，行内不附折算提示）。 */
export function easyMid(row: ContentWeekRow): number | null {
  const [lo, hi] = row.zones.easy ?? [null, null];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}

/** 再生周（L3 canonical=recovery）：无质量课、E 走短带（C9 调和口径单源）。 */
export const isRegeneration = (row: ContentWeekRow) => row.phase === "recovery";

/** budget_hint 渲染：allocate 可行解的量纲脚手架（量账参考；结构/配速/形态仍归 LLM）。 */
function budgetHint(row: ContentWeekRow, maxTrainingDays: number, race: ContentRaceContext): string {
  if (row.role === "race") {
    const a = allocateRaceWeek(row, race);
    const parts: string[] = [];
    if (a.activation != null) parts.push(`赛前M激活 ${a.activation.bodyKm.toFixed(1)}km@MP+strides（赛前2-3天，规则③）`);
    for (const s of a.shakes) parts.push(`赛前${Math.round(s.minutes)}min E 激活`);
    if (parts.length === 0)
      return `比赛42.2km（骨架 ${row.totalKm} 装不下 M 激活课下限 3km@MP+热身放松+strides——C3 配额 ${row.qualitySessions} 无法满足，需上调赛周骨架周量）`;
    // M 激活装不下时如实警示（骨架 < 42.2+M 激活固定形状）——不假装有可行解
    const warn = a.activation == null ? `（骨架 ${row.totalKm} 装不下 M 激活课——C3 配额 ${row.qualitySessions} 将无法满足）` : "";
    return `比赛42.2km + ${parts.join("+")}（比赛日前1-3天、E 每段≤60min）≈ ${a.sumKm.toFixed(1)}km${warn}`;
  }
  const a = allocateWeek(row, maxTrainingDays, isRegeneration(row));
  const parts = [`LR ${a.lr.toFixed(1)}km`];
  if (a.qualitySessions > 0) parts.push(`${a.qualitySessions}节质量课（热身${a.warmupMin}′+主体${a.mBodyKm.toFixed(1)}km+放松${a.cooldownMin}′）`);
  for (const e of a.eSessions) parts.push(`E ${Math.round(e.minutes)}′${e.lrEve ? "（LR前日≤8km）" : e.intervalDay ? "（间隔日）" : ""}`);
  return `${parts.join("+")} ≈ ${a.sumKm.toFixed(1)}km（骨架 ${row.totalKm}）`;
}

/** 内容层 user payload：week_rows（内嵌每周投影带+折算锚+量账参考）+ athlete + race + 日历锚。 */
export function buildContentPayload(input: ContentGeneratorInput): Record<string, unknown> {
  const { rows, athlete, race, planStartMonday } = input;
  return {
    week_rows: rows.map((row) => {
      const eMid = easyMid(row);
      return {
        no: row.week,
        phase: row.phase,
        role: row.role,
        regeneration: isRegeneration(row),
        total_km: row.totalKm,
        // 赛周守恒有效目标=max(骨架, 42.195)——低平台赛周骨架可低于比赛里程本身
        c1_target_km: row.role === "race" ? Math.max(row.totalKm, 42.195) : row.totalKm,
        long_run_km: row.longRunKm,
        quality_sessions: row.qualitySessions,
        quality_family: row.qualityFamily,
        pace_zones: row.zones,
        ...(eMid != null ? { e_pace_mid_s_per_km: Math.round(eMid), e_km_per_60min: Math.round((3600 / eMid) * 10) / 10 } : {}),
        budget_hint: budgetHint(row, athlete.weeklyRunDaysMax, race),
      };
    }),
    athlete,
    race: {
      name: race.name,
      date: race.date,
      target_time: race.targetTime,
      goal_pace: `${fmtPace(race.goalPaceSKm)}/km`,
      goal_pace_s_per_km: race.goalPaceSKm,
    },
    calendar: {
      plan_start_monday: planStartMonday,
      note: "day 字段用 Mon-Sun；第 w 周周一 = plan_start_monday + (w−1)×7 天；比赛日=race.date（赛周该 day 排比赛课）",
    },
  };
}

/** 内容层消息：教义 system + payload user；重试时在 user 尾部附违规清单。 */
export function buildContentMessages(input: ContentGeneratorInput, retry?: { previous: unknown; violations: string[] }): PromptMessage[] {
  let user = JSON.stringify(buildContentPayload(input));
  if (retry) {
    user += `\n\n你上一版课表违反了以下校验，逐条修正后重新输出完整 weeks（其余保持不变）：\n${retry.violations
      .map((v, i) => `${i + 1}. ${v}`)
      .join("\n")}\n上一版输出（仅供对照，不要原样重复）：${JSON.stringify(retry.previous).slice(0, 6000)}`;
  }
  return [
    ["system", CONTENT_DOCTRINE],
    ["user", user],
  ];
}
