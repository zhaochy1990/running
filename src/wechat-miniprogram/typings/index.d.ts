/// <reference types="miniprogram-api-typings" />

// 全局类型补充
interface IAppOption {
  globalData: {
    token?: string;
    userInfo?: WechatMiniprogram.UserInfo;
    systemInfo?: WechatMiniprogram.SystemInfo;
  };
}
