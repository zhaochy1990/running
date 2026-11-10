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

【核心原则：强度分布随比赛临近单调向专项收窄】
全马项目的专项收窄意味着——最后 4-6 周，MP（马拉松配速）训练必须在**所有训练形态中大量出现**，不仅仅是长跑：
- **周内质量课**：T/I/R 课逐渐让位于 M 配速课（节奏跑、M 间歇、M 连续段）——前期练阈值和 VO2max 是为了"有能力跑 MP"，后期练 MP 是为了"在 MP 上跑得稳"
- **周末长跑**：纯有氧长跑只留给早期或减量周，专项期长跑必须含 goal_pace 段（渐加速尾段/全程 MP 模拟/MP-10s 持续/MP-E 变速——形态谱五选一轮换）
- **有氧跑比例**：从早期的 80-90% 逐步下降到峰值 MP 周的 40-50%——这不是"偷懒"，是专项性原则（SAID）的正确执行
教练基准 8 周实证：前期有氧 ~75-80% → 峰值 MP 周（30-35km@MP）~45% → 赛周 ~30%。

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
1. E 课时长分层（规则①⑦）：普通 E 日 60-90min（band=normal）、两节质量课之间的间隔日 30-60min（band=interval）；恢复周（输入标 regeneration）无质量课，E 槽位全用 interval 短带；**taper 周（role=taper）E 槽位同样全用 interval 短带且槽数 ≥3——原书减量原则=保持频率、从单课体积里减（E 多而短，不并大课、不留 2 天以上连休）**。
2. 质量课多样性与段长谱（规则②，2026-11-02 原书校准）：跨周结构不重复（同型只变组数不算新结构）；强度谱要覆盖 T/乳酸阈值长间歇（MP-10~20s 级）；不得全周同型。**final_quality 期段长谱（原书 Phase 4 形态，C16 强制）**：T 巡航间歇单段 ≥2km（原书 2-3mi 段）；**多段课的段间配速差 ≥5s/km**（如 2km@240+3km@246——短段贴带快端、长段贴带慢端；差 1-2s 在执行噪声内=C11 判等长刺激）；独立 M 课 M 段合计 ≥6km 且最长单段 ≥3km（原书 3×2mi/2×4mi/8-10mi 连续——**连续段优先**，6-8km 连续或 2×3-4km 双段是主形态，≤2km 短段间歇不是 M 课形态；1km 级 M/E 碎段变速只留给 LR 内嵌）；I 间歇仅限 progress 周维持 VO2max（每周 ≤1 节、单段 ≥1km），taper/race 周禁 I。
  **已证参照（2026-11-02 拍板）**：payload 携带 recent_proven_sessions（近 8-10 周质量课/长距离课的实际记录）——新课刺激不得低于最近同类课的已证水平：同类长跑的新课尾段/主体应达到已证递进位置（带内取已证或偏挑战端）；同类质量课的段长×组数不低于已证课（配速在当周带内取）；feel 低（轻松完成）的已证课取带宽上沿，feel 高（挣扎）的取保守端。已证记录显示带宽内上限已被轻松达成时取带快端——**低于已证水平的课=浪费一个训练日**。
  **E 压缩与 M 段铺开（2026-11-02 拍板）**：final_quality progress 周把 1 个普通 E 槽升级为「E+M 段轻课」（第三质量位，C3 的 q+1 位、C16 豁免）：热身 E 15-20min + **单段 3.2-6.5km@goal_pace±5s** + 放松 E 10-15min、课总里程 ≤16km；**段长按运动员能力映射：当周 total_km ≥80→5-6.5km、70-80→4-5km、<70→3.2-4km**。该周有氧份额压到 ≤65%（P7 上限强制）；taper/absorb/赛周不设第三质量位。
