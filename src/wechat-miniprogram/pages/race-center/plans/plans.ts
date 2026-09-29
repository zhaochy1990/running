// 「我的赛事」页 —— 参赛计划管理（#394，#385 定稿版式：C 紧凑风、深色转译）。
//
// 数据走 services/race-center（GET/PUT /api/users/me/race-plans，#391 后端）：
// 计划卡 = 赛事名 + 报名项目徽章 + 状态徽章 + 日期·城市；状态条 chips 点击流转
// （已报名→已中签→确认参赛，未中签为旁路状态给替代赛事引导）；行程布尔勾选
// 🏨 酒店 / 🚄 火车票·机票；offboarded 计划灰卡占位不可交互；空态引导去列表页。
// 教练行本期隐藏（随 #386/v2 恢复）。纯视图变换在 utils/racePlanRows，配套自检。

import {
  listRacePlans,
  updateRacePlan,
  type RacePlanState,
} from '../../../services/race-center';
import { statePatch, toPlanCards, type PlanCardView } from '../../../utils/racePlanRows';
import { userStore } from '../../../store/index';

interface PlansPageData {
  statusBarHeight: number;
  loading: boolean;
  error: string;
  cards: PlanCardView[];
}

interface PlansPageHandlers {
  onLoad(): void;
  onShow(): void;
  onPullDownRefresh(): void;
  refresh(): Promise<void>;
  onStateTap(e: WechatMiniprogram.TouchEvent): void;
  onTripTap(e: WechatMiniprogram.TouchEvent): void;
  onRaceNameTap(): void;
  onGoListTap(): void;
  /** 在飞的写请求（键=race_id → 乐观补丁）：防连点，并让并发读不打回乐观态 */
  _inflight: Map<number, Partial<PlanCardView>>;
  /** 请求序号，慢响应回来时发现自己已过期则丢弃（同 race-center._fetchSeq） */
  _fetchSeq: number;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<PlansPageData, PlansPageHandlers>({
  _inflight: new Map(),
  _fetchSeq: 0,

  data: {
    statusBarHeight: 0,
    loading: true,
    error: '',
    cards: [],
  },

  onLoad() {
    this.setData({ statusBarHeight: statusBarHeight() });
  },

  onShow() {
    void this.refresh();
  },

  onPullDownRefresh() {
    void this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    if (!userStore.getState().user?.id) {
      this.setData({ loading: false, error: '请先登录' });
      return;
    }
    const seq = (this._fetchSeq += 1);
    this.setData({ loading: true, error: '' });
    try {
      const res = await listRacePlans();
      if (seq !== this._fetchSeq) return;
      // GET 若赶在 PUT 落库前返回，快照还是旧态：叠加在飞乐观补丁，不打回 UI
      const cards = toPlanCards(res.plans).map((c) => {
        const patch = this._inflight.get(c.raceId);
        return patch ? { ...c, ...patch } : c;
      });
      this.setData({ loading: false, cards });
    } catch (err: unknown) {
      if (seq !== this._fetchSeq) return;
      const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
      this.setData({ loading: false, error: msg });
    }
  },

  /** 状态条 chip 点击：三态流转（点当前态无效）。未中签是旁路状态，
   *  只能从详情页报名选择器（#393）进入，本页 chips 不含。
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
      await updateRacePlan(raceId, { item_type: card.itemToken, state: next });
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
      await updateRacePlan(raceId, {
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

  onRaceNameTap() {
    // 详情页是 #393 的范围，先给明确反馈而不是静默无响应
    wx.showToast({ title: '赛事详情即将上线', icon: 'none' });
  },

  /** 顶栏返回 / 未中签「去找替代赛事」/ 空态「去逛逛」：回赛事中心列表页。 */
  onGoListTap() {
    wx.navigateBack({
      fail: () => wx.navigateTo({ url: '/pages/race-center/race-center' }),
    });
  },
});

/** 就地更新一张卡的局部字段（状态流转 / 行程勾选共用）。 */
function patchCard(
  page: WechatMiniprogram.Page.Instance<PlansPageData, PlansPageHandlers>,
  raceId: number,
  patch: Partial<PlanCardView>,
): void {
  const cards = page.data.cards.map((c) => (c.raceId === raceId ? { ...c, ...patch } : c));
  page.setData({ cards });
}
