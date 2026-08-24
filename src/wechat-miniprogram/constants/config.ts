// 环境与运行时配置
// 注意：小程序正式版 baseURL 需要在微信公众平台配置 request 合法域名

export const ENV = {
  DEV: 'dev',
  STAGING: 'staging',
  PROD: 'prod',
} as const;

export type Env = typeof ENV[keyof typeof ENV];

// 当前环境 —— 开发期改这里，正式发布前切到 PROD
// 也可通过微信开发者工具的条件编译区分体验版/正式版
export const CURRENT_ENV: Env = ENV.DEV;

const API_BASE_URLS: Record<Env, string> = {
  [ENV.DEV]: 'http://127.0.0.1:8080',
  [ENV.STAGING]: 'https://staging.stride.run',
  [ENV.PROD]: 'https://stride.run',
};

export const API_BASE_URL = API_BASE_URLS[CURRENT_ENV];

// 客户端标识 —— 与 web/mobile 对齐，用于后端识别来源
export const CLIENT_ID = 'wechat-miniprogram';

// 存储 key 常量
export const STORAGE_KEYS = {
  TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  TOKEN_EXPIRES_AT: 'token_expires_at',
  USER_INFO: 'user_info',
} as const;

// 网络请求超时（毫秒）
export const REQUEST_TIMEOUT = 15000;

// token 过期前多少秒提前刷新
export const TOKEN_REFRESH_LEAD_SECONDS = 60;
