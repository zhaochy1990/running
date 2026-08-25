/// <reference types="miniprogram-api-typings" />

// 全局类型补充
interface IAppOption {
  globalData: {
    token?: string;
    userInfo?: WechatMiniprogram.UserInfo;
    systemInfo?: WechatMiniprogram.SystemInfo;
  };
  // app.ts 里定义的自定义方法（onLaunch 中调用）
  checkAuth: () => Promise<void>;
}
