import { wechatLogin, hasValidToken, validateSession } from './services/auth';
import { ApiError } from './services/request';
import { userStore } from './store/index';

// 免密登录：用 wx.login() 的 code 换 JWT。微信已绑定 → 存好 token/user 返回 true；
// 未绑定或失败 → 返回 false。函数本身不导航，由调用方决定去哪。
async function silentLogin(): Promise<boolean> {
  try {
    const result = await wechatLogin();
    if (!result.ok) return false;
    userStore.setUser(result.user);
    return true;
  } catch (err) {
    console.error(
      '[auth] silent login failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

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
   *    - 服务端已拒绝（且 refresh 也失败）→ request.ts 的 handleSessionExpired 接管：
   *      先试一次免密登录，成不成才决定进首页还是登录页（见 recoverSession）
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

      // 无本地 token → 免密登录换 JWT
      // 未绑定 → 跳登录页（邮箱登录即绑定已有 STRIDE 账号）
      if (!(await silentLogin())) {
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

      // 走到这里只可能是「本地有 token 且校验抛错」：无 token 那条件分支的失败
      // 已由 silentLogin 自己吞掉并返回 false（不抛）。
      if (authFailure) {
        // 本地 token 被服务端拒绝：request.ts 已清掉本地 token 并接管导航
        // （先免密恢复，不行才去登录页），这里仅清理内存态，避免重复导航。
        // 若免密恢复随后成功，userStore.setUser 会把 isAuthenticated 再置回 true。
        userStore.clear();
      }
      // 本地有 token 且非认证失败（如纯网络错误）→ 保留本地会话，不误登出。
    } finally {
      userStore.setLoading(false);
    }
  },

  /**
   * 会话失效后的免密恢复，由 request.ts 的 handleSessionExpired 兜底调用。
   * token 失效/refresh 失败不等于微信解绑：此时用户微信多半还绑着，重走
   * wx.login() 即可无感换回 JWT，不该把人甩到登录页重做一遍手机号验证码。
   * 返回 true 表示已恢复并落好新 token；false 表示确实未绑定或网络失败。
   */
  recoverSession(): Promise<boolean> {
    return silentLogin();
  },
});
