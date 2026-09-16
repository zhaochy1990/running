// 隐私与权限页 —— 汇总合规声明入口（用户协议 / 隐私政策）。
// 声明正文走公开接口 GET /api/declarations/:doc_type（见 services/declarations.ts）。
import type { DeclarationDocType } from '../../services/declarations';

interface PrivacyRow {
  key: DeclarationDocType;
  title: string;
  subtitle: string;
  iconPath: string;
}

interface PrivacyPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  rows: PrivacyRow[];
}

interface PrivacyPageHandlers {
  onBack(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
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

// 与后端 LegalDocumentTypes 对齐；后续开放其它声明类型在这里加一行即可。
const PRIVACY_ROWS: PrivacyRow[] = [
  {
    key: 'user_agreement',
    title: '用户协议',
    subtitle: '服务条款与用户权利义务',
    iconPath: '/assets/icons/verified_user.svg',
  },
  {
    key: 'privacy_policy',
    title: '隐私政策',
    subtitle: '个人信息的收集、使用与保护',
    iconPath: '/assets/icons/visibility_off.svg',
  },
];

Page<PrivacyPageData, PrivacyPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    rows: PRIVACY_ROWS,
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onBack() {
    wx.navigateBack();
  },

  onRowTap(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key as DeclarationDocType;
    if (!key) return;
    wx.navigateTo({ url: `/pages/declaration/declaration?doc_type=${key}` });
  },
});
