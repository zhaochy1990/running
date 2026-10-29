import type { ContentGeneratorInput, ContentWeekRow } from "./doctrine.js";
import { E_DURATION_INTERVAL_BAND, E_DURATION_NORMAL_BAND, LR_EVE_MAX_KM } from "./validators.js";

/**
 * 确定性量账分配（devops#811）：把一周骨架（km/lr/q）分解成 LR+质量课+E 时长
 * 的可行解——C1 守恒与 C9 分层带联立下的带内构造（38 案例 L3 golden 全量验证，
 * 即 L3 缺省包络：训练日 ≥5、q∈{0,1,2}；包络外（极端低日数/超高量）残余可超
 * C1 容差，由调用方门检如实挂出）。两个消费方：兜底模板（fallback.ts 按分配
 * 直出课表）与生成 payload 的 budget_hint（doctrine.ts——量纲脚手架给 LLM 参考
 * 可行解，结构/配速仍归 LLM；与 #798「课表库缺省+LLM 适配」同向）。
 */

export interface AllocatedESession {
  /** 周内位（周一=0…周日=6）。 */
  weekday: number;
  minutes: number;
  /** 质量课间隔日（C9 短带 30-60min）。 */
  intervalDay: boolean;
  /** LR 前日（周六，#825 轻量帽 ≤8km 或休）。 */
  lrEve: boolean;
}

export interface WeekAllocation {
  lr: number;
  /** 质量课数（L3 缺省 q∈{0,1,2}；>2 抛错不静默截断）。 */
  qualitySessions: number;
  /** 质量课周内位（周二；q=2 加周五）。 */
  qualityWeekdays: number[];
  /** M 主体里程（km，含吸收后终值）；热身 15min+放松 10min 另计。 */
  mBodyKm: number;
  warmupMin: number;
  cooldownMin: number;
  warmupCooldownExtraMin: number;
  eSessions: AllocatedESession[];
  /** 分配总里程（km）——与骨架的残余由 C1 容差吸收。 */
  sumKm: number;
}

const easyMidOf = (row: ContentWeekRow) => {
  const [lo, hi] = row.zones.easy ?? [null, null];
  if (lo == null || hi == null) throw new Error(`allocate: 第${row.week}周 easy 带缺失`);
  return (lo + hi) / 2;
};

