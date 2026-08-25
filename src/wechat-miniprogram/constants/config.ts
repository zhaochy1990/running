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
  [ENV.DEV]: 'http://127.0.0.1:3100',
  [ENV.STAGING]: 'https://staging.stride.run',
  [ENV.PROD]: 'https://stride.run',
};

export const API_BASE_URL = API_BASE_URLS[CURRENT_ENV];

// auth-service 地址 —— 独立 IDaaS，走自己的前门（腾讯云网关；Caddy 把
// /oauth/*、/api/auth/*、/api/users/me 路由到 auth-backend）。
// 与 API_BASE_URL（STRIDE 数据面）分离：小程序只把 auth-service 端点打到这里。
// 注意：正式版微信要求 request 合法域名必须是已备案的 https 域名（IP 不允许），
// 上线前需要给 auth-service 配一个正式域名（或扩展 BFF 代理 /oauth/* 与 auth 的
// /api/users/me），并把该域名加入小程序后台 request 合法域名。
const AUTH_BASE_URLS: Record<Env, string> = {
  [ENV.DEV]: 'http://127.0.0.1:3100',
  [ENV.STAGING]: 'https://124.221.38.59',
  [ENV.PROD]: 'https://124.221.38.59',
};

export const AUTH_BASE_URL = AUTH_BASE_URLS[CURRENT_ENV];

// 客户端标识 —— OAuth2 public client（token_exchange 时随请求体发送 client_id 即可，
// 不需要 client secret；public client 的 secret 无法在客户端代码里保密）。
export const CLIENT_ID = 'app_43290db46d71409caa36fc4d';

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
