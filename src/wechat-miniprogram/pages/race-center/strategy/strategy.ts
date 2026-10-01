// 比赛策略报告页 —— #396。同一场比赛按目标成绩多版本（如 2:55 一版、2:50
// 一版，目标最快在前）：hero 下版本 pills 切换，编辑/应用/删除都以当前选中
// 版本的目标为键。两种进入形态：
//   已保存：GET race_strategies 渲染全部版本（?target= 指定初始选中，默认
//     最近更新的那版），编辑经 hero 区保存（PUT 按目标键控覆盖该版）。
//   草稿（draft）：教练聊天卡片 tap 时经 setPendingStrategyDraft 交接的初稿，
//     本地渲染（编辑同样可用），底部「应用并保存」= PUT 落库为该目标版本。
// 五列配速表（配速/说明可编辑，用时=距离×配速自动算）+ 逐行补给（可增删）+
// 赛道/天气提示；hero 次要「分享」（onShareAppMessage）与「配速卡」（canvas
// 海报）；「设为目标」以 race_goal 预填确认。视图变换在 utils/raceStrategyRows。

import { ApiError } from '../../../services/request';
import { getRaceDetail, type RaceDetail } from '../../../services/race-center';
import {
  deleteRaceStrategy,
  getRaceStrategies,
  latestStrategyVersion,
  postTrainingGoal,
  saveRaceStrategy,
  takePendingStrategyDraft,
  type RaceStrategy,
  type RaceStrategyVersion,
} from '../../../services/race-strategy';
import {
  fromStrategyView,
  goalPrefill,
  raceDayLabel,
  strategyShareTitle,
  toStrategyView,
  type StrategyView,
} from '../../../utils/raceStrategyRows';
import { setPendingCoachContext } from '../../../services/coach';
import { shanghaiDateFromIso, shanghaiTimeFromIso } from '../../../utils/date';
import { userStore } from '../../../store/index';

const GOAL_DAYS = [3, 4, 5, 6];

interface StrategyPageData {
  statusBarHeight: number;
  loading: boolean;
  /** 非空时整页错误条（未生成/不存在/网络失败） */
  error: string;
  view: StrategyView | null;
  raceDayText: string;
  /** 版本切换 pills（非草稿且有已保存版本时显示）；active 为当前选中目标。 */
  versions: Array<{ target: string; active: boolean }>;
  /** 草稿模式：教练聊天卡片交接的初稿，未落库（底部「应用并保存」）。 */
  draft: boolean;
  dirty: boolean;
  saving: boolean;
  applying: boolean;
  deleting: boolean;
  updatedAtText: string;
  goalAvailable: boolean;
  goalSheetOpen: boolean;
  goalSheetRows: Array<{ k: string; v: string }>;
  goalDays: number[];
  goalDayIndex: number;
  goalPending: boolean;
}

interface StrategyPageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  refresh(): Promise<void>;
  /** 把选中版本落到页面数据：视图 + pills + 保存态时间戳。 */
  applyVersion(version: RaceStrategyVersion, versions: RaceStrategyVersion[], detail: RaceDetail): void;
  /** 版本 pill 切换：纯内存换视图（有未保存修改时先确认丢弃）。 */
  onVersionTap(e: WechatMiniprogram.TouchEvent): void;
  patchPaceRow(index: number, patch: Partial<StrategyView['paceRows'][number]>): void;
  patchFuelingRow(index: number, patch: Partial<StrategyView['fuelingRows'][number]>): void;
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onBack(): void;
  onCoachTap(): void;
  onPaceBlur(e: WechatMiniprogram.InputBlur): void;
  onNoteBlur(e: WechatMiniprogram.InputBlur): void;
  onFuelingWhenBlur(e: WechatMiniprogram.InputBlur): void;
  onFuelingWhatBlur(e: WechatMiniprogram.InputBlur): void;
  onFuelingAdd(): void;
  onFuelingRemove(e: WechatMiniprogram.TouchEvent): void;
  onSaveTap(): void;
  /** 草稿模式底部主按钮：PUT 落库并转已保存态（刷新出全部版本）。 */
  onApplyTap(): void;
  /** 删除当前选中的目标版本（其它版本不动）。 */
  onDeleteTap(): void;
  deleteActiveVersion(target: string): Promise<void>;
  onPosterTap(): void;
  onGoalTap(): void;
  onGoalSheetClose(): void;
  onGoalDayChange(e: WechatMiniprogram.PickerChange): void;
  onGoalConfirm(): void;
  _raceId: number;
  _detail: RaceDetail | null;
  _base: RaceStrategy | null;
  /** 草稿模式的初稿本体（应用时作为 fromStrategyView 的 base）。 */
  _draftStrategy: RaceStrategy | null;
  /** 已保存版本全量（服务端目标升序）；_activeTarget 是当前选中的版本键。 */
  _versions: RaceStrategyVersion[];
  _activeTarget: string;
  /** 指定初始选中的目标（?target= 或草稿应用后的落点）。 */
  _initialTarget: string;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

