import { logger } from './logger';

type ErrorEvent = 'error' | 'unhandled_rejection';
type ErrorCategory = 'stack_overflow' | 'invalid_listener' | 'type_error' | 'reference_error' | 'other';

// 避免异常处理自身触发错误时无限上报；每次小程序启动独立计数。
let errorReports = 0;
let memoryReports = 0;
const MAX_ERROR_REPORTS = 20;
const MAX_MEMORY_REPORTS = 5;

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    return [value.name, value.message, value.stack].filter((v) => typeof v === 'string').join('\n');
  }
  return '';
}

function errorCategory(text: string): ErrorCategory {
  if (/maximum call stack size exceeded|too much recursion/i.test(text)) return 'stack_overflow';
  if (/removeListener only takes instances of Function/i.test(text)) return 'invalid_listener';
  if (/\bTypeError\b/.test(text)) return 'type_error';
  if (/\bReferenceError\b/.test(text)) return 'reference_error';
  return 'other';
}

// 只保留固定脚本名和行列号，不上传错误原文、URL 参数、聊天内容或凭据。
function safeFrames(text: string): string[] {
  return (text.match(/\b(?:app-service|WAServiceMainContext|WASubAppSciEngine)\.js:\d{1,9}:\d{1,9}\b/g) || []).slice(0, 5);
}

function safeVersion(value: unknown): string {
  return typeof value === 'string' && /^\d+(?:\.\d+){0,4}$/.test(value) && value.length <= 32 ? value : 'unknown';
}

function safeDeviceText(value: unknown): string {
  return typeof value === 'string' && /^[一-鿿A-Za-z0-9 ._+(),/-]{1,64}$/.test(value) ? value : 'unknown';
}

function context() {
  let page = 'unknown';
  let appVersion = 'unknown';
  let envVersion = 'unknown';
  let sdkVersion = 'unknown';
  let wechatVersion = 'unknown';
  let platform = 'unknown';
  let model = 'unknown';
  let system = 'unknown';
  try {
    const pages = getCurrentPages();
    const route = pages[pages.length - 1]?.route;
    if (route && /^pages\/[a-zA-Z0-9/_-]{1,120}$/.test(route)) page = route;
  } catch { /* 启动早期可能还没有页面 */ }
  try {
    const miniProgram = wx.getAccountInfoSync().miniProgram;
    appVersion = safeVersion(miniProgram.version);
    if (['release', 'trial', 'develop'].includes(miniProgram.envVersion)) envVersion = miniProgram.envVersion;
  } catch { /* 旧基础库或账号信息暂不可用 */ }
  try {
    const info = wx.getAppBaseInfo();
    sdkVersion = safeVersion(info.SDKVersion);
    wechatVersion = safeVersion(info.version);
  } catch { /* 旧基础库可能不支持 */ }
  try {
    const info = wx.getDeviceInfo();
    if (['ios', 'android', 'ohos', 'ohos_pc', 'windows', 'mac', 'devtools'].includes(info.platform)) platform = info.platform;
    model = safeDeviceText(info.model);
    system = safeDeviceText(info.system);
  } catch { /* 旧基础库可能不支持 */ }
  return { page, appVersion, envVersion, sdkVersion, wechatVersion, platform, model, system };
}

export function reportRuntimeError(event: ErrorEvent, error: unknown): void {
  if (errorReports >= MAX_ERROR_REPORTS) return;
  errorReports++;
  try {
    const text = errorText(error);
    logger.error('[runtime-diagnostic]', { event, category: errorCategory(text), frames: safeFrames(text), ...context() });
  } catch { /* 诊断失败不能再引发新的异常 */ }
}

export function installMemoryWarningReporter(): void {
  try {
    if (typeof wx.onMemoryWarning !== 'function') return;
    wx.onMemoryWarning((res) => {
      if (memoryReports >= MAX_MEMORY_REPORTS) return;
      memoryReports++;
      try {
        const level = res?.level;
        logger.warn('[runtime-diagnostic]', { event: 'memory_warning', level: level === 5 || level === 10 || level === 15 ? level : null, ...context() });
      } catch { /* 告警和日志接口不可用时不影响应用 */ }
    });
  } catch { /* 旧基础库可能不支持内存告警 */ }
}
