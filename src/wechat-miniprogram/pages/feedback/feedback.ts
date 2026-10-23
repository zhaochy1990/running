// 意见反馈页（devops#554；原型 prototypes/518-feedback-spike.html variant C 定稿）。
// 2026-10-18 产品拍板：产品路线并入本页为二级 tab（默认反馈 tab，反馈是
// 「有需求才来」的入口不加摩擦；路线多付一次切换）。路线 UI 在
// components/roadmap-panel，首次切到路线 tab 时挂载并 sticky 保留
// （hidden 切换不卸载，投票/折叠状态不丢）；深链 ?tab=roadmap 直达。
// 结构：会话行（emoji 头像 + 标题 + 已采纳角标 + 时间 / 末条预览
// 「官方：/我：」+ 未读点）→ 隐私脚注；提交反馈=右下角悬浮 + 球。
// 未读红点数据来自 GET /feedbacks 的 items[].unread；onShow 每次重拉，
// 从聊天页（服务端读即清）返回后红点自然消失。纯行逻辑在 utils/feedbackRows。

import { listFeedbacks } from '../../services/feedback';
import { toConvRows, type FeedbackConvRow } from '../../utils/feedbackRows';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

type TabId = 'feedback' | 'roadmap';

interface FeedbackPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1（冷开分享卡直达）显示回主页的小房子 */
  canBack: boolean;
  contentPaddingTop: number;
  activeTab: TabId;
  /** 路线 tab 首次进入后置 true 并保持挂载（hidden 切换，状态不丢） */
  roadmapMounted: boolean;
  loading: boolean;
  loadError: string;
  rows: FeedbackConvRow[];
}

interface FeedbackPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onLoad(query: { tab?: string }): void;
  onShow(): void;
  onBack(): void;
  onRetry(): void;
  onCtaTap(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
  onTabTap(e: WechatMiniprogram.TouchEvent): void;
  /** 会话行「已采纳」角标：闭环手势，跳路线 tab 看它进了排期/上线 */
  onAdoptedTap(): void;
  switchToTab(tab: TabId): void;
  fetchList(): Promise<void>;
  /** 慢响应回来时发现自己已过期则丢弃（同 product-roadmap._fetchSeq） */
  _fetchSeq: number;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function windowWidthPx(): number {
  try {
    return wx.getWindowInfo().windowWidth || 375;
  } catch {
    return wx.getSystemInfoSync().windowWidth || 375;
  }
}

function contentPaddingTopRpx(): number {
  const statusPx = statusBarHeight();
  // 顶栏 = 标题行 128rpx + tab 行 88rpx，再留 24rpx 呼吸（同 my-races）
  return Math.round((statusPx * 750) / windowWidthPx()) + 128 + 88 + 24;
}

Page<FeedbackPageData, FeedbackPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  _fetchSeq: 0,

  data: {
    statusBarHeight: 0,
    canBack: false,
    contentPaddingTop: 320,
    activeTab: 'feedback',
    roadmapMounted: false,
    loading: true,
    loadError: '',
    rows: [],
  },

  onLoad(query: { tab?: string }) {
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      contentPaddingTop: contentPaddingTopRpx(),
      // 深链直达路线 tab（如旧 product-roadmap 分享路径迁移过来时）
      ...(query.tab === 'roadmap' ? { activeTab: 'roadmap', roadmapMounted: true } : {}),
    });
  },

  onShow() {
    // 每次回到本页重拉：聊天页读即清后的未读态、新提交的会话都在这里对齐
    void this.fetchList();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onRetry() {
    void this.fetchList();
  },

  onCtaTap() {
    wx.navigateTo({ url: '/pages/feedback-form/feedback-form' });
  },

  onRowTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.navigateTo({ url: `/pages/feedback-chat/feedback-chat?id=${id}` });
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as TabId;
    if ((tab !== 'feedback' && tab !== 'roadmap') || tab === this.data.activeTab) return;
    this.switchToTab(tab);
  },

  onAdoptedTap() {
    this.switchToTab('roadmap');
  },

  switchToTab(tab: TabId) {
    this.setData({
      activeTab: tab,
      ...(tab === 'roadmap' && !this.data.roadmapMounted ? { roadmapMounted: true } : {}),
    });
    // 两 tab 内容长短不一且共用页面滚动，切换后回顶避免停在页底（同 my-races）
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  async fetchList() {
    const seq = ++this._fetchSeq;
    this.setData({ loading: !this.data.rows.length, loadError: '' });
    try {
      const res = await listFeedbacks();
      if (seq !== this._fetchSeq) return;
      this.setData({ loading: false, rows: toConvRows(res.items, Date.now()) });
    } catch (err) {
      if (seq !== this._fetchSeq) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      this.setData({ loading: false, loadError: msg.length > 20 ? '加载失败' : msg });
    }
  },
});
