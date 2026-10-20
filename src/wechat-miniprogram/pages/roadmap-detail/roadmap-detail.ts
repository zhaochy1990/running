// 产品路线详情页 —— 列表行只显示概述（≤50 字），markdown 详细正文只在
// 这里渲染（roadmap-panel 三区行点按进入；分享卡 path 自持，深链直落本页）。
// 正文渲染复用 utils/markdown（GFM→HTML，原始 HTML inert）+ mp-html，
// 深色 tagStyle 与 declaration / coach 页同源。
import { getRoadmapFeature } from '../../services/roadmap';
import { markdownToHtml } from '../../utils/markdown';
import { ApiError } from '../../services/request';

interface RoadmapDetailPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  error: string;
  title: string;
  /** markdownToHtml 产出的 HTML，经 <mp-html> 渲染；详情页唯一正文。 */
  html: string;
  containerStyle: string;
  tagStyle: Record<string, string>;
}

interface RoadmapDetailPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onLoad(query: Record<string, string | undefined>): void;
  onBack(): void;
  loadFeature(id: number): Promise<void>;
  /** 当前想法 id（非渲染数据，分享卡 path 用） */
  _featureId: number;
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

// 与 declaration 页同源的深色 mp-html 样式（主题一致，勿随手改色）。
const CONTAINER_STYLE = 'color:#e3e2e5;font-size:14px;line-height:22px;';
const TAG_STYLE: Record<string, string> = {
  p: 'margin:0 0 12px;color:#e3e2e5;',
  ul: 'margin:0 0 12px;padding-left:20px;color:#e3e2e5;',
  ol: 'margin:0 0 12px;padding-left:20px;color:#e3e2e5;',
  li: 'margin:0 0 4px;color:#e3e2e5;',
  h1: 'margin:16px 0 8px;color:#ffffff;font-weight:600;',
  h2: 'margin:16px 0 8px;color:#ffffff;font-weight:600;',
  h3: 'margin:14px 0 6px;color:#ffffff;font-weight:600;',
  h4: 'margin:14px 0 6px;color:#ffffff;font-weight:600;',
  h5: 'margin:14px 0 6px;color:#ffffff;font-weight:600;',
  h6: 'margin:14px 0 6px;color:#ffffff;font-weight:600;',
  blockquote:
    'margin:0 0 12px;padding-left:10px;border-left:3px solid rgba(255,255,255,0.18);color:#9c9c9d;',
  pre: 'margin:0 0 12px;padding:10px;background:#1d1e22;border-radius:8px;overflow-x:auto;color:#e3e2e5;',
  code: 'font-family:monospace;background:rgba(255,255,255,0.08);border-radius:4px;padding:0 4px;color:#e3e2e5;',
  a: 'color:#ffb3af;',
  table: 'border-collapse:collapse;margin:0 0 12px;width:100%;',
  th: 'border:1px solid rgba(255,255,255,0.14);padding:6px 8px;color:#ffffff;',
  td: 'border:1px solid rgba(255,255,255,0.14);padding:6px 8px;color:#e3e2e5;',
};

Page<RoadmapDetailPageData, RoadmapDetailPageHandlers>({
  _featureId: 0,

  data: {
    statusBarHeight: 0,
    contentPaddingTop: 240,
    loading: true,
    error: '',
    title: '',
    html: '',
    containerStyle: CONTAINER_STYLE,
    tagStyle: TAG_STYLE,
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });

    const id = Number(query.id);
    if (!id) {
      this.setData({ loading: false, error: '缺少想法 id' });
      return;
    }
    this._featureId = id;
    void this.loadFeature(id);
  },

  async loadFeature(id: number) {
    this.setData({ loading: true, error: '' });
    try {
      const f = await getRoadmapFeature(id);
      this.setData({
        loading: false,
        title: f.title,
        html: markdownToHtml(f.description),
      });
    } catch (err: unknown) {
      const fallback =
        err instanceof ApiError && err.statusCode === 404 ? '这个想法不存在或已下线' : '加载失败，请稍后重试';
      this.setData({ loading: false, error: fallback });
    }
  },

  // 分享/朋友圈落回本页（id 随卡携带），标题带想法名。
  onShareAppMessage() {
    const title = this.data.title ? `【产品路线】${this.data.title}` : '砺跑 · 产品路线';
    return { title, path: `/pages/roadmap-detail/roadmap-detail?id=${this._featureId}` };
  },

  onShareTimeline() {
    const title = this.data.title ? `【产品路线】${this.data.title}` : '砺跑 · 产品路线';
    return { title, query: `id=${this._featureId}` };
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});
