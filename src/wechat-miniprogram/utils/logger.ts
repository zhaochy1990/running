// 生产排障日志：微信实时日志（公众平台 → 运维中心 → 实时日志）。
// 仅线上/体验版生效，按用户/版本可查；开发工具里看不到。API 不可用时静默降级。
const rt = wx.getRealtimeLogManager ? wx.getRealtimeLogManager() : null;

export const logger = {
  info(...args: unknown[]): void {
    rt?.info(...args);
  },
  warn(...args: unknown[]): void {
    rt?.warn(...args);
  },
  error(...args: unknown[]): void {
    rt?.error(...args);
  },
};