/** UTC RFC3339 → 上海时区 'YYYY/MM/DD HH:mm'（不做时区换算会差 8 小时）。 */
function timeLabel(iso: string): string {
  const day = shanghaiDateFromIso(iso);
  const time = shanghaiTimeFromIso(iso);
  if (!day || !time) return '';
  return `${day.replace(/-/g, '/')} ${time.slice(0, 5)}`;
}

/** 最近更新的版本已抽到 services/race-strategy.ts（latestStrategyVersion）。 */

Page<StrategyPageData, StrategyPageHandlers>({
  data: {
    statusBarHeight: 0,
    loading: true,
    error: '',
    view: null,
    raceDayText: '',
    versions: [],
    draft: false,
    dirty: false,
    saving: false,
    applying: false,
    deleting: false,
    updatedAtText: '',
    goalAvailable: false,
    goalSheetOpen: false,
    goalSheetRows: [],
    goalDays: GOAL_DAYS,
    goalDayIndex: 1,
    goalPending: false,
  },

  _raceId: 0,
  _detail: null,
  _base: null,
  /** 草稿模式的初稿本体（应用时作为 fromStrategyView 的 base）。 */
  _draftStrategy: null,
  _versions: [],
  _activeTarget: '',
  _initialTarget: '',

  onLoad(options) {
    const id = Number(options.id);
    this.setData({ statusBarHeight: statusBarHeight() });
    if (!id || id <= 0) {
      this.setData({ loading: false, error: '赛事不存在' });
      return;
    }
    this._raceId = id;
    // 教练聊天卡片交接的草稿（raceId 匹配才消费）：进草稿模式。
    const pending = takePendingStrategyDraft(id);
    this._draftStrategy = pending?.strategy ?? null;
    void this.refresh();
  },

  async refresh() {
    if (!userStore.getState().user) {
      this.setData({ loading: false, error: '请先登录后查看比赛策略' });
      return;
    }
    this.setData({ loading: true, error: '' });
    const draft = this._draftStrategy;
    if (draft) {
      // 草稿模式：跳过 GET（服务端没有这版），只取赛事元信息（比赛日/目标预填）。
      try {
        const detail = await getRaceDetail(this._raceId);
        this._detail = detail;
        this._base = draft;
        const view = toStrategyView(draft);
        this.setData({
          loading: false,
          error: '',
          view,
          draft: true,
          raceDayText: raceDayLabel(detail.race_date),
          dirty: false,
          updatedAtText: '',
          goalAvailable: goalPrefill(view, detail.race_date, detail.city) !== null,
        });
      } catch {
        this.setData({ loading: false, error: '加载失败，请稍后重试' });
      }
      return;
    }
    // 已保存态：赛事详情 + 全部策略版本双请求。
    try {
      const [detail, listRes] = await Promise.all([
        getRaceDetail(this._raceId),
        getRaceStrategies(this._raceId),
      ]);
      this._detail = detail;
      if (listRes.strategies.length === 0) {
        this.setData({ loading: false, error: '策略尚未生成：回到赛事详情，和教练聊一聊生成初稿' });
        return;
      }
      // 初始选中最近更新的版本（草稿应用后 _initialTarget 指定落点）。
      const requested = listRes.strategies.find((v) => v.target_finish_time === this._initialTarget);
      const initial = requested ?? latestStrategyVersion(listRes.strategies);
      if (initial) {
        this.applyVersion(initial, listRes.strategies, detail);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError && err.statusCode >= 500
          ? '加载失败，请稍后重试'
          : err instanceof Error
            ? err.message
            : '加载失败，请稍后重试';
      this.setData({ loading: false, error: msg });
    }
  },

  /** 把选中版本落到页面数据：视图 + pills + 保存态时间戳。 */
  applyVersion(version: RaceStrategyVersion, versions: RaceStrategyVersion[], detail: RaceDetail) {
    this._versions = versions;
    this._activeTarget = version.target_finish_time;
    this._base = version.content;
    const view = toStrategyView(version.content);
    this.setData({
      loading: false,
      error: '',
      view,
      draft: false,
      versions: versions.map((v) => ({ target: v.target_finish_time, active: v.target_finish_time === version.target_finish_time })),
      raceDayText: raceDayLabel(detail.race_date),
      dirty: false,
      updatedAtText: timeLabel(version.updated_at),
      goalAvailable: goalPrefill(view, detail.race_date, detail.city) !== null,
    });
  },

  /** 版本 pill 切换：纯内存换视图；有未保存修改先确认丢弃。 */
  onVersionTap(e: WechatMiniprogram.TouchEvent) {
    const target = String(e.currentTarget.dataset.target || '');
    if (!target || target === this._activeTarget) return;
    const detail = this._detail;
    if (!detail) return;
    const next = this._versions.find((v) => v.target_finish_time === target);
    if (!next) return;
    const switchTo = () => this.applyVersion(next, this._versions, detail);
    if (!this.data.dirty) {
      switchTo();
      return;
    }
    wx.showModal({
      title: '切换目标版本',
      content: '当前版本有未保存的修改，切换后将丢弃。',
      confirmText: '丢弃并切换',
      success: (res) => {
        if (res.confirm) switchTo();
      },
    });
  },

  onShareAppMessage() {
    const view = this.data.view;
    const name = view?.raceName || '比赛策略';
    if (!view || !this._raceId) {
      return { title: name, path: '/pages/race-center/race-center' };
    }
    return {
      title: strategyShareTitle(view),
      // 分享落到赛事详情页（报告页是私有产物，接收方看自己是否已生成）
      path: `/pages/race-center/detail?id=${this._raceId}`,
    };
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/race-center/race-center' }) });
  },

  /** hero 主按钮：带 race target 回教练 tab（与详情页策略卡同一入口语义）。 */
  onCoachTap() {
    const detail = this._detail;
    const view = this.data.view;
    if (!detail || !view) return;
    setPendingCoachContext({
      target: { kind: 'race', race_event_id: this._raceId, item_type: view.itemType },
      label: `${view.raceName} · ${view.itemTypeLabel}`,
    });
    // reLaunch 而非 switchTab：本页是深层普通页面，switchTab 会先播放
    // 返回宿主 tab 的关闭动画再切教练 tab，视觉上闪现宿主 tab 页。
    wx.reLaunch({ url: '/pages/coach/coach' });
  },

  // ── 编辑：blur 落值 + 重算（视图模型保证 用时=距离×配速） ──

  onPaceBlur(e) {
    this.patchPaceRow(Number(e.currentTarget.dataset.index), { pace: e.detail.value });
  },

  onNoteBlur(e) {
    this.patchPaceRow(Number(e.currentTarget.dataset.index), { note: e.detail.value });
  },

  patchPaceRow(index: number, patch: Partial<StrategyView['paceRows'][number]>) {
    const view = this.data.view;
    if (!view || index < 0 || index >= view.paceRows.length) return;
    const paceRows = view.paceRows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    this.setData({ 'view.paceRows': paceRows, dirty: true });
  },

  patchFuelingRow(index: number, patch: Partial<StrategyView['fuelingRows'][number]>) {
    const view = this.data.view;
    if (!view || index < 0 || index >= view.fuelingRows.length) return;
    const fuelingRows = view.fuelingRows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    this.setData({ 'view.fuelingRows': fuelingRows, dirty: true });
  },

  onFuelingWhenBlur(e) {
    this.patchFuelingRow(Number(e.currentTarget.dataset.index), { timePoint: e.detail.value });
  },

  onFuelingWhatBlur(e) {
    this.patchFuelingRow(Number(e.currentTarget.dataset.index), { content: e.detail.value });
  },

  onFuelingAdd() {
    const view = this.data.view;
    if (!view) return;
    this.setData({
      'view.fuelingRows': [...view.fuelingRows, { index: view.fuelingRows.length, timePoint: '', content: '' }],
      dirty: true,
    });
  },

  onFuelingRemove(e) {
    const view = this.data.view;
    const index = Number(e.currentTarget.dataset.index);
    if (!view || index < 0 || index >= view.fuelingRows.length) return;
    const fuelingRows = view.fuelingRows
      .filter((_, i) => i !== index)
      .map((row, i) => ({ ...row, index: i }));
    this.setData({ 'view.fuelingRows': fuelingRows, dirty: true });
  },

  /** 保存编辑（覆盖最新版；保存后 dirty 归零）。 */
  async onSaveTap() {
    const view = this.data.view;
    const base = this._base;
    if (!view || !base || !this.data.dirty || this.data.saving) return;
    this.setData({ saving: true });
    try {
      const res = await saveRaceStrategy(this._raceId, {
        item_type: view.itemType,
        content: fromStrategyView(view, base),
      });
      // 同步 _versions 的时间戳：后续删除切版时 latestStrategyVersion 才准。
      this._versions = this._versions.map((v) =>
        v.target_finish_time === this._activeTarget ? { ...v, updated_at: res.updated_at } : v,
      );
      this.setData({ dirty: false, updatedAtText: timeLabel(res.updated_at) });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch {
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  /**
   * 草稿模式底部主按钮：把教练初稿（含本页编辑）PUT 落库为该目标的版本，
   * 转「最近更新」选中态；应用前服务端没有这版策略；不应用直接离开=放弃初稿。
   */
  async onApplyTap() {
    const view = this.data.view;
    const base = this._base;
    if (!view || !base || this.data.applying) return;
    this.setData({ applying: true });
    try {
      const res = await saveRaceStrategy(this._raceId, {
        item_type: view.itemType,
        content: fromStrategyView(view, base),
      });
      this._draftStrategy = null;
      // 草稿应用后落到自己目标的那版（列表可能有多个版本）。
      this._initialTarget = res.target_finish_time || view.targetTime;
      wx.showToast({ title: '已应用', icon: 'success' });
      await this.refresh();
    } catch {
      wx.showToast({ title: '应用失败，请重试', icon: 'none' });
    } finally {
      this.setData({ applying: false });
    }
  },

  /** 删除当前选中的目标版本；还有其它版本则切过去，没有了回未生成态。 */
  onDeleteTap() {
    const target = this._activeTarget;
    if (!target || this.data.deleting) return;
    wx.showModal({
      title: '删除目标版本',
      content: `删除 ${target} 这一版策略？其它目标版本不受影响。`,
      confirmText: '删除',
      confirmColor: '#ff5c5c',
      success: (res) => {
        if (!res.confirm) return;
        void this.deleteActiveVersion(target);
      },
    });
  },

  async deleteActiveVersion(target: string) {
    const detail = this._detail;
    if (!detail) return;
    this.setData({ deleting: true });
    try {
      await deleteRaceStrategy(this._raceId, target);
      const remaining = this._versions.filter((v) => v.target_finish_time !== target);
      if (remaining.length === 0) {
        this._versions = [];
        this._activeTarget = '';
        this.setData({
          versions: [],
          view: null,
          updatedAtText: '',
          error: '策略尚未生成：回到赛事详情，和教练聊一聊生成初稿',
        });
        return;
      }
      const next = latestStrategyVersion(remaining);
      if (!next) return;
      this.applyVersion(next, remaining, detail);
    } catch {
      wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    } finally {
      this.setData({ deleting: false });
    }
  },

  /** 配速卡：canvas 海报 → 临时文件 → 预览（长按保存为原生能力）。 */
  onPosterTap() {
    const view = this.data.view;
    if (!view) return;
    const query = wx.createSelectorQuery().in(this as never);
    query
      .select('#poster')
      .fields({ node: true, size: true }, (res) => {
        const canvas = res?.node;
        if (!canvas) {
          wx.showToast({ title: '配速卡生成失败', icon: 'none' });
          return;
        }
        const width = 600;
        const height = 360 + view.paceRows.length * 56;
        const dpr = 2;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext('2d') as unknown as PosterCtx;
        ctx.scale(dpr, dpr);
        drawPoster(ctx, width, height, view, this.data.raceDayText);
        wx.canvasToTempFilePath({
          canvas,
          success: (out) => {
            wx.previewImage({ urls: [out.tempFilePath] });
          },
          fail: () => wx.showToast({ title: '配速卡生成失败', icon: 'none' }),
        });
      })
      .exec();
  },

  // ── 设为目标（race_goal 预填确认） ──

  onGoalTap() {
    const view = this.data.view;
    const detail = this._detail;
    if (!view || !detail) return;
    const prefill = goalPrefill(view, detail.race_date, detail.city);
    if (!prefill) return;
    this.setData({
      goalSheetOpen: true,
      goalSheetRows: [
        { k: '目标赛事', v: prefill.race_name },
        { k: '比赛日', v: raceDayLabel(prefill.race_date) },
        { k: '项目', v: view.itemTypeLabel },
        { k: '目标成绩', v: prefill.target_finish_time },
        ...(prefill.race_location ? [{ k: '地点', v: prefill.race_location }] : []),
      ],
    });
  },

  onGoalSheetClose() {
    if (this.data.goalPending) return;
    this.setData({ goalSheetOpen: false });
  },

  onGoalDayChange(e) {
    this.setData({ goalDayIndex: Number(e.detail.value) });
  },

  async onGoalConfirm() {
    const view = this.data.view;
    const detail = this._detail;
    if (!view || !detail || this.data.goalPending) return;
    const prefill = goalPrefill(view, detail.race_date, detail.city);
    if (!prefill) return;
    this.setData({ goalPending: true });
    try {
      await postTrainingGoal({ ...prefill, weekly_training_days: GOAL_DAYS[this.data.goalDayIndex] || 4 });
      this.setData({ goalSheetOpen: false });
      wx.showToast({ title: '已设为目标赛事', icon: 'success' });
    } catch (err: unknown) {
      // 比赛日已过等校验失败直出后端信息
      const msg = err instanceof ApiError && err.message ? err.message : '设置失败，请重试';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ goalPending: false });
    }
  },
});

/** 配速卡 canvas 2d 上下文的最小结构（wx typings 不带 DOM Canvas 类型）。 */
interface PosterCtx {
  fillStyle: string;
  font: string;
  strokeStyle: string;
  scale(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** 配速卡海报：深色底 + 目标成绩 + 分段表（纯绘制，页面内闭函数）。 */
function drawPoster(
  ctx: PosterCtx,
  width: number,
  height: number,
  view: StrategyView,
  raceDayText: string,
): void {
  ctx.fillStyle = '#0a0a0b';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#d8ff3e';
  ctx.fillRect(0, 0, width, 6);

  ctx.fillStyle = '#8a8a8c';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${raceDayText} · ${view.itemTypeLabel}`, 36, 60);

  ctx.fillStyle = '#f2f2f3';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(view.raceName, 36, 106);

  ctx.fillStyle = '#8a8a8c';
  ctx.font = '20px sans-serif';
  ctx.fillText('目标成绩', 36, 160);
  ctx.fillStyle = '#d8ff3e';
  ctx.font = 'bold 56px sans-serif';
  ctx.fillText(view.targetTime, 36, 220);

  // 表头
  let y = 276;
  ctx.fillStyle = '#8a8a8c';
  ctx.font = '20px sans-serif';
  ctx.fillText('分段', 36, y);
  ctx.fillText('配速', 250, y);
  ctx.fillText('累计', 410, y);
  y += 12;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.moveTo(36, y);
  ctx.lineTo(width - 36, y);
  ctx.stroke();

  for (const row of view.paceRows) {
    y += 44;
    ctx.fillStyle = '#f2f2f3';
    ctx.font = '22px sans-serif';
    ctx.fillText(row.segment, 36, y);
    ctx.fillText(row.pace, 250, y);
    ctx.fillStyle = '#b9b9bc';
    ctx.fillText(row.cumulativeTime, 410, y);
  }

  ctx.fillStyle = '#8a8a8c';
  ctx.font = '18px sans-serif';
  ctx.fillText('STRIDE · 比赛策略', 36, height - 28);
}