/** 常规周分配：LR 周日 + 质量课周二(/周五) + E 槽位（间隔日优先、带内均涨、余量吸收序）。 */
export function allocateWeek(row: ContentWeekRow, maxTrainingDays: number, regeneration: boolean): WeekAllocation {
  const eMid = easyMidOf(row);
  const kmOf = (minutes: number) => (minutes * 60) / eMid;
  let lr = row.longRunKm;
  if (lr == null) throw new Error(`allocate: 第${row.week}周非赛周但 lr=null`);
  const q = row.qualitySessions;
  if (q > 2) throw new Error(`allocate: 第${row.week}周 q=${q} 超模板域（L3 缺省 ∈{0,1,2}）`);
  const total = row.totalKm;

  const qualityWds = q === 2 ? [1, 4] : q === 1 ? [1] : [];
  // LR 固定周日 → 周六=LR 前日轻量（#825 拍板：E ≤8km 或休）：上限=8km 折算分钟
  // （与短带上限取紧），下限=E 家族 30min（帽小于 30min 的精英带取帽本身）
  const lrEveCapMin = Math.min(E_DURATION_INTERVAL_BAND[1], (LR_EVE_MAX_KM * eMid) / 60);
  const lrEveBand: readonly [number, number] = [Math.min(E_DURATION_INTERVAL_BAND[0], lrEveCapMin), lrEveCapMin];
  const eSlots = [2, 3, 5, 0]
    .map((wd) => {
      const intervalDay = qualityWds.some((a) => a < wd) && qualityWds.some((b) => b > wd);
      const band: readonly [number, number] = wd === 5 ? lrEveBand : intervalDay || regeneration ? E_DURATION_INTERVAL_BAND : E_DURATION_NORMAL_BAND;
      return { wd, band, intervalDay, lrEve: wd === 5 };
    })
    .sort((a, b) => a.band[0] - b.band[0]); // 短带槽位优先装填（预算紧时先落间隔日）

  const wuMin = 15;
  const cdMin = 10;
  const wuCdKm = kmOf(wuMin + cdMin);
  let mBody = q >= 1 ? Math.min(12, Math.max(4, ((total - lr) * 0.4) / q - wuCdKm)) : 0;
  let eBudget = total - lr - q * (mBody + wuCdKm);
  if (eBudget < 0 && q >= 1) {
    mBody = Math.max(3, mBody + eBudget / q);
    eBudget = total - lr - q * (mBody + wuCdKm);
  }

  const maxE = Math.max(0, Math.min(eSlots.length, maxTrainingDays - 1 - q));
  let chosen = 0;
  for (let n = maxE; n >= 1; n--) {
    const loSum = eSlots.slice(0, n).reduce((s, slot) => s + kmOf(slot.band[0]), 0);
    if (loSum <= eBudget + 0.05) {
      chosen = n;
      break;
    }
  }
  // 均分装填（water-filling）：下限起步，余量在未顶格槽位间均涨、上限钳制
  const eMinutes = eSlots.slice(0, chosen).map((slot) => slot.band[0]);
  let rest = eBudget - eMinutes.reduce((s, m) => s + kmOf(m), 0);
  for (let pass = 0; pass < 4 && rest > 0.05; pass++) {
    const freeIdx = eMinutes.map((m, i) => (m < eSlots[i]!.band[1] ? i : -1)).filter((i) => i >= 0);
    if (freeIdx.length === 0) break;
    // km → 分钟 = km×eMid/60（eMid s/km；每公里耗时 eMid 秒）
    const addMin = (rest * eMid) / 60 / freeIdx.length;
    for (const i of freeIdx) eMinutes[i] = Math.min(eSlots[i]!.band[1], eMinutes[i]! + addMin);
    const sumKm = eMinutes.reduce((s, m) => s + kmOf(m), 0);
    rest = eBudget - sumKm;
  }
  // 终量吸收序（E 全部顶格/缺位后的残余，结构性洞如单槽 90min 装不满低量周）：
  // ① M 主体（帽 [3,16]——16km≈丹氏 MP 大课 10 英里天花板；LR 前日帽压缩 E
  // 容量后，峰值周残量靠 M 主体收口）② LR ±≤1.4（C2 容差 1.5 内留余）
  // ③ 热身/放松 +10min（E 时段不占 C9 分层带）——仍残留由 C1 容差吸收
  if (q >= 1 && Math.abs(rest) > 0.05) {
    const target = Math.min(16, Math.max(3, mBody + rest / q));
    rest -= (target - mBody) * q;
    mBody = target;
  }
  if (Math.abs(rest) > 0.05) {
    const grow = Math.max(-1.4, Math.min(1.4, rest));
    lr += grow;
    rest -= grow;
  }
  // ③ 热身/放松加时（E 时段不占 C9 分层带）——5min 分档、帽 10min：残量装得下
  // 才加（#825：LR 前日帽压缩 E 容量后，小残量硬加整档会超调 C1），装不下由容差吸收
  const wuCdExtraMin = q >= 1 ? (([10, 5] as const).find((m) => rest + 0.05 >= kmOf(m) * q) ?? 0) : 0;

  const eSessions = eMinutes.map((minutes, i) => ({ weekday: eSlots[i]!.wd, minutes, intervalDay: eSlots[i]!.intervalDay, lrEve: eSlots[i]!.lrEve }));
  const sumKm = lr + q * (mBody + wuCdKm + kmOf(wuCdExtraMin)) + eSessions.reduce((s, e) => s + kmOf(e.minutes), 0);
  return {
    lr,
    qualitySessions: q,
    qualityWeekdays: qualityWds,
    mBodyKm: mBody,
    warmupMin: wuMin,
    cooldownMin: cdMin,
    warmupCooldownExtraMin: wuCdExtraMin,
    eSessions,
    sumKm,
  };
}

