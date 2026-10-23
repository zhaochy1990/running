// 教练聊天分享免登录只读阅读端 —— devops#718（Epic #713 wave2 P5，设计 #624 定稿
// D 变体=像素级参照，过期态 #622）。
// 接收者（可未登录）点开分享卡 ?sid= 或扫小程序码 scene 直达：免登录拉公开快照
// GET /api/coach-shares/:sid（#715，{auth:false} 不发 Authorization），D 气泡对话
// 流·浅色渲染：用户浅粉右气泡 / 教练白底 markdown 左气泡（mp-html 浅色 tagStyle）
// / 策略卡静态摘要降级（utils/coachShareRows）。410 过期与 404 不存在各出空态，
// 网络/频控失败可重试。底部品牌条常驻：wxacode 码图 + 再转发（onShareAppMessage
// 返回同一 sid path，#624 Q3）。免登录冷开由 app.ts PUBLIC_ENTRY_PAGES 白名单放行
// （#692 机制，workout-share #702 先例）。
import { ApiError } from '../../services/request';
import { getCoachShare, type CoachShareSnapshot } from '../../services/coach';
import { buildCoachShareMessages, type CoachShareMessageVM } from '../../utils/coachShareRows';
import { epochToShanghaiYmd } from '../../utils/date';
import { defaultShareAppMessage } from '../../utils/share';

/** 「2026-10-21」→「10月21日」（顶栏 meta 用）。 */
function monthDayLabel(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8))}日`;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

interface CoachSharePageData {
  statusBarHeight: number;
  /** loading：请求中；ready：已渲染；expired：410 过期；notfound：404；error：网络/频控失败可重试 */
  loadState: 'loading' | 'ready' | 'expired' | 'notfound' | 'error';
  /** 顶栏标题：「{sharer_name||TA} 分享的教练对话」 */
  title: string;
  /** 顶栏 meta：「10月21日 · 8 条消息」 */
  meta: string;
  messages: CoachShareMessageVM[];
  /** 码图 URL；空串回退品牌占位块（wxacode fail-soft 可为 null） */
  wxacodeUrl: string;
  /** mp-html 浅色主题样式（#624 D：coach 页深色 tagStyle 的浅色版） */
  containerStyle: string;
  tagStyle: Record<string, string>;
}

interface CoachSharePageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  onRetryTap(): void;
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  load(): Promise<void>;
  /** 拉到快照后构建视图模型。 */
  applyView(res: CoachShareSnapshot): void;
  /** 链接参数（onLoad 解析；retry 复用） */
  _sid: string;
  /** 再转发 title 用：分享者展示名（快照未带回落「TA」）与消息条数 */
  _sharerName: string;
  _count: number;
}

Page<CoachSharePageData, CoachSharePageHandlers>({
  data: {
    statusBarHeight: 0,
    loadState: 'loading',
    title: '',
    meta: '',
    messages: [],
    wxacodeUrl: '',
    containerStyle: 'color:#33353a;font-size:13.5px;line-height:21px;',
    tagStyle: {
      p: 'margin:0 0 10px;color:#33353a;',
      ul: 'margin:0 0 10px;padding-left:20px;color:#33353a;',
      ol: 'margin:0 0 10px;padding-left:20px;color:#33353a;',
      li: 'margin:0 0 4px;color:#33353a;',
      h1: 'margin:10px 0 6px;color:#d94f4f;',
      h2: 'margin:10px 0 6px;color:#d94f4f;',
      h3: 'margin:10px 0 6px;color:#d94f4f;',
      h4: 'margin:10px 0 6px;color:#d94f4f;font-weight:600;',
      h5: 'margin:10px 0 6px;color:#d94f4f;font-weight:600;',
      h6: 'margin:10px 0 6px;color:#d94f4f;font-weight:600;',
      blockquote:
        'margin:0 0 10px;padding-left:10px;border-left:3px solid rgba(0,0,0,0.12);color:#6b6d74;',
      pre: 'margin:0 0 10px;padding:10px;background:#f1f1f3;border-radius:8px;overflow-x:auto;color:#33353a;',
      code: 'font-family:monospace;background:rgba(0,0,0,0.06);border-radius:4px;padding:0 4px;color:#33353a;',
      a: 'color:#d94f4f;',
      // markdownToHtml 会产出 GFM 表格；无样式时无边框无对齐，不可读。
      table: 'width:100%;margin:0 0 10px;border-collapse:collapse;color:#33353a;',
      th: 'padding:6px 8px;border:1px solid #e8e8ea;color:#6b6d74;font-weight:600;text-align:left;',
      td: 'padding:6px 8px;border:1px solid #e8e8ea;color:#33353a;',
    },
  },

  _sid: '',
  _sharerName: '',
  _count: 0,

  onLoad(options) {
    // 分享卡带 ?sid=；小程序码 scene 直达（wxacode scene=sid，URL 编码落地）。
    let scene = '';
    if (options.scene) {
      try {
        scene = decodeURIComponent(options.scene);
      } catch {
        scene = options.scene;
      }
    }
    this._sid = String(options.sid || scene || '');
    this.setData({ statusBarHeight: statusBarHeight() });
    if (!this._sid) {
      this.setData({ loadState: 'notfound' });
      return;
    }
    void this.load();
  },

  onRetryTap() {
    this.setData({ loadState: 'loading' });
    void this.load();
  },

  async load() {
    try {
      const res = await getCoachShare(this._sid);
      this.applyView(res);
    } catch (err: unknown) {
      // 410 过期 / 404 不存在各自空态；429 频控、5xx、网络失败归可重试。
      const status = err instanceof ApiError ? err.statusCode : 0;
      if (status === 410) {
        this.setData({ loadState: 'expired' });
      } else if (status === 404) {
        this.setData({ loadState: 'notfound' });
      } else {
        this.setData({ loadState: 'error' });
      }
    }
  },

  applyView(res: CoachShareSnapshot) {
    // created_at 是 UTC ISO 串，按上海时区取日期（早于 08:00 的分享 UTC 日期
    // 会差一天，不能用字符串切片）。
    const epoch = Date.parse(res.created_at);
    const ymd = Number.isNaN(epoch) ? '' : epochToShanghaiYmd(epoch);
    this._sharerName = res.sharer_name || '';
    this._count = res.message_count;
    this.setData({
      loadState: 'ready',
      title: `${res.sharer_name || 'TA'} 分享的教练对话`,
      meta: `${ymd ? `${monthDayLabel(ymd)} · ` : ''}${res.message_count} 条消息`,
      messages: buildCoachShareMessages(res.messages),
      wxacodeUrl: res.wxacode_url || '',
    });
  },

  /** 再转发（#624 Q3）：同一 sid path，接收者可继续转。title=T1 中性事实型
   *  （#624 Q4），快照未带名字回落「TA」；未就绪回落品牌分享。 */
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    if (this.data.loadState !== 'ready') {
      return defaultShareAppMessage();
    }
    return {
      title: `${this._sharerName || 'TA'} 与 AI 教练的对话 · ${this._count} 条`,
      path: `/pages/coach-share/coach-share?sid=${encodeURIComponent(this._sid)}`,
    };
  },
});
