// 意见反馈·聊天页（devops#554；原型 518 variant C）。
// 结构：chat-head（type/状态 tag + 已采纳 tag）→ 已采纳横幅（🏆 + 去投票 ›）
// → 首卡（原文正文 + 图）→ 气泡流（官方左「STRIDE 团队」/ 本人右，多轮）
// → 常驻输入条；closed 会话禁言（提示提交新反馈）。
// 进入即 GET /feedbacks/:id —— 服务端读即清官方回复未读（红点清零的服务端真相）。
// adopted_feature_id 只回 id，标题从 GET /api/roadmap 反查，查不到仅隐藏标题。

import { getFeedbackDetail, replyFeedback, type FeedbackReply } from '../../services/feedback';
import { getRoadmap } from '../../services/roadmap';
import { ApiError } from '../../services/request';
import { feedbackTimeLabel } from '../../utils/feedbackRows';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

const TYPE_META: Record<string, { emoji: string; label: string; cls: string }> = {
  bug: { emoji: '🐞', label: 'Bug 反馈', cls: 'tag--bug' },
  suggestion: { emoji: '💡', label: '产品建议', cls: 'tag--idea' },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: '待处理', cls: 'tag--open' },
  replied: { label: '已回复', cls: 'tag--replied' },
  closed: { label: '已关闭', cls: 'tag--closed' },
};

interface BubbleRow {
  id: number;
  who: 'pm' | 'me';
  text: string;
  time: string;
}

interface FeedbackChatPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1（冷开分享卡直达）显示回主页的小房子 */
  canBack: boolean;
  contentPaddingTop: number;
  loading: boolean;
  loadError: string;
  /** 首卡头部 tag 行 */
  head: { typeLabel: string; typeCls: string; statusLabel: string; statusCls: string; adopted: boolean };
  card: { content: string; imageUrls: string[]; time: string };
  /** 已采纳关联的产品路线标题；空串 = 隐藏「」段 */
  adoptedTitle: string;
  bubbles: BubbleRow[];
  closed: boolean;
  draft: string;
  sending: boolean;
  /** scroll-view scroll-into-view 锚点，新回合后滚到底 */
  scrollInto: string;
  /** 草稿非空且不在发送中（wxml 不能调 .trim()，在 ts 算好） */
  canSend: boolean;
}

interface FeedbackChatPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBack(): void;
  onRetry(): void;
  onGoVote(): void;
  onPreviewImage(e: WechatMiniprogram.TouchEvent): void;
  onDraftInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  /** closed 禁言条里的「提交新反馈」→ 表单页 */
  onNewFeedback(): void;
  onSend(): void;
  fetchThread(): Promise<void>;
  _id: number;
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
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

function toBubbles(replies: FeedbackReply[], nowMs: number): BubbleRow[] {
  return replies.map((r) => ({
    id: r.id,
    who: r.author === 'user' ? 'me' : 'pm',
    text: r.content,
    time: feedbackTimeLabel(r.created_at, nowMs),
  }));
}

Page<FeedbackChatPageData, FeedbackChatPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  _id: 0,
  _fetchSeq: 0,

  data: {
    statusBarHeight: 0,
    canBack: false,
    contentPaddingTop: 232,
    loading: true,
    loadError: '',
    head: { typeLabel: '', typeCls: '', statusLabel: '', statusCls: '', adopted: false },
    card: { content: '', imageUrls: [], time: '' },
    adoptedTitle: '',
    bubbles: [],
    closed: false,
    draft: '',
    sending: false,
    canSend: false,
    scrollInto: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    this._id = Number(options.id) || 0;
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      contentPaddingTop: contentPaddingTopRpx(),
    });
    void this.fetchThread();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onRetry() {
    void this.fetchThread();
  },

  onGoVote() {
    wx.navigateTo({ url: '/pages/product-roadmap/product-roadmap' });
  },

  onPreviewImage(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) return;
    wx.previewImage({ urls: this.data.card.imageUrls, current: this.data.card.imageUrls[index] });
  },

  onDraftInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const draft = e.detail.value;
    this.setData({ draft, canSend: draft.trim().length > 0 });
  },

  onNewFeedback() {
    wx.navigateTo({ url: '/pages/feedback-form/feedback-form' });
  },

  async onSend() {
    const text = this.data.draft.trim();
    if (!text || this.data.closed || this.data.sending || !this._id) return;
    this.setData({ sending: true });
    try {
      const reply = await replyFeedback(this._id, text);
      const bubbles = this.data.bubbles.concat({
        id: reply.id,
        who: reply.author === 'user' ? 'me' : 'pm',
        text: reply.content,
        time: feedbackTimeLabel(reply.created_at, Date.now()),
      });
      this.setData({ bubbles, draft: '', canSend: false, scrollInto: `bubble-${bubbles.length - 1}` });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'feedback_closed') {
        this.setData({ closed: true });
        wx.showToast({ title: '该反馈已关闭，如有问题请提交新反馈', icon: 'none' });
      } else {
        wx.showToast({ title: '发送失败，请重试', icon: 'none' });
      }
    } finally {
      this.setData({ sending: false });
    }
  },

  async fetchThread() {
    if (!this._id) {
      this.setData({ loading: false, loadError: '会话不存在' });
      return;
    }
    const seq = ++this._fetchSeq;
    this.setData({ loading: !this.data.bubbles.length, loadError: '' });
    try {
      const [detail, roadmap] = await Promise.all([
        getFeedbackDetail(this._id),
        // adopted 标题反查；路线图拉不到不阻塞线程展示
        getRoadmap().catch(() => null),
      ]);
      if (seq !== this._fetchSeq) return;

      const fb = detail.feedback;
      const typeMeta = TYPE_META[fb.type] || TYPE_META.bug;
      const statusMeta = STATUS_META[fb.status] || STATUS_META.open;
      const adopted = fb.adopted_feature_id != null;
      let adoptedTitle = '';
      if (adopted && roadmap) {
        const all = [...roadmap.backlog, ...roadmap.accepted, ...roadmap.released];
        const hit = all.find((f) => f.id === fb.adopted_feature_id);
        adoptedTitle = hit ? hit.title : '';
      }
      const nowMs = Date.now();
      const bubbles = toBubbles(detail.replies, nowMs);
      this.setData({
        loading: false,
        head: {
          typeLabel: typeMeta.label,
          typeCls: typeMeta.cls,
          statusLabel: statusMeta.label,
          statusCls: statusMeta.cls,
          adopted,
        },
        card: {
          content: fb.content,
          imageUrls: fb.image_urls || [],
          time: feedbackTimeLabel(fb.created_at, nowMs),
        },
        adoptedTitle,
        bubbles,
        closed: fb.status === 'closed',
        scrollInto: bubbles.length ? `bubble-${bubbles.length - 1}` : '',
      });
    } catch (err) {
      if (seq !== this._fetchSeq) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      this.setData({ loading: false, loadError: msg.length > 20 ? '加载失败' : msg });
    }
  },
});
