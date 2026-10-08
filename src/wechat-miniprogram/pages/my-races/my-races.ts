// 我的比赛页 —— 双 tab：默认「我的赛事」（参赛计划，原 race-center/plans 页
// 并入），第二「我的成绩」（race detection 自动识别的参赛经历与成绩）。
//
// 成绩数据来自 GET /api/{user}/races（services/races）：同步流水线确认的比赛，
// 明细（名称/距离/用时/配速）join 自 activities，点击一行进活动详情。
// 计划数据走 services/race-plans（GET/PUT /api/users/me/race-plans）：计划卡 =
// 赛事名（点击进详情）+ 报名项目徽章 + 状态徽章 + 日期·城市 + 开赛倒计时；状态条 chips 点击
// 流转（已报名→已中签→确认参赛，未中签为旁路状态给替代赛事引导）；行程布尔
// 勾选 🏨 酒店 / 🚄 火车票·机票；offboarded 计划灰卡占位不可交互。纯视图变换
// 在 utils/racePlanRows，配套自检。

import { getMyRaces, type RaceItem } from '../../services/races';
import {
  listRacePlans,
  upsertRacePlan,
  type RacePlanState,
} from '../../services/race-plans';
import { statePatch, toPlanCards, type PlanCardView } from '../../utils/racePlanRows';
import { shanghaiDateFromIso } from '../../utils/date';
import { userStore } from '../../store/index';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

/** tab 标识：plans=我的赛事（默认）/ results=我的成绩 */
type TabId = 'plans' | 'results';

interface RaceRow {
  labelId: string;
  name: string;
  /** 后端 distance_band → 中文档位标签 */
  bandLabel: string;
  /** wxss class 后缀：marathon / half / other */
  bandClass: string;
  /** 上海 YYYY-MM-DD */
  dateLabel: string;
  /** 一位小数公里，如 42.2 */
  distanceKm: string;
  /** 预格式化成绩（后端 duration_fmt） */
  duration: string;
  /** 预格式化配速（后端 pace_fmt），空串隐藏 */
  pace: string;
  avgHr: string;
  ascent: string;
  /** 同档位（全马 / 半马）当前最快：金 🏆 PB 徽章 */
  isPb: boolean;
}

interface MyRacesPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  activeTab: TabId;
  /** 我的成绩 tab */
  loading: boolean;
  error: string;
  rows: RaceRow[];
  summary: string;
  /** 我的赛事 tab */
  plansLoading: boolean;
  plansError: string;
  cards: PlanCardView[];
}

interface MyRacesPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onLoad(): void;
  onShow(): void;
  onPullDownRefresh(): void;
  onTabTap(e: WechatMiniprogram.TouchEvent): void;
  fetchRaces(): Promise<void>;
  refreshPlans(): Promise<void>;
  onRaceTap(e: WechatMiniprogram.TouchEvent): void;
  onStateTap(e: WechatMiniprogram.TouchEvent): void;
  onTripTap(e: WechatMiniprogram.TouchEvent): void;
  onRaceNameTap(e: WechatMiniprogram.TouchEvent): void;
  onGoListTap(): void;
  onBack(): void;
  /** 在飞的写请求（键=race_id → 乐观补丁）：防连点，并让并发读不打回乐观态 */
  _inflight: Map<number, Partial<PlanCardView>>;
  /** 计划请求序号，慢响应回来时发现自己已过期则丢弃（同 race-center._fetchSeq） */
  _fetchSeq: number;
  /** 成绩请求序号：onShow 与下拉刷新并发时丢弃慢的旧响应 */
  _resultsSeq: number;
}

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
  // 顶栏 = 标题行 128rpx + tab 行 88rpx，再留 24rpx 呼吸
  return Math.round((statusPx * 750) / width) + 128 + 88 + 24;
}

function bandLabel(band: RaceItem['distance_band']): string {
  if (band === 'marathon') return '全马';
  if (band === 'half_marathon') return '半马';
  return '比赛';
}

function bandClass(band: RaceItem['distance_band']): string {
  if (band === 'marathon') return 'marathon';
  if (band === 'half_marathon') return 'half';
  return 'other';
}

