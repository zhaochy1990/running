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
  // 会话失效后的免密恢复，供 request.ts 经 getApp() 取用。声明为可选：跨模块
  // 用 getApp() 拿到的实例不保证已注册，调用方会判一手再调。
  recoverSession?: () => Promise<boolean>;
}
