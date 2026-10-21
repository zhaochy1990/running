// 课表详情页 —— 训练 tab「今日安排」卡片点入后的分段详情（run-workout/v1 的
// blocks/steps 与 strength-workout/v1 的 exercises）。数据从统一课表投影
// `GET /api/users/me/plan/sessions`（三源：weekly/custom/watch）按 workout_id
// 取当日行；weekly 源回联周计划补教练备注（与今日卡片同一口径）。
import { estimateWorkoutSeconds, getPlanSessions, getWeeklyPlan } from '../../services/plan';
import { userStore } from '../../store/index';
import { shanghaiWeekStart, shanghaiWeekdayLabel, weekFolderName } from '../../utils/date';
import { fmtDose, fmtDurationShort, fmtKm } from '../../utils/format';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';
import type {
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
  PlanSessionRow,
  WeeklyPlanDetail,
  WorkoutStep,
  WorkoutStepRest,
  WorkoutTarget,
} from '../../types/plan';

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

interface SegmentRowVM {
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
interface SegmentGroupVM {
  key: string;
  repeat: number;
  rows: SegmentRowVM[];
}

interface ExerciseRowVM {
  key: string;
  name: string;
  /** `3 组 × 12 次` / `3 组 × 45 秒` */
  target: string;
  /** `组间休息 60 秒`，0 为空 */
  rest: string;
  note: string;
}

interface WorkoutDetailHeaderVM {
  name: string;
  /** 课表类型 chip（启发式推导，仅装饰：间歇/节奏/变速/有氧/渐进/长距离/力量） */
  typeChip: string;
  /** 来源标记：weekly 不标，custom「自建」，watch「手表」 */
  sourceLabel: string;
  /** `10月20日 周二` */
  dateLabel: string;
  summary: string;
  iconPath: string;
}

interface WorkoutDetailPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  /** loading：请求中；ready：已渲染；notfound：行不存在/已删除；error：请求失败 */
  loadState: 'loading' | 'ready' | 'notfound' | 'error';
  header: WorkoutDetailHeaderVM;
  stats: Array<{ value: string; label: string }>;
  runGroups: SegmentGroupVM[];
  exercises: ExerciseRowVM[];
  /** 课表内容自带备注（spec.note） */
  specNote: string;
  /** 教练备注（weekly 源回联周计划，custom/watch 源为空） */
  coachNote: string;
}

interface WorkoutDetailPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBack(): void;
  onRetryTap(): void;
  load(): Promise<void>;
  /** 拉到统一课表行后构建视图模型（render 是 Page 实例保留名，故用 applyRow）。 */
  applyRow(row: PlanSessionRow): Promise<void>;
}

// 页面入参（onLoad query）；retry 复用。
let queryDate = '';
let queryWorkoutId = '';
let userId = '';