function toRow(race: RaceItem, isPb: boolean): RaceRow {
  return {
    labelId: race.label_id,
    name: race.name || bandLabel(race.distance_band),
    bandLabel: bandLabel(race.distance_band),
    bandClass: bandClass(race.distance_band),
    dateLabel: shanghaiDateFromIso(race.date) || race.date,
    distanceKm: race.distance_km.toFixed(1),
    duration: race.duration_fmt,
    pace: race.pace_fmt && race.pace_fmt !== '—' ? race.pace_fmt : '',
    avgHr: race.avg_hr != null ? String(race.avg_hr) : '',
    ascent: race.ascent_m != null ? String(Math.round(race.ascent_m)) : '',
    isPb,
  };
}

/**
 * 当前 PB 的 label_id 集合：全马 / 半马各自取净用时最短的一场，互不可比
 * （其它档位距离不一，不设 PB）。用 `<=` 让新→旧遍历中同成绩的更早
 * （更旧）一场胜出——PB 记在首次跑出该成绩的那场。
 */
function pbLabelIds(races: RaceItem[]): Set<string> {
  const best = new Map<'marathon' | 'half_marathon', { id: string; seconds: number }>();
  for (const race of races) {
    const band = race.distance_band;
    if (band !== 'marathon' && band !== 'half_marathon') continue;
    if (race.duration_s == null) continue;
    const cur = best.get(band);
    if (!cur || race.duration_s <= cur.seconds) {
      best.set(band, { id: race.label_id, seconds: race.duration_s });
    }
  }
  return new Set([...best.values()].map((entry) => entry.id));
}

function buildSummary(rows: RaceRow[]): string {
  const marathon = rows.filter((r) => r.bandClass === 'marathon').length;
  const half = rows.filter((r) => r.bandClass === 'half').length;
  const parts = [`共 ${rows.length} 场`];
  if (marathon > 0) parts.push(`全马 ${marathon}`);
  if (half > 0) parts.push(`半马 ${half}`);
  return parts.join(' · ');
}

