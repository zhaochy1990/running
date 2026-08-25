import { wechatLogin, hasValidToken } from './services/auth';
import { userStore } from './store';

App<IAppOption>({
  globalData: {
    token: undefined,
    userInfo: undefined,
    systemInfo: undefined,
  },

  onLaunch() {
    // 获取系统信息（一次即可）
    wx.getSystemInfo({
      success: (res) => {
        this.globalData.systemInfo = res;
      },
    });

    // 启动时执行登录态检查
    this.checkAuth();
  },

  /**
   * 检查登录态：
   * 1. 本地有有效 token → 视为已登录，进入首页
   * 2. 无 token → 调微信登录接口
   *    - 已绑定账号 → 存 token，进入首页
   *    - 未绑定 → 跳转到绑定页（保留当前微信 session）
   */
  async checkAuth(): Promise<void> {
    userStore.setLoading(true);

    try {
      // 本地 token 仍然有效
      if (hasValidToken()) {
        const user = userStore.getState().user;
        if (user?.wechat_bound) {
          userStore.setLoading(false);
          return;
        }
      }

      // 调微信登录换 JWT
      const result = await wechatLogin();

      if (result.ok) {
        userStore.setUser(result.user);
      } else {
        // 未绑定 → 跳绑定页
        wx.reLaunch({
          url: '/pages/bind/bind',
        });
      }
    } catch (err) {
      // 登录失败 → 跳绑定页让用户手动操作
      console.error('[auth] wechat login failed:', err);
      wx.reLaunch({
        url: '/pages/bind/bind',
      });
    } finally {
      userStore.setLoading(false);
    }
  },
});
