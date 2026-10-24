// 课表分段渲染视图模型 —— workout-detail 与 workout-share 两个页面共用的
// 定稿渲染语言（devops#703：分享落地页与详情页所见即所得）。跑课 blocks/steps
// → 分段组（repeat>1 骑线 ×N 徽章、步后休息独立行、心率帽），力量课 → 动作行。
// 页面 wxml 结构与样式（.seg/.exercise 系列）保持一致，样式由各页 @import
// workout-detail.wxss 整包复用（strategy-share 同款套路）。
import type {
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
  WorkoutStep,
  WorkoutStepRest,
  WorkoutTarget,
} from '../types/plan';

export interface SegmentRowVM {
  key: string;
  kindLabel: string;
  color: string;
  /** 休息行：空心灰标签 + 次要色文字（执行顺序中的一步，不挤在主课行尾） */
  quiet: boolean;
  /** 主行：`800 m · 4:05–4:15/km`；休息行 `90 秒` / `4:00` */
  main: string;
  /** 步心率上限，如 `心率≤152` */
  hrCapText: string;
  note: string;
}

/** 分段组：repeat>1 时整组带骑线 ×N 徽章。 */
export interface SegmentGroupVM {
  key: string;
  repeat: number;
  rows: SegmentRowVM[];
}

export interface ExerciseRowVM {
  key: string;
  name: string;
  /** `3 组 × 12 次` / `3 组 × 45 秒` */
  target: string;
  /** `组间休息 60 秒`，0 为空 */
  rest: string;
  note: string;
}

// 步类型配色沿用赛季总览页阶段色语义（热身绿/跑步粉/恢复蓝/冷身紫/休息灰）；
// 休息行为 quiet（空心标签、次要色文字），见原型 workout-detail-types-spike。
const STEP_KIND_META: Record<string, { label: string; color: string; quiet?: boolean }> = {
  warmup: { label: '热身', color: '#7ac9a3' },
  work: { label: '跑步', color: '#ff6363' },
  recovery: { label: '恢复', color: '#6db3cf' },
  cooldown: { label: '冷身', color: '#b395d6' },
  rest: { label: '休息', color: '#9c9c9d', quiet: true },
};

/** 秒 → `M:SS`（段时长/休息用，比 fmtHms 的 00:59:40 形态更适合段落行）。 */
function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 配速值 `4:05`（不带 /km 后缀，供区间拼接）。 */
function fmtPaceValue(secondsPerKm: number): string {
  return fmtClock(secondsPerKm);
}

/** 步目标：pace 区间 / 心率区间 / 功率区间 / 体感。 */
function fmtTarget(target: WorkoutTarget): string {
  if (target.kind === 'pace_s_km' && target.low != null && target.high != null) {
    return `${fmtPaceValue(target.low)}–${fmtPaceValue(target.high)}/km`;
  }
  if (target.kind === 'hr_bpm' && target.low != null && target.high != null) {
    return `${target.low}–${target.high} bpm`;
  }
  if (target.kind === 'power_w' && target.low != null && target.high != null) {
    return `${target.low}–${target.high} W`;
  }
  return '体感';
}

/** 步时长：距离段 `800 m` / `14 km`，时长段 `15:00`，open 段不定时长。 */
function fmtStepDuration(step: WorkoutStep): string {
  const d = step.duration;
  if (d.kind === 'distance_m' && d.value != null) {
    if (d.value < 1000) return `${d.value} m`;
    const km = d.value / 1000;
    return Number.isInteger(km) ? `${km} km` : `${km.toFixed(1)} km`;
  }
  if (d.kind === 'time_s' && d.value != null) return fmtClock(d.value);
  return '不定时长';
}

/** 步后休息文案（work 步携带；展开为独立休息行，不挤在主课行尾）。 */
function fmtStepRest(rest: WorkoutStepRest): string {
  if (rest.kind === 'time_s' && rest.value != null) {
    return rest.value < 120 ? `${rest.value} 秒` : fmtClock(rest.value);
  }
  if (rest.kind === 'hr_bpm' && rest.value != null) return `心率降到 ${rest.value} 以下继续`;
  return '休息至手动继续';
}

function restRowVM(key: string): SegmentRowVM {
  return {
    key,
    kindLabel: STEP_KIND_META.rest.label,
    color: STEP_KIND_META.rest.color,
    quiet: true,
    main: '',
    hrCapText: '',
    note: '',
  };
}

export function buildRunGroups(spec: NormalizedRunWorkout): SegmentGroupVM[] {
  return spec.blocks.map((block, bi) => {
    const rows: SegmentRowVM[] = [];
    block.steps.forEach((step, si) => {
      const meta = STEP_KIND_META[step.step_kind] || { label: step.step_kind, color: '#9c9c9d' };
      rows.push({
        key: `s${bi}-${si}`,
        kindLabel: meta.label,
        color: meta.color,
        quiet: meta.quiet === true,
        main: `${fmtStepDuration(step)} · ${fmtTarget(step.target)}`,
        hrCapText: step.hr_cap_bpm != null ? `心率≤${step.hr_cap_bpm}` : '',
        note: (step.note || '').trim(),
      });
      // 步后休息第一公民（devops#520 D2 idiom）：展开为独立休息行。
      if (step.rest) {
        const rest = restRowVM(`s${bi}-${si}-rest`);
        rest.main = fmtStepRest(step.rest);
        rows.push(rest);
      }
    });
    return {
      key: `b${bi}`,
      repeat: block.repeat,
      rows,
    };
  });
}

export function buildExerciseRows(spec: NormalizedStrengthWorkout): ExerciseRowVM[] {
  return spec.exercises.map((ex, i) => ({
    key: `e${i}`,
    name: ex.display_name || ex.canonical_id,
    target: `${ex.sets} 组 × ${ex.target_kind === 'reps' ? `${ex.target_value} 次` : fmtClock(ex.target_value)}`,
    rest: ex.rest_seconds > 0 ? `组间休息 ${ex.rest_seconds} 秒` : '',
    note: (ex.note || '').trim(),
  }));
}
