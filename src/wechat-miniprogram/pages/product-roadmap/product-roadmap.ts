// 产品路线页 —— 深链/分享宿主薄壳：路线 UI 已抽至 components/roadmap-panel
// （与意见反馈页二级 tab 共用），本页只保留顶栏与容器，让既有
// /pages/product-roadmap/product-roadmap 路径继续可用。
// 面板 attached / 页面 onShow 各自拉取，本页无自有数据逻辑。

import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

interface ProductRoadmapPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
}

interface ProductRoadmapPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onLoad(): void;
  onBack(): void;
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

Page<ProductRoadmapPageData, ProductRoadmapPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,

  data: {
    statusBarHeight: 0,
    contentPaddingTop: 240,
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});
