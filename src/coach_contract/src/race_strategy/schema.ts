import { z } from "zod/v4";

/**
 * 比赛策略（Race Strategy）——教练会话的结构化产物，展示契约见 #385 定稿：
 * 目标成绩 + 分段配速表（分段/本段配速/本段用时/累计用时/说明五列，生成时
 * 用时=距离×配速自动算）+ 逐行补给（时间点｜内容）+ 赛道与天气提示。
 * 教练生成初稿，分段与补给用户可在报告页手动编辑；再聊一轮=更新版本
 * （race_strategy 表 UNIQUE(user, event) 只留最新版）。
 */

/** 分段配速表一行（五列 + 供「用时=距离×配速」自动计算的距离列）。 */
export const RacePaceSegmentSchema = z.object({
  /** 分段名，如 "0–10 km" / "30–35 km"。 */
  segment: z.string().min(1),
  /** 本段距离（km）；未知为 null，客户端用它把配速换算成本段用时。 */
  distance_km: z.number().positive().nullish(),
  /** 本段配速，人类可读形式，如 "5:40/km"。 */
  pace: z.string().min(1),
  /** 本段用时，如 "56:40"；生成时由距离×配速自动算出。 */
  segment_time: z.string().min(1),
  /** 累计用时（含本段），如 "56:40"。 */
  cumulative_time: z.string().min(1),
  /** 说明：本段意图（稳住/进站/顶坡……）。 */
  note: z.string(),
});

/** 补给计划一行：时间点｜内容。 */
export const RaceFuelingItemSchema = z.object({
  /** 时间点，如 "赛前 30 分钟" / "12 km 处"。 */
  time_point: z.string().min(1),
  /** 内容，如 "能量胶 1 支 + 电解质水"。 */
  content: z.string().min(1),
});

export const RaceStrategySchema = z
  .object({
    race_name: z.string().min(1),
    /** 报名项目 racetypes token（与 race_calendar_item.type 同词汇），如 Marathon。 */
    item_type: z.string().min(1),
    /** 目标完赛时间 h:mm:ss，如 "3:59:59"。 */
    target_finish_time: z.string().regex(/^\d{1,2}:\d{2}:\d{2}$/),
    /** 策略总述（1–3 句：总方针 + 正负配速取舍）。 */
    summary: z.string().min(1),
    pace_segments: z.array(RacePaceSegmentSchema).min(1),
    fueling_plan: z.array(RaceFuelingItemSchema),
    /** 赛道提示（难点/爬升/折返，来自赛事内容）。 */
    course_tips: z.array(z.string()),
    /** 天气提示（赛期气候/着装/补水口径）。 */
    weather_tips: z.array(z.string()),
    /** 依据声明：用了哪些数据、哪些缺口（依据不足时由教练声明，缺项不臆测）。 */
    basis_note: z.string(),
  })
  .superRefine((strategy, ctx) => {
    // 模型算术不可靠，累计一致性是确定性校验（可解析的行才检查；文本口径
    // 的宽容由报告页 recomputePaceTimes 兜底）。末段累计与目标差 > 60s 视为不自洽。
    const target = parseHms(strategy.target_finish_time);
    if (target === null) return;
    let cumulative = 0;
    let computable = false;
    for (const seg of strategy.pace_segments) {
      const pace = parsePace(seg.pace);
      if (seg.distance_km != null && pace !== null) {
        cumulative += seg.distance_km * pace;
        computable = true;
      }
    }
    if (computable && Math.abs(cumulative - target) > 60) {
      ctx.addIssue({
        code: "custom",
        path: ["pace_segments"],
        message: `cumulative time ${formatHms(cumulative)} deviates from target ${strategy.target_finish_time} by more than 60s`,
      });
    }
  });

function parseHms(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function parsePace(value: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)(?:\/\s*km)?$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function formatHms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export type RaceStrategy = z.infer<typeof RaceStrategySchema>;
export type RacePaceSegment = z.infer<typeof RacePaceSegmentSchema>;
export type RaceFuelingItem = z.infer<typeof RaceFuelingItemSchema>;

/** 会话直出信封（与 master plan 同形）：子代理最终结构化输出。 */
export const RaceStrategyDirectResponseSchema = z.object({
  disposition: z.literal("return_direct"),
  content: RaceStrategySchema,
});
