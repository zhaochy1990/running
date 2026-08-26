import { wechatLogin, hasValidToken, validateSession } from './services/auth';
import { ApiError } from './services/request';
import { userStore } from './store/index';

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
   * 1. 本地有 token → 主动向 auth-service 验证它是否仍被服务端接受（GET /api/users/me）。
   *    - 有效 → 视为已登录，进入首页
   *    - 服务端已拒绝（且 refresh 也失败）→ 清会话并回登录页
   *    - 网络等非认证错误 → 保留本地会话，交给数据页处理，不误登出
   * 2. 无 token → 用 wx.login() 的 code 换 JWT
   *    - 已绑定账号 → 存 token，进入首页
   *    - 未绑定 → 跳转到登录页（邮箱登录即绑定已有 STRIDE 账号）
   */
  async checkAuth(): Promise<void> {
    const hadToken = hasValidToken();
    userStore.setLoading(true);

    try {
      // 本地已有 token：不要仅凭本地 expiresAt 判定有效（它可能是「本地未过期但服务端
      // 已失效/吊销」的 token），主动向服务端验证一次，避免出现假登录态留在首页。
      if (hadToken) {
        const user = await validateSession();
        userStore.setUser(user);
        return;
      }

      // 无本地 token → 调微信登录换 JWT
      const result = await wechatLogin();

      if (result.ok) {
        userStore.setUser(result.user);
      } else {
        // 未绑定 → 跳登录页（邮箱登录即绑定已有 STRIDE 账号）
        wx.reLaunch({
          url: '/pages/login/login',
        });
      }
    } catch (err) {
      const authFailure =
        err instanceof ApiError &&
        (err.statusCode === 401 || err.code === 'session_expired');

      console.error(
        '[auth] login state check failed:',
        err instanceof Error ? err.message : err,
      );

      if (!hadToken) {
        // 无本地 token 且微信登录失败（未绑定已单独处理）→ 回登录页让用户手动处理
        userStore.clear();
        wx.reLaunch({
          url: '/pages/login/login',
        });
        return;
      }

      if (authFailure) {
        // 本地 token 被服务端拒绝：request.ts 已清 token 并 reLaunch 到登录页，
        // 这里仅清理内存态（isAuthenticated=false），避免重复导航。
        userStore.clear();
      }
      // 本地有 token 且非认证失败（如纯网络错误）→ 保留本地会话，不误登出。
    } finally {
      userStore.setLoading(false);
    }
  },
});
