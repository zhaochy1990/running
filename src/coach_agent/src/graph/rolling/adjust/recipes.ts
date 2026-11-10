/**
 * 调整配方引擎（#858 PR-C，纯函数）：追问原因 → 投影参数映射。五条配方按
 * 票面定稿逐字落（guidance 是 L4a 的周调整指令，注入 prompt 的该周课描述
 * 段——语义不许走样）；injured 不走本引擎（PR-D 伤病模式接管），recipeFor
 * 明确 unsupported → 抛错给调用方（worker 转 permanent error）。
 *
 * 配方只在调整投影（runAdjustProjection）内生效：
 * - vdotShift：projectZones 调用处偏移（配速放缓一档=VDOT −1）。
 * - qualityCap：批行构造处覆写 qualitySessions 上限（保课数）。
 * - kmDerateFirstWeek：窗口首周 totalKm 降载系数（骨架与行同步，周文档
 *   target km 同源生效）。
 * - guidance：ContentWeekRow.guidance → L4a payload 的 adjust_guidance。
 */
import type { AskReason } from "../detect/detector.js";

/** 原因→投影参数（reason 实写 AskReason；injured 在 recipeFor 拦截，不进表）。 */
export interface AdjustRecipe {
  reason: AskReason;
  /** 配速档位偏移（pace_unmet: −1，配速按最新状态放缓一档）。 */
  vdotShift?: number;
  /** 质量课配额上限（no_time: 1，保一节质量课）。 */
  qualityCap?: 1 | 2;
  /** 窗口首周周量降载系数（over_delivered: 0.75，下周降载消化）。 */
  kmDerateFirstWeek?: number;
  /** 注入 L4a 的周指导语（中文，票面配方语义逐字落）。 */
  guidance: string;
}

/** 配方表（五条 supported；injured 不在表内=unsupported）。 */
const RECIPES: Record<Exclude<AskReason, "injured">, AdjustRecipe> = {
  pace_unmet: {
    reason: "pace_unmet",
    vdotShift: -1,
    guidance: "配速按最新状态放缓一档；强度课降档：I 课改 T 或缩组；量不变；动作重复不进阶",
  },
  volume_unmet: {
    reason: "volume_unmet",
    guidance: "量回退到实际承受位；质量课保 2 节但内容减一档（组数-1）；长跑回退",
  },
  no_time: {
    reason: "no_time",
    qualityCap: 1,
    guidance: "保 1 节质量课+长跑；E 量先砍；坚决不追补落下的公里数",
  },
  ran_other: {
    reason: "ran_other",
    guidance: "用户自行完成的训练（比赛/团练/自练间歇）当作已完成的训练吸收，不补课不叠加；后续绕开；大课后加恢复偏置",
  },
  over_delivered: {
    reason: "over_delivered",
    kmDerateFirstWeek: 0.75,
    guidance: "下周降载消化（×0.75），质量课量减半恢复",
  },
};

/**
 * 原因 → 配方（表驱动）。injured unsupported：本引擎（调整投影）不处理伤病
 * ——PR-D 伤病模式接管；此处抛错，调用方（worker handler / e2e 脚本）转
 * permanent error / 断言失败，不静默降级。
 */
export function recipeFor(reason: AskReason): AdjustRecipe {
  if (reason === "injured") {
    throw new Error("adjust recipe unsupported: injured（伤病调整不走本引擎，归 PR-D 伤病模式）");
  }
  return RECIPES[reason];
}
