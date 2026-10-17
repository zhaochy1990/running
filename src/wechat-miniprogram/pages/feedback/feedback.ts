// 意见反馈·会话列表页（devops#554；原型 prototypes/518-feedback-spike.html
// variant C 定稿）。结构：提交入口卡（💬 CTA）→ 会话行（emoji 头像 + 标题 +
// 已采纳角标 + 时间 / 末条预览「官方：/我：」+ 未读点）→ 隐私脚注。
// 未读红点数据来自 GET /feedbacks 的 items[].unread；onShow 每次重拉，
// 从聊天页（服务端读即清）返回后红点自然消失。纯行逻辑在 utils/feedbackRows。

import { listFeedbacks } from '../../services/feedback';
import { toConvRows, type FeedbackConvRow } from '../../utils/feedbackRows';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

interface FeedbackPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  loadError: string;
  rows: FeedbackConvRow[];
}

interface FeedbackPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onLoad(): void;
  onShow(): void;
  onBack(): void;
  onRetry(): void;
  onCtaTap(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
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
  // 顶栏 = 标题行 128rpx，再留 24rpx 呼吸
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

Page<FeedbackPageData, FeedbackPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  _fetchSeq: 0,

  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    loadError: '',
    rows: [],
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onShow() {
    // 每次回到本页重拉：聊天页读即清后的未读态、新提交的会话都在这里对齐
    void this.fetchList();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/profile/profile' }) });
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