3. 减量期质量课（规则③，2026-11-01 原书校准）：taper 周 q=2——两节缩短的质量课以 **T 阈值为纲**（原书 2Q 计划倒数第二周两节质量课仍保持可观 T 里程，如巡航间歇 2×2-3km@T 或 3×1.6km@T；其中一节可带 M 触感短段 3-5km@goal_pace）；维持原则=保强度、缩体积、不换强度类型（原书 taper：强度与频率保持，体积是唯一被砍的变量）。
4. 长距离形态谱周期化（规则④+#837 终审修正：**不得全用同一种结构**，按教练 8 周基准逐周变换）：
  **final_quality 进展周（role=progress）的长跑形态按周次递进轮换，以下五选一且跨周不得重复同型**：
  ① 纯有氧长跑（30-38km 全程 E 带）——用于早期周建底座堆量（教练赛前 8/6 周的 30-38km 纯有氧）
  ② 渐加速长跑（前 60-70% E 带 + **后 12-15km@goal_pace+10~20s**，尾段**略慢于** MP——过渡形态，比模拟版慢一档）——用于中期专项过渡（教练赛前 7 周的"后 12-15km@MP 慢10~20s/km"）
  ③ 全程 MP 模拟（**全程 goal_pace±5s**，30-35km）——峰值周核心课、最专项的一节（教练赛前 4 周的"30-35km@MP"）
  ④ MP-10s 持续跑（**全程 goal_pace−10s**（比目标**快** 10 秒），22-25km 短版）——**仅限 progress 角色的调整/吸收周**缩量提速、维持强度（教练赛前 5 周调整周的"22-25km@MP-10s"）；**taper 周禁用提速形态**（减量周比比赛配速更快的长跑=赛前 8 天的半程节奏赛，与减量原则冲突——taper 周 LR 二选一：①纯有氧 或 ②**原书 W17「9E+6T」形态——20-25km 嵌 8-12km@T 带**（快段合计 ≤12km，C15 强制；比 goal 慢 10-20s 的渐加速短版亦合法；禁 goal 及更快的全程大块=二连彩排）
  ⑤ MP/E 变速（**(5km@goal_pace + 1km@E)×N**）——练节奏弹性（教练赛前 3 周的"(5k@MP+1k@E)×6"）
  减量周不强制专项段；absorb（progress 角色）可选任何形态，**taper 周 LR 形态限 ①纯有氧/②原书 9E+6T 嵌 T 段（20-25km 嵌 8-12km@T，赛前 2 周的标准形态）/③比 goal 慢 10-20s 渐加速短版——禁 goal 及更快的大块（15-20km@MP=二连彩排非原书做法）**。
  **周期化建议序列**（以 6 周 final_quality 为例）：W1 纯有氧→W2 渐加速→W3 全程 MP 模拟(峰值)→W4 MP-10s 持续(调整)→W5 MP/E 变速或渐加速短版→W6 减量纯有氧。关键=**跨周变换**，同一个"后段 10km@MP"连续出现两周以上=违规。
  LR 主体 E 配速、内嵌 work 段合法（仍算一节质量课）。渐加速的尾段=goal_pace−10~20s（**不是精确 goal_pace**——渐加速版是过渡，比模拟版慢一档）。
5. 比赛配速锚定目标（规则⑤，最严重项）：比赛课处方=goal_pace±5s/km，不得按当前带静默降级；完不成风险写进 purpose/note。比赛周输出（2026-11-01 原书校准）：比赛课本身（type=M、42.2km、name 含赛事名，无热身/放松步，该周无 LR）+ **周二位（或赛前 3-5 天最早空日）一节 M 配速触感激活短课**（2026-11-09 用户拍板回归教练基准：3-5km@goal_pace±5s+4-6×100m strides，可带 1-3 组 1km 快 15s 短组——找比赛节奏与补给演练；原书 2Q 的 T 触感形态为另一流派，不采）+ 赛前日常=通勤感知形态（2026-11-01 拍板）：通勤日（周五或周六，缺省周六）不跑步；通勤前一天一节 **25-30min shakeout** 保持状态（interval 带）；赛前 3 天（周四）可再一节 20-30min 短 E——宁可少而实，不铺每天 10-15min 的碎课（无有效刺激且被通勤打乱）。比赛课 note 写入通勤消耗提示（通勤日补水/碳水/早睡——通勤本身是消耗，比赛周恢复优先于训练）。
6. 能力递进投影（规则⑥）：每周 week_row 内嵌该周 pace_zones（按能力进步曲线逐周刷新），全部配速处方按当周带开，不用静态当前带。撞帽计划当周带可未达目标带——比赛课仍锚 goal_pace；M 课按专项锚（max(M 带快端, goal_pace)±5s，final_quality 期收敛 goal）。
7. step_kind 语义（#808）：见上「输出契约」——变速慢段=work@easy、组间 open 慢跑=recovery、不在跑=rest step。
8. E 时长与周量自洽（规则①+C1）：E 槽数×带容量（normal 槽 60-90min、interval 槽 30-60min 折算里程=时长×E 配速）与结构课里程合计须覆盖每周 c1_target_km ±max(3km,3%)（赛周由比赛里程 42.2km 托底——骨架可比它小，比赛课不可削）。
9. 时间量纲（规则⑨）：见上——E/热身/放松/组间 time_s，T/I/R/M 距离×组，LR 距离。

