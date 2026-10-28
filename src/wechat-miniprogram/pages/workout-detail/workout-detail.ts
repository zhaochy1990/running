// 课表详情页 —— 训练 tab「今日安排」卡片点入后的分段详情（run-workout/v1 的
// blocks/steps 与 strength-workout/v1 的 exercises）。数据从统一课表投影
// `GET /api/users/me/plan/sessions`（三源：weekly/custom/watch）按 workout_id
// 取当日行；weekly 源回联周计划补教练备注（与今日卡片同一口径）。
import { estimateWorkoutSeconds, getPlanSessions, getWeeklyPlan } from '../../services/plan';
import { userStore } from '../../store/index';
import { shanghaiWeekStart, shanghaiWeekdayLabel, weekFolderName } from '../../utils/date';
import { fmtDose, fmtDurationShort, fmtKm } from '../../utils/format';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';
import { theme, themeRgba } from '../../utils/theme';
import type {
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
  PlanSessionRow,
  WeeklyPlanDetail,
} from '../../types/plan';
import {
  buildExerciseRows,
  buildRunGroups,
  type ExerciseRowVM,
  type SegmentGroupVM,
} from '../../utils/workoutSegments';

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

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
  /** 栈深>1 顶栏显示返回箭头；=1（冷开分享卡直达）显示回主页的小房子 */
  canBack: boolean;
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
  /** 自建课才出分享 pill（weekly/watch 保持品牌默认分享卡，#704） */
  canShare: boolean;
}

interface WorkoutDetailPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBack(): void;
  onRetryTap(): void;
  load(): Promise<void>;
  /** 拉到统一课表行后构建视图模型（render 是 Page 实例保留名，故用 applyRow）。 */
  applyRow(row: PlanSessionRow): Promise<void>;
  /** 分享卡封面：canvas 深色卡预生成 → 临时文件缓存（onShareAppMessage 同步取）。 */
  renderShareCover(): void;

  /** canvas 生成的封面临时文件路径；空 = 未生成/失败，分享回落默认截图。 */
  _shareCover: string;
}

// 页面入参（onLoad query）；retry 复用。
let queryDate = '';
let queryWorkoutId = '';
let userId = '';

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
// 分段文案格式化：已抽到 utils/workoutSegments（workout-share 分享落地页共用）
// ---------------------------------------------------------------------------

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
  _shareCover: '',

  // 自建课定制分享卡（#704）：title=课名，path=免登录落地页。path 同步纯拼接、
  // 零网络请求（平台不支持异步返回，#690 实证）；封面用预生成缓存，取不到
  // （未生成/失败）时省略 imageUrl 回落默认截图。
  onShareAppMessage() {
    if (this.data.canShare && userId && queryWorkoutId) {
      return {
        title: this.data.header.name || '训练课表',
        path: `/pages/workout-share/workout-share?user=${userId}&workout=${queryWorkoutId}`,
        imageUrl: this._shareCover || undefined,
      };
    }
    return defaultShareAppMessage();
  },
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    canBack: false,
    contentPaddingTop: 232,
    loadState: 'loading',
    header: { name: '', typeChip: '', sourceLabel: '', dateLabel: '', summary: '', iconPath: '' },
    stats: [],
    runGroups: [],
    exercises: [],
    specNote: '',
    coachNote: '',
    canShare: false,
  },

  onLoad(query) {
    queryDate = query.date || '';
    queryWorkoutId = query.workoutId || '';
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
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
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
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
      canShare: row.source === 'custom',
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

    // 封面异步预生成（onLoad 后拿到行数据即绘，分享时同步取缓存，不挤分享 3 秒预算）。
    if (row.source === 'custom') this.renderShareCover();

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

  /** 分享卡封面（#704，站④定稿）：深色底 + 课名 + 前两项指标色块，绘制同
   * strategy 配速卡（canvas 2d → canvasToTempFilePath）。失败静默：分享回落
   * 微信默认截图。 */
  renderShareCover() {
    const name = this.data.header.name;
    const stats = this.data.stats;
    const query = wx.createSelectorQuery().in(this as never);
    query
      .select('#share-cover')
      .fields({ node: true, size: true }, (res) => {
        const canvas = res?.node;
        if (!canvas) return;
        const width = 500;
        const height = 400;
        const dpr = 2;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext('2d') as unknown as CoverCtx;
        ctx.scale(dpr, dpr);
        drawShareCover(ctx, width, height, name, stats);
        wx.canvasToTempFilePath({
          canvas,
          success: (out) => {
            this._shareCover = out.tempFilePath;
          },
        });
      })
      .exec();
  },
});

/** 分享封面 canvas 2d 上下文的最小结构（同 strategy PosterCtx）。 */
interface CoverCtx {
  fillStyle: string;
  font: string;
  scale(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** 深色分享封面：藕粉顶线 + 品牌 label + 课名（最多两行）+ 两指标色块。 */
function drawShareCover(
  ctx: CoverCtx,
  width: number,
  height: number,
  name: string,
  stats: Array<{ value: string; label: string }>,
): void {
  ctx.fillStyle = '#0a0a0b';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, width, 6);

  ctx.fillStyle = theme.textMuted;
  ctx.font = '20px sans-serif';
  ctx.fillText('砺跑 · 自建课表', 36, 58);

  ctx.fillStyle = '#f2f2f3';
  ctx.font = 'bold 40px sans-serif';
  // 课名超宽换行，最多两行（第二行尾部 …）
  const maxW = width - 72;
  const chars = Array.from(name);
  let idx = 0;
  let line1 = '';
  while (idx < chars.length && ctx.measureText(line1 + chars[idx]).width <= maxW) {
    line1 += chars[idx];
    idx += 1;
  }
  let line2 = '';
  if (idx < chars.length) {
    const rest = chars.slice(idx);
    if (ctx.measureText(rest.join('')).width > maxW) {
      while (rest.length && ctx.measureText(`${rest.join('')}…`).width > maxW) rest.pop();
      rest.push('…');
    }
    line2 = rest.join('');
  }
  ctx.fillText(line1, 36, 126);
  if (line2) ctx.fillText(line2, 36, 178);

  // 指标色块：跑课前两项=距离/总时长，力量课=预计时长/动作（与页内 stat 同源）
  const blockW = (width - 72 - 24) / 2;
  const blockY = height - 140;
  ctx.fillStyle = themeRgba(theme.accentRgb, 0.12);
  ctx.fillRect(36, blockY, blockW, 104);
  ctx.fillRect(36 + blockW + 24, blockY, blockW, 104);
  for (let i = 0; i < 2 && i < stats.length; i++) {
    const x = 36 + i * (blockW + 24);
    ctx.fillStyle = '#ff9d9a';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText(stats[i].value, x + 24, blockY + 58);
    ctx.fillStyle = theme.textMuted;
    ctx.font = '20px sans-serif';
    ctx.fillText(stats[i].label, x + 24, blockY + 88);
  }
}