Page<MyRacesPageData, MyRacesPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  _inflight: new Map(),
  _fetchSeq: 0,
  _resultsSeq: 0,

  data: {
    statusBarHeight: 0,
    contentPaddingTop: 240,
    activeTab: 'plans',
    loading: true,
    error: '',
    rows: [],
    summary: '',
    plansLoading: true,
    plansError: '',
    cards: [],
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onShow() {
    void this.fetchRaces();
    void this.refreshPlans();
  },

  onPullDownRefresh() {
    const task = this.data.activeTab === 'plans' ? this.refreshPlans() : this.fetchRaces();
    void task.finally(() => wx.stopPullDownRefresh());
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as TabId;
    if ((tab !== 'plans' && tab !== 'results') || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    // 两 tab 内容长短不一且共用页面滚动，切换后回顶避免停在页底
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  async fetchRaces() {
    const userId = userStore.getState().user?.id;
    if (!userId) {
      this.setData({ loading: false, error: '请先登录' });
      return;
    }
    const seq = (this._resultsSeq += 1);
    this.setData({ loading: true, error: '' });
    try {
      const res = await getMyRaces(userId);
      if (seq !== this._resultsSeq) return;
      const pbIds = pbLabelIds(res.races);
      const rows = res.races.map((race) => toRow(race, pbIds.has(race.label_id)));
      this.setData({ loading: false, rows, summary: buildSummary(rows) });
    } catch (err: unknown) {
      if (seq !== this._resultsSeq) return;
      const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
      this.setData({ loading: false, error: msg });
    }
  },

  async refreshPlans() {
    if (!userStore.getState().user?.id) {
      this.setData({ plansLoading: false, plansError: '请先登录' });
      return;
    }
    const seq = (this._fetchSeq += 1);
    this.setData({ plansLoading: true, plansError: '' });
    try {
      const res = await listRacePlans();
      if (seq !== this._fetchSeq) return;
      // GET 若赶在 PUT 落库前返回，快照还是旧态：叠加在飞乐观补丁，不打回 UI
      const cards = toPlanCards(res.plans).map((c) => {
        const patch = this._inflight.get(c.raceId);
        return patch ? { ...c, ...patch } : c;
      });
      this.setData({ plansLoading: false, cards });
    } catch (err: unknown) {
      if (seq !== this._fetchSeq) return;
      const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
      this.setData({ plansLoading: false, plansError: msg });
    }
  },

  /** 状态条 chip 点击：三态流转（点当前态无效）。未中签是旁路状态，
   *  只能从详情页报名选择器进入，本页 chips 不含。
   *  乐观更新，失败回滚；hotel/transit 缺省=后端保留已存值。 */
  async onStateTap(e: WechatMiniprogram.TouchEvent) {
    const raceId = Number(e.currentTarget.dataset.raceId);
    const next = e.currentTarget.dataset.state as RacePlanState;
    const card = this.data.cards.find((c) => c.raceId === raceId);
    if (!card || card.offboarded || card.state === next || this._inflight.has(raceId)) return;

    const prev = card.state;
    const patch = statePatch(next);
    this._inflight.set(raceId, patch);
    patchCard(this, raceId, patch);
    try {
      await upsertRacePlan(raceId, { item_type: card.itemToken, state: next });
    } catch {
      this._inflight.delete(raceId);
      patchCard(this, raceId, statePatch(prev));
      wx.showToast({ title: '状态更新失败', icon: 'none' });
      return;
    }
    this._inflight.delete(raceId);
  },

  /** 行程布尔勾选：🏨 酒店 / 🚄 火车票·机票，显式传反值覆盖。 */
  async onTripTap(e: WechatMiniprogram.TouchEvent) {
    const raceId = Number(e.currentTarget.dataset.raceId);
    const field = e.currentTarget.dataset.field as 'hotel' | 'transit';
    const card = this.data.cards.find((c) => c.raceId === raceId);
    if (!card || card.offboarded || !field || this._inflight.has(raceId)) return;

    const next = !card[field];
    const patch: Partial<PlanCardView> = { [field]: next };
    this._inflight.set(raceId, patch);
    patchCard(this, raceId, patch);
    try {
      await upsertRacePlan(raceId, {
        item_type: card.itemToken,
        state: card.state,
        [field]: next,
      });
    } catch {
      this._inflight.delete(raceId);
      patchCard(this, raceId, { [field]: !next });
      wx.showToast({ title: '保存失败', icon: 'none' });
      return;
    }
    this._inflight.delete(raceId);
  },

  /** 赛事名点击进详情（详情页的报名选择器即计划创建入口）。 */
  onRaceNameTap(e: WechatMiniprogram.TouchEvent) {
    const raceId = Number(e.currentTarget.dataset.raceId);
    if (!raceId) return;
    wx.navigateTo({ url: `/pages/race-center/detail?id=${raceId}` });
  },

  /** 未中签「去找替代赛事」/ 空态「去赛事中心逛逛」：回赛事中心列表页。
   *  上一页就是列表页（从赛事中心入口进来）时直接返回，否则新开列表页。 */
  onGoListTap() {
    const stack = getCurrentPages();
    const prev = stack[stack.length - 2];
    if (prev && prev.route === 'pages/race-center/race-center') {
      wx.navigateBack();
      return;
    }
    wx.navigateTo({ url: '/pages/race-center/race-center' });
  },

  onRaceTap(e: WechatMiniprogram.TouchEvent) {
    const labelId = e.currentTarget.dataset.id as string;
    if (!labelId) return;
    wx.navigateTo({
      url: `/pages/activity-detail/activity-detail?labelId=${encodeURIComponent(labelId)}`,
    });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});

/** 就地更新一张卡的局部字段（状态流转 / 行程勾选共用）。 */
function patchCard(
  page: WechatMiniprogram.Page.Instance<MyRacesPageData, MyRacesPageHandlers>,
  raceId: number,
  patch: Partial<PlanCardView>,
): void {
  const cards = page.data.cards.map((c) => (c.raceId === raceId ? { ...c, ...patch } : c));
  page.setData({ cards });
}