【校验清单（内容层负责的，全部要过）】
C1 周量守恒（E 带区间可行性）｜C2 LR 唯一且=long_run_km ±1.5（赛周 0 节）｜C3 质量课数=quality_sessions（含 LR 内嵌尾段；比赛课与赛周 M 触感激活课各算一节；q+1 位=每周至多一节轻量 M 段课=单段 3.2-6.5km@goal、总里程 ≤16km，2026-11-02）｜C5 配速谱内（质量步落质量谱、E 步落 E 带）｜C6 note 语义（纯 E 课无 strides→note=null）｜C7 质量课热身/放松在场（比赛课与 LR 豁免）｜C11 分段配速梯度（不同时长的质量段不得全同配速；等长间歇豁免）｜C12 质量段配速宽度 ≤10s（带中位 ±3~5s 窄带；E/LR/比赛课豁免）｜C13 final_quality 期 M 课主段 mid 不得比 goal_pace 慢 8s+（M 课=比赛专项锚 goal，#837；比 goal 快合法）｜C15 taper 周长跑禁提速（LR work 段 mid 不得比 goal_pace 快——减量周长跑只允许纯有氧或比 goal 慢的渐加速，2026-11-02 拍板）｜C16 final_quality 段长谱（原书 Phase 4：T 段 ≥2km、独立 M 课 M 段合计 ≥6km 且最长段 ≥3km、I 仅 progress 周且段 ≥1km 且 taper/race 周禁 I——taper 周 T 段豁免下限=缩短语义）。
（C4 训练日、C9 E 时长分层按落位判定——归排位段，不在本清单。）

【其它】
- 每周 long_run_km=null 的周不排 LR（赛周）。
- week_row 的 adjust_guidance（如有，#858 调整提案）= 本周调整指令（用户反馈原因的配方：降载消化/保课砍量/吸收已完成的训练/配速放缓一档等），本周课表必须按它执行，取舍优先级高于默认周期化形态；周量等量纲仍以行内 total_km 与 budget_hint 为准（配方已折算进骨架），guidance 只约束课表形态与取舍。
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
  /**
   * 周级调整指令（#858 PR-C 调整提案，可选）：用户反馈原因的配方语义
   * （降载/保课/吸收/放缓一档等），进 payload 的 adjust_guidance——只有
   * 调整投影（runAdjustProjection）填充，master/rolling 首批不传。
   */
  guidance?: string;
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
  /**
   * 比赛周通勤日（2026-11-01 用户拍板）：运动员通常周五或周六从生活城市赶往
   * 比赛城市——通勤日不安排跑步（赶路+领物+适应），通勤前一天跑一次 25-30min
   * shakeout 保持状态。friday=周五通勤（周五休/周六 shakeout）、saturday=周六
   * 通勤（周五 shakeout/周六休）；缺省 saturday（赛前一天休整是更保守形态）。
   */
  travelDay?: "friday" | "saturday";
  /** "2:50:00"。 */
  targetTime: string;
  /** 目标配速（s/km，数值）。 */
  goalPaceSKm: number;
  /** M 课 goal 侧锚带 [goal−5, goal+5]（#837）：projectZones.goal_m_pace 直传（缺省由 goalPaceSKm 现算，同源 goalMPaceBand）。 */
  goalMPace?: [number, number];
}

export interface ProvenSession {
  date: string;
  /** 训练分类（quality/long_quality/race/long_easy…）。 */
  sessionClass: string;
  name: string;
  distanceKm: number;
  durationMin: number;
  avgPaceSKm: number | null;
  /** 主观强度（1-10，低=轻松；可空）。 */
  feel: number | null;
}

/**
 * 近期已证训练课构造（#857，2026-11-02 拍板 2026-11-10 上移生产）：近 10 周
 * 质量/长距离课摘要——L4a 已证参照规则的数据源（新课刺激不低于最近同类课
 * 已证水平）。筛选：quality/long_quality/race/long_easy 类，不加距离限制
 * （2026-11-10 用户拍板：完全信任分类器——strides/触感课分类器本来就不标
 * quality，距离线是冗余防御且可能挡掉短而有效的课如 3×1km@MP+放松≈6km）。
 */