// 步类型配色沿用赛季总览页阶段色语义（热身绿/主课粉/恢复蓝/冷身紫/休息灰）；
// 休息行为 quiet（空心标签、次要色文字），见原型 workout-detail-types-spike。
const STEP_KIND_META: Record<string, { label: string; color: string; quiet?: boolean }> = {
  warmup: { label: '热身', color: '#7ac9a3' },
  work: { label: '主课', color: '#ff6363' },
  recovery: { label: '恢复', color: '#6db3cf' },
  cooldown: { label: '冷身', color: '#b395d6' },
  rest: { label: '休息', color: '#9c9c9d', quiet: true },
};

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
  let width = 375;
  try {
    const win = wx.getWindowInfo();
    statusPx = win.statusBarHeight;
    width = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    statusPx = sys.statusBarHeight;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

// ---------------------------------------------------------------------------
// 分段文案格式化（配速/目标口径与今日卡片一致）
// ---------------------------------------------------------------------------

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

function buildRunGroups(spec: NormalizedRunWorkout): SegmentGroupVM[] {
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

function buildExerciseRows(spec: NormalizedStrengthWorkout): ExerciseRowVM[] {
  return spec.exercises.map((ex, i) => ({
    key: `e${i}`,
    name: ex.display_name || ex.canonical_id,
    target: `${ex.sets} 组 × ${ex.target_kind === 'reps' ? `${ex.target_value} 次` : fmtClock(ex.target_value)}`,
    rest: ex.rest_seconds > 0 ? `组间休息 ${ex.rest_seconds} 秒` : '',
    note: (ex.note || '').trim(),
  }));
}

/**
 * 课表类型 chip（启发式，仅装饰；课名仍是权威描述）。优先级：
 * 力量 → 间歇（距离制重复）→ 节奏（≥4 分钟时长重复）→ 变速（其余重复）
 * → 长距离（总量 ≥15 km）→ 渐进（多主课逐段提速）→ 有氧（其余跑课）。
 */
function deriveWorkoutType(row: PlanSessionRow): string {
  if (row.kind === 'strength') return '力量';
  if (row.kind !== 'run' || row.spec == null || !('blocks' in row.spec)) return '';
  const blocks = row.spec.blocks;
  let hasDistanceRepeat = false;
  let hasLongTimeRepeat = false;
  let hasTimeRepeat = false;
  let singleWorkCount = 0;
  let fastening = true;
  let prevPaceMid: number | null = null;
  let totalKm = row.total_distance_m != null && row.total_distance_m > 0 ? row.total_distance_m / 1000 : 0;
  if (totalKm === 0) {
    for (const block of blocks) {
      for (const step of block.steps) {
        if (step.duration.kind === 'distance_m' && step.duration.value) {
          totalKm += (step.duration.value * Math.max(1, block.repeat)) / 1000;
        }
      }
    }
  }
  for (const block of blocks) {
    for (const step of block.steps) {
      if (step.step_kind !== 'work') continue;
      if (block.repeat > 1) {
        if (step.duration.kind === 'distance_m') {
          hasDistanceRepeat = true;
        } else {
          hasTimeRepeat = true;
          if (step.duration.kind === 'time_s' && (step.duration.value ?? 0) >= 240) {
            hasLongTimeRepeat = true;
          }
        }
      } else {
        singleWorkCount += 1;
        const t = step.target;
        const mid = t && t.kind === 'pace_s_km' && t.low != null && t.high != null
          ? (t.low + t.high) / 2
          : null;
        if (mid != null) {
          // 配速值变小 = 变快；多主课逐段提速视为渐进。
          if (prevPaceMid != null && mid > prevPaceMid + 1) fastening = false;
          prevPaceMid = mid;
        }
      }
    }
  }
  if (hasDistanceRepeat) return '间歇';
  if (hasLongTimeRepeat) return '节奏';
  if (hasTimeRepeat) return '变速';
  if (totalKm >= 15) return '长距离';
  if (singleWorkCount >= 2 && fastening) return '渐进';
  return '有氧';
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

Page<WorkoutDetailPageData, WorkoutDetailPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loadState: 'loading',
    header: { name: '', typeChip: '', sourceLabel: '', dateLabel: '', summary: '', iconPath: '' },
    stats: [],
    runGroups: [],
    exercises: [],
    specNote: '',
    coachNote: '',
  },

  onLoad(query) {
    queryDate = query.date || '';
    queryWorkoutId = query.workoutId || '';
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      // 标题先用列表页传来的名称占位，拉到行后再用行数据覆盖。
      header: { ...this.data.header, name: decodeURIComponent(query.title || '') || '课表详情' },    });

    userStore.waitForAuth().then(() => {
      const { user, isAuthenticated } = userStore.getState();
      if (!isAuthenticated || !user) {
        wx.reLaunch({ url: '/pages/login/login' });
        return;
      }
      userId = user.id;
      this.load();
    });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },

  onRetryTap() {
    this.setData({ loadState: 'loading' });
    this.load();
  },

  async load() {
    if (!queryDate || !queryWorkoutId) {
      this.setData({ loadState: 'notfound' });
      return;
    }
    try {
      const res = await getPlanSessions(userId, queryDate, queryDate);
      const row = (res.sessions ?? []).find((r) => r.workout_id === queryWorkoutId) ?? null;
      if (!row) {
        this.setData({ loadState: 'notfound' });
        return;
      }
      await this.applyRow(row);
      this.setData({ loadState: 'ready' });
    } catch {
      this.setData({ loadState: 'error' });
    }
  },

  async applyRow(row: PlanSessionRow) {
    const isRun = row.kind === 'run' && row.spec != null && 'blocks' in row.spec;
    const isStrength = row.kind === 'strength' && row.spec != null && 'exercises' in row.spec;
    const dateLabel = `${Number(row.date.slice(5, 7))}月${Number(row.date.slice(8))}日 ${shanghaiWeekdayLabel(row.date)}`;

    // 总时长：落库值优先；custom 课常缺，用配速中值估时兜底（与今日卡片同一口径）。
    // 力量课不做估时兜底（estimate 口径仅跑课），缺失时展示 —。
    const totalDurationText = isRun
      ? row.total_duration_s != null
        ? fmtDurationShort(row.total_duration_s)
        : fmtDurationShort(estimateWorkoutSeconds((row.spec as NormalizedRunWorkout).blocks))
      : row.total_duration_s != null
        ? fmtDurationShort(row.total_duration_s)
        : '—';

    const exercises = isStrength ? buildExerciseRows(row.spec as NormalizedStrengthWorkout) : [];
    // 指标行按课表类型换口径（原型定稿）：跑课=距离/时长/负荷，力量=时长/动作数/总组数。
    const stats = isStrength
      ? [
          { value: totalDurationText, label: '预计时长' },
          { value: `${exercises.length} 个`, label: '动作' },
          {
            value: `${(row.spec as NormalizedStrengthWorkout).exercises.reduce((sum, ex) => sum + ex.sets, 0)} 组`,
            label: '总组数',
          },
        ]
      : [
          { value: fmtKm(row.total_distance_m), label: '距离(公里)' },
          { value: totalDurationText, label: '总时长' },
          { value: fmtDose(row.estimated_dose), label: '训练负荷' },
        ];

    this.setData({
      header: {
        name: row.name || row.summary || '训练',
        typeChip: deriveWorkoutType(row),
        sourceLabel: row.source === 'custom' ? '自建' : row.source === 'watch' ? '手表' : '',
        dateLabel,
        summary: row.summary || '',
        iconPath:
          row.kind === 'strength'
            ? '/assets/icons/fitness_center.svg'
            : '/assets/icons/directions_run.svg',
      },
      stats,
      runGroups: isRun ? buildRunGroups(row.spec as NormalizedRunWorkout) : [],
      exercises,
      specNote: isRun ? (row.spec as NormalizedRunWorkout).note || '' : '',
    });

    // 教练备注：weekly 源回联周计划（session notes_md 优先，退回计划级备注）。
    if (row.source === 'weekly') {
      try {
        const plan: WeeklyPlanDetail = await getWeeklyPlan(
          userId,
          weekFolderName(shanghaiWeekStart(row.date)),
        );
        const content =
          typeof plan.content === 'object' && plan.content !== null
            ? (plan.content as { sessions?: Array<{ date: string; session_index: number; notes_md: string | null }>; coach_notes?: string | null; notes_md?: string | null })
            : null;
        const sessionNote =
          row.session_index != null
            ? content?.sessions?.find(
                (s) => s.date === row.date && s.session_index === row.session_index,
              )?.notes_md
            : null;
        this.setData({
          coachNote: firstLine(sessionNote) || firstLine(content?.coach_notes) || firstLine(content?.notes_md),
        });
      } catch {
        // 周计划拉取失败不挡详情渲染，备注留空。
      }
    }
  },
});
