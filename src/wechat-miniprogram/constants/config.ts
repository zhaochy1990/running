// 环境与运行时配置
// 注意：小程序正式版 baseURL 需要在微信公众平台配置 request 合法域名

export const ENV = {
  DEV: 'dev',
  STAGING: 'staging',
  PROD: 'prod',
} as const;

export type Env = typeof ENV[keyof typeof ENV];

const API_BASE_URLS: Record<Env, string> = {
  [ENV.DEV]: 'http://127.0.0.1:3000',
  [ENV.STAGING]: 'https://staging.stride.run',
  [ENV.PROD]: 'https://api.stride-running.cn',
};
const AUTH_BASE_URLS: Record<Env, string> = {
  [ENV.DEV]: 'http://127.0.0.1:3001',
  [ENV.STAGING]: 'https://api.stride-running.cn',
  [ENV.PROD]: 'https://api.stride-running.cn',
};
const COACH_BASE_URLS: Record<Env, string> = {
  [ENV.DEV]: 'http://127.0.0.1:8888',
  [ENV.STAGING]: 'https://api.stride-running.cn',
  [ENV.PROD]: 'http://127.0.0.1:8888',
};
const client_ids: Record<Env, string> = {
  [ENV.DEV]: 'app_43290db46d71409caa36fc4d',
  [ENV.STAGING]: '',
  [ENV.PROD]: 'app_895073719c0147368b8feed3',
}

export const CURRENT_ENV: Env = ENV.PROD;
export const API_BASE_URL = API_BASE_URLS[CURRENT_ENV];
export const AUTH_BASE_URL = AUTH_BASE_URLS[CURRENT_ENV];
export const COACH_BASE_URL = COACH_BASE_URLS[CURRENT_ENV];


export const CLIENT_ID = client_ids[CURRENT_ENV];

// 存储 key 常量
export const STORAGE_KEYS = {
  TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  TOKEN_EXPIRES_AT: 'token_expires_at',
  USER_INFO: 'user_info',
} as const;

// 网络请求超时（毫秒）
export const REQUEST_TIMEOUT = 15000;

// Coach 对话超时（毫秒）。coach turn 是 LLM 编排，可能明显慢于普通读接口，
// 单独放宽（微信 60s 上限），避免快速误判失败落兜底文案。
export const COACH_REQUEST_TIMEOUT = 2000;

// token 过期前多少秒提前刷新
export const TOKEN_REFRESH_LEAD_SECONDS = 60;
