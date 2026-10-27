import { normalizeRunWorkout, type RunWorkout } from "@stride/contract";
import { z } from "zod/v4";

/**
 * E2E 样本迁移器（devops#807 D 节）：spike 七值段格式（l4-e2e-shanghai.json，
 * #796 spike 已判绿的产出）→ run-workout/v1 机械转换。纯结构映射零判断——
 * 同时验证 V1 能无损表达 spike 产出；原始 km 作为期望里程随行（供 C8 展开守恒）。
 */

const SpikeSegmentSchema = z.object({
  kind: z.enum(["warmup", "work", "main", "recovery", "rest", "cooldown", "strides"]),
  distance_m: z.number().positive().nullish(),
  time_s: z.number().positive().nullish(),
  pace_s_km_min: z.number().positive().nullish(),
  pace_s_km_max: z.number().positive().nullish(),
});

const SpikeSessionSchema = z.object({
  day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
  type: z.enum(["E", "M", "T", "I", "R", "LR"]),
  name: z.string().min(1),
  km: z.number().positive(),
  segments: z.array(SpikeSegmentSchema).min(1),
  note: z.string().nullish(),
});

export const SpikeWeekSchema = z.object({
  week_no: z.number().int().positive(),
  sessions: z.array(SpikeSessionSchema).min(1),
});
export type SpikeSession = z.infer<typeof SpikeSessionSchema>;
export type SpikeWeek = z.infer<typeof SpikeWeekSchema>;

const DAY_INDEX: Record<SpikeSession["day"], number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** 周一锚点 + day 偏移 → ISO date（date 由迁移器/未来 L5 填，周内位置从 date 派生）。 */
function dateOf(weekStartMonday: string, day: SpikeSession["day"]): string {
  const d = new Date(`${weekStartMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + DAY_INDEX[day]);
  return d.toISOString().slice(0, 10);
}

/** purpose 按 type 生成（迁移器机械模板；生产由生成层写实义文案）。 */
function purposeOf(session: SpikeSession): string {
  const hasWork = session.segments.some((g) => g.kind === "work");
  const hasStrides = session.segments.some((g) => g.kind === "strides");
  switch (session.type) {
    case "E":
      return `有氧轻松课：E 配速巩固有氧地基${hasStrides ? "，快步跑保持速度触感" : ""}`;
    case "M":
      return "马配专项课：M 配速演练比赛节奏，专项耐力核心刺激";
    case "T":
      return "阈值课：T 配速提升乳酸阈值，马拉松配速耐受力基础";
    case "I":
      return "间歇课：I 配速刺激 VO2max，扩大有氧容量";
    case "R":
      return "重复课：R 配速发展速度与跑姿经济性";
    case "LR":
      return `长跑课：E 配速为主积累耐力${hasWork ? "，尾段质量刺激强化马配下的持久力" : ""}`;
  }
}

/** 单节迁移：main/strides→work（easy run body / 短加速步 open target）、其余 kind 直映。 */
export function migrateSpikeSession(session: SpikeSession, date: string): RunWorkout {
  const steps = session.segments.map((seg, i) => {
    const step_kind = seg.kind === "main" || seg.kind === "strides" ? "work" : seg.kind;
    let duration: RunWorkout["blocks"][number]["steps"][number]["duration"];
    if (seg.distance_m != null && seg.time_s != null) throw new Error(`segment ${i} 同时带 distance/time，机械迁移不猜`);
    if (seg.distance_m != null) duration = { kind: "distance_m", value: seg.distance_m };
    else if (seg.time_s != null) duration = { kind: "time_s", value: seg.time_s };
    else throw new Error(`segment ${i} 无 distance/time，机械迁移不猜`);
    let target: RunWorkout["blocks"][number]["steps"][number]["target"];
    if (seg.pace_s_km_min != null && seg.pace_s_km_max != null) target = { kind: "pace_s_km", low: seg.pace_s_km_min, high: seg.pace_s_km_max };
    else if (seg.pace_s_km_min == null && seg.pace_s_km_max == null) target = { kind: "open", low: null, high: null };
    else throw new Error(`segment ${i} 配速区间半空，机械迁移不猜`);
    return { step_kind, duration, target, note: null, hr_cap_bpm: null };
  });
  return normalizeRunWorkout({
    schema: "run-workout/v1",
    name: session.name,
    date,
    note: session.note ?? null,
    type: session.type,
    purpose: purposeOf(session),
    blocks: [{ repeat: 1, steps }],
  });
}

export interface MigratedSession {
  workout: RunWorkout;
  /** 原始课里程（spike km）——C8 展开守恒的期望锚。 */
  expectedKm: number;
}

/** 整周迁移。weekStartMonday=该周周一 ISO date；返回按 sessions 顺序。 */
export function migrateSpikeWeek(week: SpikeWeek, weekStartMonday: string): MigratedSession[] {
  return week.sessions.map((session) => ({
    workout: migrateSpikeSession(session, dateOf(weekStartMonday, session.day)),
    expectedKm: session.km,
  }));
}
