// 手表绑定引导页 —— 新注册用户（registered=true）的一次性引导：
// 价值说明 + COROS/Garmin 入口（跳现有手表绑定页）+「稍后再说」跳过。
// onShow 检查手表绑定状态，已绑定则切换成功态并引导进入首页。
// 现有手表绑定页（pages/watch/watch）零改动。

import { getWatchInfo } from '../../services/watch';

interface WatchOnboardingPageData {
  connected: boolean;
}

interface WatchOnboardingPageHandlers {
  onProviderTap(e: WechatMiniprogram.TouchEvent): void;
  goHome(): void;
  checkWatchStatus(): Promise<void>;
}

Page<WatchOnboardingPageData, WatchOnboardingPageHandlers>({
  data: {
    connected: false,
  },

  onShow() {
    this.checkWatchStatus();
  },

  // 绑定状态以 STRIDE 数据面 GET /api/users/me/watch 的 logged_in 为准。
  // 查询失败不阻断引导（保持默认态，用户仍可跳过或进入绑定页）。
  async checkWatchStatus() {
    try {
      const info = await getWatchInfo();
      this.setData({ connected: info.logged_in });
    } catch {
      this.setData({ connected: false });
    }
  },

  onProviderTap(e: WechatMiniprogram.TouchEvent) {
    const provider = e.currentTarget.dataset.provider as string;
    if (provider !== 'coros' && provider !== 'garmin') return;
    wx.navigateTo({ url: '/pages/watch/watch' });
  },

  // 「稍后再说」与成功态的「进入首页」是同一动作：跳过引导 / 离开引导页
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
