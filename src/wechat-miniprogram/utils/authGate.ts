// 登录引导统一入口（微信审核合规）：
// 1. 进登录页一律 navigateTo，保留返回栈 —— 物理返回键/导航栏返回随时可离开登录流程；
// 2. 登录页自带「暂不登录」出口（switchTab 回教练首页游客态）—— 用户可拒绝登录继续浏览，
//    不存在「取消/返回无效」的困局。全仓不允许再出现 reLaunch 进登录页的写法。
//
// redirect 语义与登录页 onLoad 的 sanitizeRedirect 一致：登录成功后 reLaunch 回目标页
// （tab 页也可以，reLaunch 支持），不带则走登录页默认落点（新注册 onboarding / 老用户教练首页）。
export function openLogin(redirect?: string): void {
  const url = redirect
    ? `/pages/login/login?redirect=${encodeURIComponent(redirect)}`
    : '/pages/login/login';
  wx.navigateTo({
    url,
    // 页面栈满（上限 10 层）等极端情况兜底 reLaunch
    fail: () => wx.reLaunch({ url }),
  });
}

// 当前页完整路径（path?query），用作 openLogin 的 redirect；取不到返回空串。
export function currentRouteForRedirect(): string {
  const pages = getCurrentPages();
  const current = pages[pages.length - 1];
  if (!current) return '';
  const query = Object.entries(current.options || {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `/${current.route}${query ? `?${query}` : ''}`;
}
