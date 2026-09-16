// 声明详情页 —— 渲染用户协议 / 隐私政策等合规声明的当前生效版本。
// 入口：pages/privacy 的菜单行，参数 doc_type（见 services/declarations.ts 白名单）。
import {
  getDeclaration,
  isDeclarationDocType,
  DECLARATION_TITLES,
  type DeclarationDocType,
} from '../../services/declarations';
import { markdownToHtml } from '../../utils/markdown';
import { ApiError } from '../../services/request';

interface DeclarationPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  error: string;
  title: string;
  /** markdownToHtml 产出的 HTML，经 <mp-html> 渲染。 */
  html: string;
  // mp-html 样式：容器兜底颜色/字重 + 结构化 tag 样式（深色主题，与 coach 页一致）。
  containerStyle: string;
  tagStyle: Record<string, string>;
}

interface DeclarationPageHandlers {
  onBack(): void;
  loadDeclaration(docType: DeclarationDocType): Promise<void>;
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

Page<DeclarationPageData, DeclarationPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    error: '',
    title: '',
    html: '',
    containerStyle: 'color:#e3e2e5;font-size:14px;line-height:22px;',
    tagStyle: {
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
    },
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });

    const docType = query.doc_type || '';
    if (!isDeclarationDocType(docType)) {
      this.setData({ loading: false, error: '未知的声明类型' });
      return;
    }
    this.setData({ title: DECLARATION_TITLES[docType] });
    void this.loadDeclaration(docType);
  },

  async loadDeclaration(docType: DeclarationDocType) {
    this.setData({ loading: true, error: '' });
    try {
      const doc = await getDeclaration(docType);
      this.setData({
        loading: false,
        title: doc.title || this.data.title,
        html: markdownToHtml(doc.content_markdown),
      });
    } catch (err: unknown) {
      const fallback = err instanceof ApiError && err.statusCode === 404
        ? '该声明尚未发布'
        : '加载失败，请稍后重试';
      this.setData({ loading: false, error: fallback });
    }
  },

  onBack() {
    wx.navigateBack();
  },
});