export interface RaceWeekShake {
  weekday: number;
  minutes: number;
}

export interface RaceWeekActivation {
  weekday: number;
  /** M 主体里程（km，简版 #825：3-5km 带内按预算定，热身 15min+放松 10min+strides 400m 另计）。 */
  bodyKm: number;
}

export interface RaceWeekAllocation {
  /** M 配速激活课（#825 规则③⑧维持原则：赛前 2-3 天一节 M 触感短课；窗不可用/预算装不下=null）。 */
  activation: RaceWeekActivation | null;
  /** 赛前短 E 激活（每段 ≤60min 短带上限；M 激活日之外的窗内日子）。 */
  shakes: RaceWeekShake[];
  sumKm: number;
}

/** 赛周 M 激活课简版形状（#825）：主体 3-5km 带内 + 4×100m strides；热身/放松 E 时长（min）。 */
const M_ACTIVATION_BODY_KM_DEFAULT = 4;
const M_ACTIVATION_BODY_KM_MIN = 3;
const M_ACTIVATION_STRIDES_M = 400;

/** 比赛周分配：比赛 42.195km + 赛前 M 配速激活短课（2-3 天前，简版）+ 窗内短 E 激活。 */
export function allocateRaceWeek(row: ContentWeekRow, race: ContentGeneratorInput["race"]): RaceWeekAllocation {
  const eMid = easyMidOf(row);
  const kmOf = (minutes: number) => (minutes * 60) / eMid;
  const raceWd = (new Date(`${race.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const remaining = row.totalKm - 42.195;

  // M 激活窗=赛前 2-3 天（偏 2 天；raceWd≥2 由 generateWeekContent 入口保证）；E 激活=窗内其余日子（偏赛前 1 天起）
  const activationWd = [raceWd - 2, raceWd - 3].find((wd) => wd >= 0) ?? null;
  let left = remaining;
  // 热身 15min+放松 10min（E 折算）+strides 400m 的固定形状；主体取拍板带 [3,5] 缺省 4、按预算向下收
  const fixedKm = kmOf(15 + 10) + M_ACTIVATION_STRIDES_M / 1000;
  let activation: RaceWeekActivation | null = null;
  let activationKm = 0;
  if (activationWd != null) {
    // 主体 <3km=预算装不下 M 激活下限（精英带 + 低平台赛周触底 52.2 的包络边界，
    // 需 eMid≲227s/km），置 null 由 C3 如实挂出——不破拍板下限换过门
    const bodyKm = Math.min(M_ACTIVATION_BODY_KM_DEFAULT, left - fixedKm);
    if (bodyKm >= M_ACTIVATION_BODY_KM_MIN) {
      activation = { weekday: activationWd, bodyKm };
      activationKm = fixedKm + bodyKm;
      left -= activationKm;
    }
  }
  const shakeWindow = [raceWd - 1, raceWd - 3, raceWd - 2].filter((wd) => wd >= 0 && (activation == null || wd !== activation.weekday));

  const shakes: RaceWeekShake[] = [];
  for (const wd of shakeWindow) {
    if (left < 2) break;
    const capMin = E_DURATION_INTERVAL_BAND[1]; // 赛周激活=短 E（①拍板），上限 60min
    const minutes = Math.min((left * eMid) / 60, capMin);
    const seconds = Math.round((minutes * 60) / 30) * 30; // 取整 30s
    shakes.push({ weekday: wd, minutes: seconds / 60 });
    left -= seconds / eMid;
  }
  // 未铺完的残量（窗口耗尽）由 C1 容差吸收；Σ 按 30s 取整后的实际处方计（M 激活按课形状计）
  const sumKm = 42.195 + activationKm + shakes.reduce((s, x) => s + (x.minutes * 60) / eMid, 0);
  return { activation, shakes, sumKm };
}