export function buildProvenSessions(
  activities: ReadonlyArray<{
    shanghaiDay: string;
    name?: string | null;
    distanceM?: number | null;
    strideSessionClass?: string | null;
    durationS?: number | null | undefined;
  }>,
  asOf: string,
): ProvenSession[] {
  // 日历日归属用 Provider 换算好的 shanghaiDay（devops#936）；此前各处自算 +8h，
  // #857 曾把上海次日凌晨的课归错日期（用户 2026-11-10 评审发现）。
  const asOfDay = asOf.slice(0, 10);
  const tenWeeksAgo = new Date(new Date(`${asOfDay}T00:00:00Z`).getTime() - 70 * 86400000).toISOString().slice(0, 10);
  return activities
    .filter(
      (a) =>
        a.shanghaiDay >= tenWeeksAgo &&
        a.shanghaiDay <= asOfDay &&
        a.strideSessionClass != null &&
        ["quality", "long_quality", "race", "long_easy"].includes(a.strideSessionClass),
    )
    .map((a) => ({
      date: a.shanghaiDay,
      sessionClass: a.strideSessionClass!,
      name: (a.name ?? "").slice(0, 24),
      distanceKm: Math.round(((a.distanceM ?? 0) / 1000) * 10) / 10,
      durationMin: Math.round(((a.durationS ?? 0) / 60) * 10) / 10,
      avgPaceSKm: a.distanceM != null && a.durationS != null && a.durationS > 0 ? Math.round((a.durationS / (a.distanceM / 1000)) * 10) / 10 : null,
      feel: null,
    }));
}

export interface ContentGeneratorInput {
  rows: ContentWeekRow[];
  athlete: ContentAthleteContext;
  race: ContentRaceContext;
  /** 第 1 周周一 ISO date（L4b 排位的日历锚；L4a 课包不含日期）。 */
  planStartMonday: string;
  /** 近期已证训练课（2026-11-02 拍板）：近 8-10 周质量课/长距离课摘要——新课刺激
   * 须参照已证水平（低于它=浪费训练日），由调用方从 L1 activities 构造。 */
  provenSessions?: ProvenSession[];
}

/**
 * L3 canonical → 强度家族提示（ContentWeekRow.qualityFamily 的行构建用）。
 * 注意与 `strength_policy[].quality_family` 不同：后者是给政策面读的长描述，
 * 前者是喂 L4 prompt 的短提示，回放（contentReplay）与 kernel 必须用同一份。
 */
export const QUALITY_FAMILY_OF: Record<string, string> = {
  recovery: "无质量课（纯 E + strides 触感）",
  foundation: "E 为主；速度触感靠 strides 副课",
  early_quality: "R 重复（速度经济性）",
  transition_quality: "I/T（冬季以 T 为主）",
  final_quality: "M 配速比赛专项",
};

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
    if (a.activation != null) parts.push(`周二位M触感激活 ${a.activation.bodyKm.toFixed(1)}km@goal±5s+strides（教练基准赛周形态）`);
    for (const s of a.shakes) parts.push(`周${"一二三四五六"[s.weekday]} ${Math.round(s.minutes)}min E shake`);
    if (parts.length === 0)
      return `比赛42.2km（骨架 ${row.totalKm} 装不下激活课下限 3km@T带+热身放松+strides——C3 配额 ${row.qualitySessions} 无法满足，需上调赛周骨架周量）`;
    // 激活课装不下时如实警示（骨架 < 42.2+激活课固定形状）——不假装有可行解
    const warn = a.activation == null ? `（骨架 ${row.totalKm} 装不下激活课——C3 配额 ${row.qualitySessions} 将无法满足）` : "";
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
        ...(row.guidance != null && row.guidance.length > 0 ? { adjust_guidance: row.guidance } : {}),
        ...(eMid != null ? { e_pace_mid_s_per_km: Math.round(eMid), e_km_per_60min: Math.round((3600 / eMid) * 10) / 10 } : {}),
        budget_hint: budgetHint(row, athlete.weeklyRunDaysMax, race),
      };
    }),
    athlete,
    ...(input.provenSessions && input.provenSessions.length > 0 ? { recent_proven_sessions: input.provenSessions } : {}),
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
