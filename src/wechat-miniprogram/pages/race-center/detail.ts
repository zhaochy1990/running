// 赛事详情页 —— #393，版式按 #385 定稿（沿用列表页 #392 的深色视觉语言）。
//
// 头区：名称+星标+双徽章 → 三宫格（天后开赛/比赛日/报名制式）→ 报名时间轴
// （完成态按当前日期计算）→「报名：项目 · 状态 ▾」按钮；三 tab：概要/项目/出行。
// 报名选择器是参赛计划的唯一创建入口（PUT / DELETE /api/users/me/race-plans/:id，
// 后端 race_plans.go）；比赛策略卡（#396）：仅内容调研过（strategy_available）的
// 赛事显示，未生成=CTA 进教练会话（带 race target），已生成=摘要进报告页。
// 视图变换在 utils/raceDetailRows（配套自检），请求在 services/race-center /
// services/race-plans。计划列表接口没有单场查询，进来时整表拉一次找本场的计划。

import { ApiError } from '../../services/request';
import {
  getRaceDetail,
  toggleRaceFavorite,
  type RaceDetail,
} from '../../services/race-center';
import {
  deleteRacePlan,
  listRacePlans,
  upsertRacePlan,
  type RacePlan,
  type RacePlanState,
} from '../../services/race-plans';
import {
  PLAN_STATE_OPTIONS,
  itemChips,
  planButtonLabel,
  toDetailView,
  type RaceDetailView,
} from '../../utils/raceDetailRows';
import { typeAbbr } from '../../utils/raceCenterRows';
import { shanghaiDateFromIso, shanghaiToday } from '../../utils/date';
import { setPendingCoachContext } from '../../services/coach';
import { getRaceStrategies, latestStrategyVersion } from '../../services/race-strategy';
import { userStore } from '../../store/index';

interface RaceDetailPageData {
  statusBarHeight: number;
  loading: boolean;
  /** 非空时整页只渲染错误条（含未登录 / 赛事不存在） */
  error: string;
  /** 头区 + 三 tab 的渲染模型（utils/raceDetailRows.toDetailView 产物） */
  view: RaceDetailView | null;
  starred: boolean;
  tabIndex: number;
  /** 报名按钮文案（'未报名' 或 '全马 · 已报名（等抽签）'） */
  signupButton: string;
  /** 无项目可报时整个报名按钮不渲染 */
  signupAvailable: boolean;
  sheetOpen: boolean;
  sheetChips: Array<{ token: string; label: string; on: boolean }>;
  /** sheet 内当前选中的项目 token（提交时用它） */
  sheetItem: string;
  sheetStates: Array<{ value: string; label: string; current: boolean }>;
  /** 策略卡入口（内容调研过才显示，#396 门槛） */
  strategyEntry: boolean;
  /** 已生成时的摘要态（最近更新版目标 + 版本数 + 更新时间）；null=未生成（CTA 态） */
  strategySummary: { target: string; count: number; updatedAt: string } | null;
  /** 赛道 tab 站点卡的展开态，key 见 utils/raceCourse（sectionId:index，页面级唯一） */
  courseOpen: Record<string, boolean>;
}

