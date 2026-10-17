import type { RunWorkout, StepRest, WorkoutStep, WorkoutTarget } from "./schema.js";

/**
 * 确定性渲染：同一个 workout 文档永远得到同一个字符串（golden 测试钉死）。
 * 双休息 idiom 渲染等价——block 尾部 rest step 折叠成（休X），与 step.rest
 * 字段的输出完全一致。
 */

/** 秒/km → "M:SS"（如 230 → "3:50"）。 */
export function formatPaceSecKm(secPerKm: number): string {
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 秒 → "X′"（整分钟）/ "N″"（其余，如 90″）。 */
export function formatDurationSec(sec: number): string {
  const total = Math.round(sec);
  return total % 60 === 0 ? `${total / 60}′` : `${total}″`;
}

function formatDistanceM(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  const km = Number((meters / 1000).toFixed(3));
  return `${km}km`;
}

function formatRange(low: number, high: number, format: (value: number) => string, unit: string): string {
  return `${format(Math.min(low, high))}–${format(Math.max(low, high))}${unit}`;
}

function formatTarget(target: WorkoutTarget): string | null {
  switch (target.kind) {
    case "open":
      return null;
    case "pace_s_km":
      return formatRange(target.low, target.high, formatPaceSecKm, "/km");
    case "hr_bpm":
      return formatRange(target.low, target.high, (v) => `${Math.round(v)}`, "bpm");
    case "power_w":
      return formatRange(target.low, target.high, (v) => `${Math.round(v)}`, "W");
    case "cadence_spm":
      return formatRange(target.low, target.high, (v) => `${Math.round(v)}`, "spm");
  }
}

/** （休3′）/（休90″）/（休至HR<130）/（休手动）。 */
export function formatStepRest(rest: StepRest): string {
  if (rest.kind === "manual") return "（休手动）";
  if (rest.kind === "hr_bpm") return `（休至HR<${Math.round(rest.value)}）`;
  return `（休${formatDurationSec(rest.value)}）`;
}

function formatStep(step: WorkoutStep, inlineRest: boolean): string {
  const duration =
    step.duration.kind === "open" ? "open" : step.duration.kind === "time_s" ? formatDurationSec(step.duration.value) : formatDistanceM(step.duration.value);
  const target = formatTarget(step.target);
  let text = target === null ? duration : `${duration} @ ${target}`;
  if (step.hr_cap_bpm !== null) text += `，HR≤${step.hr_cap_bpm}`;
  // 末步的休息由 block 级折叠统一输出（双 idiom 等价），避免重复渲染。
  if (inlineRest && step.rest !== undefined) text += formatStepRest(step.rest);
  return text;
}

/** 拆出可渲染步与块尾休息：末步是 rest step 时折叠其时长（与 rest 字段并存时
 * rest step 优先），否则末 step 的 rest 字段就是块尾休息；中部 step 原样渲染。 */
function splitBlock(block: RunWorkout["blocks"][number]): { steps: WorkoutStep[]; rest: StepRest | null } {
  const last = block.steps.at(-1);
  if (last === undefined) return { steps: [], rest: null };
  if (last.step_kind === "rest") {
    return {
      steps: block.steps.slice(0, -1),
      rest: last.duration.kind === "time_s" ? { kind: "time_s", value: last.duration.value } : { kind: "manual", value: null },
    };
  }
  return { steps: block.steps, rest: last.rest ?? null };
}

function formatBlockSummary(block: RunWorkout["blocks"][number]): string {
  const { steps, rest } = splitBlock(block);
  const joined = steps.map((step, index) => formatStep(step, index < steps.length - 1)).join(block.repeat > 1 ? "+" : "→");
  const restText = rest === null ? "" : formatStepRest(rest);
  return `${block.repeat > 1 ? `${block.repeat}×` : ""}${joined}${restText}`;
}

/** "3×4km @ 3:50–4:00/km（休3′） ＋ 6×400m @ 3:25–3:35/km（休90″）" 式压缩文案。 */
export function renderRunWorkoutSummary(workout: RunWorkout): string {
  return workout.blocks.map(formatBlockSummary).join(" ＋ ");
}

/** block 分组多行详情；repeat>1 的块首行带 N× 前缀。 */
export function renderRunWorkoutDetail(workout: RunWorkout): string {
  const lines: string[] = [];
  for (const block of workout.blocks) {
    const { steps, rest } = splitBlock(block);
    steps.forEach((step, index) => {
      const prefix = index === 0 && block.repeat > 1 ? `${block.repeat}× ` : "";
      const suffix = index === steps.length - 1 && rest !== null ? formatStepRest(rest) : "";
      lines.push(`${prefix}${formatStep(step, index < steps.length - 1)}${suffix}`);
    });
  }
  return lines.join("\n");
}
