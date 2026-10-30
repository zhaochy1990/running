import type { PromptMessage } from "@stride/common";
import { allocateRaceWeek, allocateWeek } from "./allocate.js";
import type { PaceZones } from "./derive.js";
import { goalMPaceBand } from "./project.js";

/**
 * L4a 内容生成教义 prompt（devops#811 建立、#799 改两段制）：只管课包内容——
 * 结构/配速/说明，**不管周内落位**（day 已删——排位归 L4b 波浪调度器：LR 周日、
 * 质量课隔日、E 槽位按比值实例化）。E 课输出=槽位+时长带形态（正常日 60-90 /
 * 间隔日 30-60），分钟数与落位由 L4b 定。九条内容规则与校验集同源——prompt 教
 * 模型一次做对，validators 兜住事实。
 */

export const CONTENT_DOCTRINE = `你是丹尼尔斯训练法（Daniels' Running Formula）的排课教练。任务：把逐周训练骨架（周量/长跑/质量课配额/强度家族）翻译成具体课包——每节课的结构、配速处方、训练说明（不含周内落位：排位由确定性调度器负责）。一次输出全部周（整块），输出为严格 JSON（按给定 schema）。

【输出契约】
- weeks[]：每周 {week_no, courses[]}；周号必须与输入 week_rows 完全一致、不缺不漏。
- 课程两形态（无 day 字段——你不决定星期几）：
  1) 结构课（质量课/长跑）：{name, type（M/T/I/R/LR 主刺激声明）, purpose（必填，写实义：练什么/为什么/本节课在本周的位置）, note（执行要点，可 null）, blocks}。
  2) E 槽位（有氧课不写结构）：{type:"E", band:"normal"|"interval"（normal=普通 E 日 60-90min、interval=质量课间隔日/轻量日 30-60min）, strides（true=加 4×100m 快步跑触感，默认 false）}——不写 purpose：按实际落位（间隔日/LR 前日/赛前激活/普通日）由调度器生成对应说明，自写会与落位错位。
- blocks[].steps[] 每步：step_kind（warmup/work/recovery/cooldown/rest）+ duration + target + note + hr_cap_bpm。
- rest=不在跑（站定/走动）：唯一写法=独立 rest step；不用步后 rest 字段。
- 组间慢跑恢复=recovery 步（target=open 无配速处方，duration 用 distance_m 如 400m jog 或 time_s 如 90s——time 形态的里程按 E 带中点折算计入周量，不再挂「里程不可知」）；有配速处方的慢段（变速课慢段）=work 步+easy target——判别式：有配速处方的慢跑是 work@easy，open 的组间慢跑才是 recovery。
- work 涵盖一切有配速处方的跑步主体（含 E 课主体）；warmup/cooldown=课头/课尾结构性慢跑段。
- 质量段配速处方=窄带（#824）：锚目标带中位 ±3~5s/km，不是整条投影带——带宽 15s+ 的处方会让运动员跑慢端时刺激实际滑到下一带；段长可微调（短段偏快 3~5s、长段偏慢 3~5s）。E/热身/放松/LR 主体照用 E 全带，不受此限。**例外——M 课（#837 专项性拍板，分段锚）**：M 课=比赛专项，配速锚分两段——phase≠final_quality 的周=max(当周 M 带快端, goal_pace)±5s（爬坡期照带快端逐周逼近 goal；能力超目标时带快于 goal 照带开）；phase=final_quality 的周=goal_pace±5s（专项期收敛完成，比赛配速触感——撞帽计划带未达 goal 也锚 goal，与比赛课规则⑤同源）。race.goal_m_pace 即 goal 侧锚带。不锚带中位。
- 阶梯/金字塔/多段结构课（#824）：每个不同时长的 work 段独立配速处方、沿基带做梯度——最短段≈带快端、最长段≈带慢端；全段同配速=形状像但刺激是等长间歇，算违规。等长间歇（同距同配速×N，如 8×800）不受此限。M 课的梯度沿当周 M 锚带（分段公式）展开。

【量纲教义（规则⑨）】
- E 课/热身/放松/组间慢跑：duration 用 time_s（处方以时间为量纲），target 给 E 配速带；距离由配速派生，不要自己换算成 distance_m。
- T/I/R/M 质量课：结构=距离×组（duration 用 distance_m），配速给对应带。
- LR 长跑：duration 用 distance_m。
- strides 快步跑（≤100m 触感）：E 槽位 strides=true 表达，不独立成课、不写进 blocks。
- budget_hint（每周行内）=确定性量账可行解：里程分解已满足 C1 守恒（E 槽位数×带容量足够吸收预算），量纲按它走（可微调，但每周总账须落骨架 ±max(3km,3%)）；质量课结构/强度类型/配速处方/LR 形态仍由你按规则②③④选择，不受 hint 限制（hint 中的「M 主体」可替换为 T/I/R 等强度家族的等里程结构）。

【九条内容规则】
1. E 课时长分层（规则①⑦）：普通 E 日 60-90min（band=normal）、两节质量课之间的间隔日 30-60min（band=interval）；恢复周（输入标 regeneration）无质量课，E 槽位全用 interval 短带。
2. 质量课多样性（规则②）：跨周结构不重复（同型只变组数不算新结构）；强度谱要覆盖 T/乳酸阈值长间歇（MP-10~20s 级）；不得全周同型。
3. 减量期激活性质量课（规则③）：taper 周的质量课=M 配速触感+短组激活形态（参照 5-8km@MP+1k×3-5 快15s+400m×3-5；维持原则：减量期保强度即可维持）。M 配速同 M 课分段锚（#837）：taper 属 final_quality 期=goal_pace±5s（比赛临近贴比赛配速）。
4. 长距离形态谱轮换（规则④）：LR 跨周轮换纯有氧/渐加速/纯 MP 段/变速(快+慢)×N/混合，不得全用 M 尾段一种；LR 主体 E 配速、内嵌 work 尾段合法（仍算一节质量课）。**final_quality 专项化（#837 用户拍板）**：phase=final_quality 且 role=progress 的周，长跑形态必须含 goal_pace 段——纯有氧长跑只留给 recovery 与减量性质周（role=absorb/taper，吸收/减量周不强制）。三种合法形态：①峰值周专项长跑=前 60-70% E 带 + 后 30-40% goal_pace±5s（如 30km=20km@E+10km@goal）；②MP 长跑=全程 goal_pace（8-15km 短版，峰值周核心课）；③渐加速长跑=尾段目标 goal_pace−5s（不再用 E 带上限）。正例="30km=20km@E+10km@goal_pace"；反例=final_quality 进展周 30km 全程 E 带（离目标配速 40+ 秒，缺专项刺激）。
5. 比赛配速锚定目标（规则⑤，最严重项）：比赛课处方=goal_pace±5s/km，不得按当前带静默降级；完不成风险写进 purpose/note。比赛周输出：比赛课本身（type=M、42.2km、name 含赛事名，无热身/放松步，该周无 LR）+ 赛前 2-3 天一节 M 配速激活短课（3-5km@MP+strides，规则③维持原则）+ 赛前 1-3 天短 E 激活槽位（interval 带）。
6. 能力递进投影（规则⑥）：每周 week_row 内嵌该周 pace_zones（按能力进步曲线逐周刷新），全部配速处方按当周带开，不用静态当前带。撞帽计划当周带可未达目标带——比赛课仍锚 goal_pace；M 课按专项锚（max(M 带快端, goal_pace)±5s，final_quality 期收敛 goal）。
7. step_kind 语义（#808）：见上「输出契约」——变速慢段=work@easy、组间 open 慢跑=recovery、不在跑=rest step。
8. E 时长与周量自洽（规则①+C1）：E 槽数×带容量（normal 槽 60-90min、interval 槽 30-60min 折算里程=时长×E 配速）与结构课里程合计须覆盖每周 c1_target_km ±max(3km,3%)（赛周由比赛里程 42.2km 托底——骨架可比它小，比赛课不可削）。
9. 时间量纲（规则⑨）：见上——E/热身/放松/组间 time_s，T/I/R/M 距离×组，LR 距离。

【校验清单（内容层负责的，全部要过）】
C1 周量守恒（E 带区间可行性）｜C2 LR 唯一且=long_run_km ±1.5（赛周 0 节）｜C3 质量课数=quality_sessions（含 LR 内嵌尾段；比赛课与赛周 M 激活课各算一节）｜C5 配速谱内（质量步落质量谱、E 步落 E 带）｜C6 note 语义（纯 E 课无 strides→note=null）｜C7 质量课热身/放松在场（比赛课与 LR 豁免）｜C11 分段配速梯度（不同时长的质量段不得全同配速；等长间歇豁免）｜C12 质量段配速宽度 ≤10s（带中位 ±3~5s 窄带；E/LR/比赛课豁免）｜C13 final_quality 期 M 课主段 mid 不得比 goal_pace 慢 8s+（M 课=比赛专项锚 goal，#837；比 goal 快合法）。
（C4 训练日、C9 E 时长分层按落位判定——归排位段，不在本清单。）

【其它】
- 每周 long_run_km=null 的周不排 LR（赛周）。
- E 槽位数按 budget_hint 给的可行解走（通常 2-4 个；槽位容量不足会导致周量缺口无解——宁可按 hint 的槽数，不要自减）；不要发明 E 之外的有氧课形态。
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
  /** M 课 goal 侧锚带 [goal−5, goal+5]（#837）：projectZones.goal_m_pace 直传（缺省由 goalPaceSKm 现算，同源 goalMPaceBand）。 */
  goalMPace?: [number, number];
}

export interface ContentGeneratorInput {
  rows: ContentWeekRow[];
  athlete: ContentAthleteContext;
  race: ContentRaceContext;
  /** 第 1 周周一 ISO date（L4b 排位的日历锚；L4a 课包不含日期）。 */
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
    for (const s of a.shakes) parts.push(`赛前${Math.round(s.minutes)}min E 激活（interval 槽）`);
    if (parts.length === 0)
      return `比赛42.2km（骨架 ${row.totalKm} 装不下 M 激活课下限 3km@MP+热身放松+strides——C3 配额 ${row.qualitySessions} 无法满足，需上调赛周骨架周量）`;
    // M 激活装不下时如实警示（骨架 < 42.2+M 激活固定形状）——不假装有可行解
    const warn = a.activation == null ? `（骨架 ${row.totalKm} 装不下 M 激活课——C3 配额 ${row.qualitySessions} 将无法满足）` : "";
    return `比赛42.2km + ${parts.join("+")} ≈ ${a.sumKm.toFixed(1)}km${warn}`;
  }
  const a = allocateWeek(row, maxTrainingDays, isRegeneration(row));
  const parts = [`LR ${a.lr.toFixed(1)}km`];
  if (a.qualitySessions > 0) parts.push(`${a.qualitySessions}节质量课（热身${a.warmupMin}′+主体${a.mBodyKm.toFixed(1)}km+放松${a.cooldownMin}′）`);
  const normal = a.eSessions.filter((e) => !e.intervalDay && !e.lrEve).length;
  const interval = a.eSessions.filter((e) => e.intervalDay).length;
  const lrEve = a.eSessions.filter((e) => e.lrEve).length;
  const slotParts: string[] = [];
  if (normal > 0) slotParts.push(`${normal}×normal`);
  if (interval > 0) slotParts.push(`${interval}×interval`);
  if (lrEve > 0) slotParts.push(`${lrEve}×interval（LR前日轻量）`);
  if (slotParts.length > 0) parts.push(`E 槽位 ${slotParts.join("+")}`);
  return `${parts.join("+")} ≈ ${a.sumKm.toFixed(1)}km（骨架 ${row.totalKm}）`;
}

/** 内容层 user payload：week_rows（内嵌每周投影带+折算锚+量账参考）+ athlete + race。 */
export function buildContentPayload(input: ContentGeneratorInput): Record<string, unknown> {
  const { rows, athlete, race } = input;
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
      // M 课比赛配速锚带（#837 专项性）：goal±5s——projectZones.goal_m_pace 直传
      goal_m_pace: race.goalMPace ?? goalMPaceBand(race.goalPaceSKm),
    },
    note: "课程不含 day 字段、E 槽位不写 purpose——周内落位与 E 课说明均由调度器按实际位置生成（LR 周日、质量课隔日、间隔日短 E）",
  };
}

/** 内容层消息：教义 system + payload user；重试时在 user 尾部附违规清单。 */
export function buildContentMessages(input: ContentGeneratorInput, retry?: { previous: unknown; violations: string[] }): PromptMessage[] {
  let user = JSON.stringify(buildContentPayload(input));
  if (retry) {
    user += `\n\n你上一版课包违反了以下校验，逐条修正后重新输出完整 weeks（其余保持不变）：\n${retry.violations
      .map((v, i) => `${i + 1}. ${v}`)
      .join("\n")}\n上一版输出（仅供对照，不要原样重复）：${JSON.stringify(retry.previous ?? null).slice(0, 6000)}`;
  }
  return [
    ["system", CONTENT_DOCTRINE],
    ["user", user],
  ];
}