interface RaceDetailPageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  onShow(): void;
  onPullDownRefresh(): void;
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBack(): void;
  onStarTap(): void;
  onTabTap(e: WechatMiniprogram.TouchEvent): void;
  onSignupTap(): void;
  onChipTap(e: WechatMiniprogram.TouchEvent): void;
  onStateTap(e: WechatMiniprogram.TouchEvent): void;
  onStrategyTap(): void;
  onSheetClose(): void;
  onCopyTap(e: WechatMiniprogram.TouchEvent): void;
  /** 赛道 tab：站点卡展开/收起 */
  onCourseToggle(e: WechatMiniprogram.TouchEvent): void;
  refresh(): Promise<void>;
  applyPlan(): void;
  _raceId: number;
  _detail: RaceDetail | null;
  /** 当前计划（无则 null），只记按钮文案与选择器要读的两字段；按钮文案与选择器选中态的依据 */
  _plan: Pick<RacePlan, 'item_type' | 'state'> | null;
  /** 报名提交进行中：防连点 */
  _planPending: boolean;
  _starPending: boolean;
  /**
   * 请求序号（同列表页 #392 模式）：慢响应回来时发现自己已过期则丢弃；
   * 星标/报名写成功也会自增，作废在途刷新携带的旧值（乐观更新以本地为准）。
   */
  _fetchSeq: number;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<RaceDetailPageData, RaceDetailPageHandlers>({
  data: {
    statusBarHeight: 0,
    loading: true,
    error: '',
    view: null,
    starred: false,
    tabIndex: 0,
    signupButton: '未报名',
    signupAvailable: false,
    sheetOpen: false,
    sheetChips: [],
    sheetItem: '',
    sheetStates: [],
    strategyEntry: false,
    strategySummary: null,
    courseOpen: {},
  },

  _raceId: 0,
  _detail: null,
  _plan: null,
  _planPending: false,
  _starPending: false,
  _fetchSeq: 0,

  onLoad(options) {
    const id = Number(options.id);
    this.setData({ statusBarHeight: statusBarHeight() });
    if (!id || id <= 0) {
      this.setData({ loading: false, error: '赛事不存在' });
      return;
    }
    this._raceId = id;
    void this.refresh();
  },

  // 未登录被拦下后登录回来要能自愈；从分享卡片进来也走这里补拉计划态
  onShow() {
    if (this._raceId && !this.data.loading) void this.refresh();
  },

  onPullDownRefresh() {
    void this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    if (!userStore.getState().user) {
      this.setData({ loading: false, error: '请先登录后查看赛事详情' });
      return;
    }
    this.setData({ loading: true, error: '' });
    const seq = (this._fetchSeq += 1);
    // 详情与计划并行发起（计划态只依赖 raceId）；计划拉不到不阻塞详情，
    // 只是按钮先显示未报名——选择器提交不受影响
    const plansP = listRacePlans().catch(() => null);
    // 策略态并行拉取（空列表=未生成；其它失败按未生成展示，不阻塞详情）。
    // 多版本按目标键控：摘要显示最近更新版的目标，count>1 时露出版本数。
    // updated_at 是 UTC RFC3339：摘要日期按上海时区取（直接切 UTC 串会差 8 小时）
    const strategyP = getRaceStrategies(this._raceId).then((res) => {
      const latest = latestStrategyVersion(res.strategies);
      if (!latest) return null;
      return {
        target: latest.target_finish_time || '—',
        count: res.strategies.length,
        updatedAt: shanghaiDateFromIso(latest.updated_at).replace(/-/g, '/'),
      };
    }, () => null);
    let detail: RaceDetail;
    try {
      detail = await getRaceDetail(this._raceId);
    } catch (err: unknown) {
      if (seq !== this._fetchSeq) return;
      // 未发布与不存在同为 404（后端不泄漏未发布行的存在）；5xx 的英文错误体不直出
      const msg =
        err instanceof ApiError && err.statusCode === 404
          ? '赛事不存在或已下架'
          : err instanceof ApiError && err.statusCode >= 500
            ? '加载失败，请稍后重试'
            : err instanceof Error
              ? err.message
              : '加载失败，请稍后重试';
      this.setData({ loading: false, error: msg });
      return;
    }
    const [plansRes, strategySummary] = await Promise.all([plansP, strategyP]);
    if (seq !== this._fetchSeq) return;
    this._plan = plansRes?.plans.find((p) => p.race_id === this._raceId) || null;
    this._detail = detail;
    const view = toDetailView(detail, shanghaiToday());
    // 赛道 tab 缺席（无赛道内容）时 tabIndex===3 是死位（四 tab 版式残留），拉回概要
    const patch: Partial<RaceDetailPageData> = {
      loading: false,
      error: '',
      view,
      starred: detail.favorited,
      signupAvailable: itemChips(detail.items).length > 0,
      strategyEntry: detail.strategy_available,
      strategySummary,
      courseOpen: {},
    };
    if (!view.course.available && this.data.tabIndex === 3) patch.tabIndex = 0;
    this.setData(patch);
    this.applyPlan();
  },

  /** 报名按钮文案（依据 _plan）。 */
  applyPlan() {
    const plan = this._plan;
    this.setData({
      signupButton: planButtonLabel(plan?.item_type || '', plan?.state || 'none'),
    });
  },

  /** 行尾星标：乐观更新，服务端结果为准，失败回滚。 */
  onStarTap() {
    const detail = this._detail;
    if (!detail || this._starPending) return;
    const next = !detail.favorited;
    // 作废在途刷新：其响应里的 favorited 是点星前的旧值，落地会打回乐观结果
    this._fetchSeq += 1;
    this._starPending = true;
    detail.favorited = next;
    this.setData({ starred: next });
    toggleRaceFavorite(detail.id)
      .then((res) => {
        detail.favorited = res.favorited;
        this.setData({ starred: res.favorited });
      })
      .catch(() => {
        detail.favorited = !next;
        this.setData({ starred: !next });
        wx.showToast({ title: '收藏操作失败', icon: 'none' });
      })
      .finally(() => {
        this._starPending = false;
      });
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = Number(e.currentTarget.dataset.tab);
    if (tab === this.data.tabIndex) return;
    this.setData({ tabIndex: tab });
  },

  /** 打开报名选择器：项目 chip 预选当前计划的项目（否则第一枚）。 */
  onSignupTap() {
    if (!this.data.signupAvailable || !this._detail) return;
    const chips = itemChips(this._detail.items);
    const current =
      this._plan && chips.some((c) => c.token === this._plan?.item_type)
        ? this._plan.item_type
        : chips[0].token;
    const state = this._plan?.state || 'none';
    this.setData({
      sheetOpen: true,
      sheetItem: current,
      sheetChips: chips.map((c) => ({ ...c, on: c.token === current })),
      sheetStates: PLAN_STATE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        current: o.value === state,
      })),
    });
  },

  onChipTap(e: WechatMiniprogram.TouchEvent) {
    const token = String(e.currentTarget.dataset.token || '');
    if (!token || token === this.data.sheetItem) return;
    this.setData({
      sheetItem: token,
      sheetChips: this.data.sheetChips.map((c) => ({ ...c, on: c.token === token })),
    });
  },

  /** 选择状态即提交：none=删计划，四态=PUT（项目用 sheet 内选中项）。 */
  async onStateTap(e: WechatMiniprogram.TouchEvent) {
    const value = String(e.currentTarget.dataset.value || '') as RacePlanState | 'none';
    if (!value || this._planPending) return;
    // 点中当前状态且项目未换：纯确认，不发起冗余写
    const plan = this._plan;
    if (
      plan &&
      value !== 'none' &&
      value === plan.state &&
      this.data.sheetItem === plan.item_type
    ) {
      this.setData({ sheetOpen: false });
      return;
    }
    if (value === 'none' && !plan) {
      this.setData({ sheetOpen: false });
      return;
    }
    this._planPending = true;
    try {
      if (value === 'none') {
        await deleteRacePlan(this._raceId);
        this._plan = null;
        wx.showToast({ title: '已取消追踪', icon: 'none' });
      } else {
        const res = await upsertRacePlan(this._raceId, {
          item_type: this.data.sheetItem,
          state: value,
        });
        // 只记页面会读的两字段；race/offboarded 是列表读语义，此处捏造即谎言
        this._plan = { item_type: res.item_type, state: res.state };
        wx.showToast({ title: '已更新报名状态', icon: 'none' });
      }
      // 作废在途刷新：其计划列表是提交前的旧快照
      this._fetchSeq += 1;
      this.setData({ sheetOpen: false });
      this.applyPlan();
    } catch (err: unknown) {
      // 取消时计划可能已被别处删掉（404）：按已取消收尾而不是报错
      if (value === 'none' && err instanceof ApiError && err.statusCode === 404) {
        this._plan = null;
        this.setData({ sheetOpen: false });
        this.applyPlan();
        return;
      }
      wx.showToast({ title: '报名状态更新失败', icon: 'none' });
    } finally {
      this._planPending = false;
    }
  },

  /** 策略卡：已生成 → 报告页；未生成 → 带 race target 进教练会话。 */
  onStrategyTap() {
    const detail = this._detail;
    if (!detail) return;
    if (this.data.strategySummary) {
      wx.navigateTo({ url: `/pages/race-center/strategy/strategy?id=${this._raceId}` });
      return;
    }
    // 项目取当前计划的项目，否则第一枚项目 chip
    const chips = itemChips(detail.items);
    const itemType = this._plan?.item_type || chips[0]?.token;
    if (!itemType) return;
    const name = detail.name_cn || detail.name;
    setPendingCoachContext({
      target: { kind: 'race', race_event_id: this._raceId, item_type: itemType },
      label: `${name} · ${typeAbbr(itemType) || itemType}`,
      // #513：按钮即意图，进会话自动发出，教练主动开场确认参赛意愿/目标
      kickoff: `我想和你聊聊「${name}」的比赛策略`,
    });
    // reLaunch 而非 switchTab：本页是「我」tab 链路下的深层普通页面，
    // switchTab 会先播放返回宿主 tab（我）的关闭动画再切教练 tab，视觉上闪现「我」页。
    wx.reLaunch({ url: '/pages/coach/coach' });
  },

  onSheetClose() {
    this.setData({ sheetOpen: false });
  },

  onCopyTap(e: WechatMiniprogram.TouchEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    if (!url) return;
    // 成功不另发 toast：客户端系统自带「内容已复制」，双 toast 会叠显
    wx.setClipboardData({
      data: url,
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  /** 赛道 tab：站点卡展开/收起（全文含口径来源，默认只露短标题）。 */
  onCourseToggle(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key) return;
    this.setData({ [`courseOpen.${key}`]: !this.data.courseOpen[key] });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },

  onShareAppMessage() {
    // 坏分享链进来（id 缺失）时不再外发 ?id=0 的死路径，回落赛事中心
    if (!this._raceId) {
      return { title: '赛事中心 · 全年路跑日历', path: '/pages/race-center/race-center' };
    }
    const name = this.data.view?.head.name || '赛事详情';
    const date = this._detail?.race_date || '';
    return {
      title: date ? `${name} · ${date} 开跑` : name,
      path: `/pages/race-center/detail?id=${this._raceId}`,
    };
  },
  onShareTimeline() {
    // 单页模式不能改落地页，无 id 时不带 query，靠页面坏链兜底
    if (!this._raceId) {
      return { title: '赛事中心 · 全年路跑日历' };
    }
    const name = this.data.view?.head.name || '赛事详情';
    const date = this._detail?.race_date || '';
    return {
      title: date ? `${name} · ${date} 开跑` : name,
      query: `id=${this._raceId}`,
    };
  },
});
