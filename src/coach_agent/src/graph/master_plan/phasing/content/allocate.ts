import type { ContentGeneratorInput, ContentWeekRow } from "./doctrine.js";
import { E_DURATION_INTERVAL_BAND, E_DURATION_NORMAL_BAND } from "./validators.js";

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
  const eSlots = [2, 3, 5, 0]
    .map((wd) => {
      const intervalDay = qualityWds.some((a) => a < wd) && qualityWds.some((b) => b > wd);
      const band: readonly [number, number] = intervalDay || regeneration ? E_DURATION_INTERVAL_BAND : E_DURATION_NORMAL_BAND;
      return { wd, band, intervalDay };
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
  // ① M 主体（帽 [3,14]）② LR ±≤1.4（C2 容差 1.5 内留余）③ 热身/放松 +10min
  // （E 时段不占 C9 分层带）——仍残留由 C1 容差吸收
  if (q >= 1 && Math.abs(rest) > 0.05) {
    const target = Math.min(14, Math.max(3, mBody + rest / q));
    rest -= (target - mBody) * q;
    mBody = target;
  }
  if (Math.abs(rest) > 0.05) {
    const grow = Math.max(-1.4, Math.min(1.4, rest));
    lr += grow;
    rest -= grow;
  }
  const wuCdExtraMin = rest > 0.05 && q >= 1 ? 10 : 0;

  const eSessions = eMinutes.map((minutes, i) => ({ weekday: eSlots[i]!.wd, minutes, intervalDay: eSlots[i]!.intervalDay }));
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

export interface RaceWeekAllocation {
  /** 赛前激活 E（每段 ≤60min 短带上限，余量拆第二段；空=预算装不下/窗口不可用）。 */
  shakes: RaceWeekShake[];
  sumKm: number;
}

/** 比赛周分配：比赛 42.195km + 赛前 1-3 天短 E 激活（C9 豁免窗内、短带上限内）。 */
export function allocateRaceWeek(row: ContentWeekRow, race: ContentGeneratorInput["race"]): RaceWeekAllocation {
  const eMid = easyMidOf(row);
  const raceWd = (new Date(`${race.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const remaining = row.totalKm - 42.195;
  // 激活窗（赛前 1-3 天），偏好赛前 2 天起往前铺
  const windowDays = [raceWd - 2, raceWd - 3, raceWd - 1].filter((wd) => wd >= 0);
  const shakes: RaceWeekShake[] = [];
  let left = remaining;
  for (const wd of windowDays) {
    if (left < 2) break;
    const capMin = E_DURATION_INTERVAL_BAND[1]; // 赛周激活=短 E（①拍板），上限 60min
    const minutes = Math.min((left * eMid) / 60, capMin);
    const seconds = Math.round((minutes * 60) / 30) * 30; // 取整 30s
    shakes.push({ weekday: wd, minutes: seconds / 60 });
    left -= seconds / eMid;
  }
  // 未铺完的残量（窗口耗尽）由 C1 容差吸收；Σ 按 30s 取整后的实际处方计
  const sumKm = 42.195 + shakes.reduce((s, x) => s + (x.minutes * 60) / eMid, 0);
  return { shakes, sumKm };
}
