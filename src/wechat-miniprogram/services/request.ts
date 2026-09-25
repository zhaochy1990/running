import { ApiErrorResponse } from '../types/api';
import { API_BASE_URL, AUTH_BASE_URL, CLIENT_ID, REQUEST_TIMEOUT, STORAGE_KEYS } from '../constants/config';

interface RequestOptions<T = unknown> {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  data?: T;
  header?: Record<string, string>;
  auth?: boolean;
  timeout?: number;
}

interface RequestResult<T> {
  data: T;
  statusCode: number;
  header: Record<string, string>;
}

interface WxRequestResponse {
  data: unknown;
  statusCode: number;
  header: Record<string, string>;
  errMsg?: string;
}

// 请求日志的敏感字段脱敏：只记长度，够判断「有没有带上」而不把密码/验证码原文
// 写进控制台。phone 等排障必需的字段保留原值。
const REDACT_KEYS = [
  'password',
  'code',
  'access_token',
  'refresh_token',
  'subject_token',
  'token',
];

function redact(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of REDACT_KEYS) {
    if (out[key] != null) out[key] = `<${String(out[key]).length} chars>`;
  }
  return out;
}

// wx.request 在当前模拟器/基础库环境只返回 RequestTask（不返回 Promise），
// 直接 `await wx.request(...)` 拿到的是 RequestTask 对象（没有 statusCode/data）。
// 这里用 success/fail 回调显式包一层 Promise，保证所有环境都能拿到响应。
//
// 所有 HTTP 都经过这里，所以请求日志也集中打在这一层：非 2xx 时打完整响应体。
// 页面上的中文错误文案是兜底映射后的结果（见 services/auth.ts 的
// BIND_ERROR_MESSAGES），真实 error code / message 只在响应体里 —— 排障先看这里。
function wxRequest(options: RequestOptions): Promise<WxRequestResponse> {
  const method = options.method || 'GET';

  console.log(`[http] → ${method} ${options.url}`, redact(options.data));

  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method: options.method,
      data: options.data,
      header: options.header,
      timeout: options.timeout,
      success: (res) => {
        const r = res as unknown as WxRequestResponse;
        if (r.statusCode >= 200 && r.statusCode < 300) {
          console.log(`[http] ← ${r.statusCode} ${method} ${options.url}`);
        } else {
          console.error(`[http] ← ${r.statusCode} ${method} ${options.url}`, r.data);
        }
        resolve(r);
      },
      // fail 是网络层失败（域名没配、超时、DNS），没有 statusCode，errMsg 才是线索
      fail: (err) => {
        console.error(`[http] ✗ ${method} ${options.url}`, err);
        reject(err);
      },
    } as WechatMiniprogram.RequestOption);
  });
}

// 正在进行中的 token 刷新 promise（防止并发刷新）
let refreshPromise: Promise<string> | null = null;

// 会话失效兜底：清本地 token，先试一次微信免密登录（token 失效/refresh 失败
// 不等于微信解绑——用户多半还绑着，重走 wx.login() 就能无感换回 JWT，不该把人
// 甩到登录页重做一遍手机号验证码），恢复不了才 reLaunch 登录页。
// 模块级 guard 避免多个并发 401 触发重复处理。
// 「退出登录」不经过这里：onLogout 是纯本地清理，不发请求也就没有 401，所以免密
// 重试不会把刚退出的用户静默登回去。
let redirectingToLogin = false;
// ponytail: 每个 app 生命周期只免密恢复一次。若新换来的 token 又被拒（时钟偏移 /
// audience 配错一类），无上限重试会变成 reLaunch 死循环；一次失败就退回登录页。
let recoveredOnce = false;

export function handleSessionExpired(): void {
  console.warn('[auth] 会话失效：清掉本地 token');
  wx.removeStorageSync(STORAGE_KEYS.TOKEN);
  wx.removeStorageSync(STORAGE_KEYS.REFRESH_TOKEN);
  wx.removeStorageSync(STORAGE_KEYS.TOKEN_EXPIRES_AT);
  wx.removeStorageSync(STORAGE_KEYS.USER_INFO);
  if (redirectingToLogin) {
    console.log('[auth] 已在处理会话失效，跳过重复触发');
    return;
  }
  redirectingToLogin = true;

  const recover = getApp<IAppOption>()?.recoverSession;
  if (!recover || recoveredOnce) {
    console.log(
      `[auth] 不尝试免密恢复（recoverSession=${recover ? '有' : '无'}, 本次启动已恢复过=${recoveredOnce}）→ 登录页`,
    );
    redirectToLogin();
    return;
  }
  recoveredOnce = true;
  console.log('[auth] 会话失效 → 尝试微信免密恢复');
  recover()
    .then((ok) => {
      if (!ok) {
        console.log('[auth] 免密恢复失败（未绑定 / 网络）→ 登录页');
        redirectToLogin();
        return;
      }
      console.log('[auth] 免密恢复成功 → 重进首页');
      // 新 token 已落好：重进首页，让页面按正常冷启动流程重新拉数据。
      wx.reLaunch({
        url: '/pages/index/index',
        complete: () => {
          redirectingToLogin = false;
        },
      });
    })
    // recoverSession 自己吞异常返回 false；这里兜的是它之外的意外，避免用户卡死
    // 在 redirectingToLogin=true 的僵局里再也回不去登录页。
    .catch(redirectToLogin);
}

function redirectToLogin(): void {
  wx.reLaunch({
    url: '/pages/login/login',
    complete: () => {
      redirectingToLogin = false;
    },
  });
}

export async function getToken(): Promise<string | undefined> {
  const res = wx.getStorageSync(STORAGE_KEYS.TOKEN);
  return res || undefined;
}

export async function refreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const refreshToken = wx.getStorageSync(STORAGE_KEYS.REFRESH_TOKEN);
      if (!refreshToken) {
        throw new Error('no_refresh_token');
      }

      const res = await wxRequest({
        url: `${AUTH_BASE_URL}/api/auth/refresh`,
        method: 'POST',
        data: { refresh_token: refreshToken },
        header: {
          'Content-Type': 'application/json',
          'X-Client-Id': CLIENT_ID,
        },
        timeout: REQUEST_TIMEOUT,
      });

      if (res.statusCode !== 200) {
        throw new Error('refresh_failed');
      }

      const { access_token, refresh_token, expires_in } = res.data as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      wx.setStorageSync(STORAGE_KEYS.TOKEN, access_token);
      wx.setStorageSync(STORAGE_KEYS.REFRESH_TOKEN, refresh_token);
      wx.setStorageSync(
        STORAGE_KEYS.TOKEN_EXPIRES_AT,
        Math.floor(Date.now() / 1000) + expires_in,
      );

      return access_token;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export class ApiError extends Error {
  public statusCode: number;
  public code?: string;
  public detail: string;

  constructor(statusCode: number, body: ApiErrorResponse) {
    // STRIDE 数据面错误体为 {detail, code}；auth-service 错误体为 {error, message}。
    super(body.message || body.detail || `Request failed with status ${statusCode}`);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = body.code || body.error;
    this.detail = body.detail || body.message || '';
  }
}

export async function request<TResponse, TData = unknown>(
  options: RequestOptions<TData>,
): Promise<TResponse> {
  const {
    url,
    method = 'GET',
    data,
    header = {},
    auth = true,
    timeout = REQUEST_TIMEOUT,
  } = options;

  const fullUrl = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Id': CLIENT_ID,
    ...header,
  };

  if (auth) {
    let token = await getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const execute = async (): Promise<TResponse> => {
    const res = await wxRequest({
      url: fullUrl,
      method,
      data,
      header: headers,
      timeout,
    });

    const result = res as unknown as RequestResult<TResponse | ApiErrorResponse>;

    // 成功（2xx）
    if (result.statusCode >= 200 && result.statusCode < 300) {
      return result.data as TResponse;
    }

    // 401：尝试刷新 token 后重试一次
    if (result.statusCode === 401 && auth) {
      try {
        const newToken = await refreshToken();
        headers.Authorization = `Bearer ${newToken}`;

        const retryRes = await wxRequest({
          url: fullUrl,
          method,
          data,
          header: headers,
          timeout,
        });

        const retryResult = retryRes as unknown as RequestResult<TResponse>;
        if (retryResult.statusCode >= 200 && retryResult.statusCode < 300) {
          return retryResult.data;
        }

        throw new ApiError(
          retryResult.statusCode,
          (retryResult.data as ApiErrorResponse) || { detail: 'Unauthorized' },
        );
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // 刷新失败 → 清 token 并回登录页（会话已失效），避免停留在业务页面的空态
        handleSessionExpired();
        throw new ApiError(401, { detail: 'Session expired', code: 'session_expired' });
      }
    }

    // 其他错误
    throw new ApiError(
      result.statusCode,
      (result.data as ApiErrorResponse) || { detail: 'Request failed' },
    );
  };

  return execute();
}

// 便捷方法
export const http = {
  get: <T>(url: string, options?: Omit<RequestOptions, 'url' | 'method'>) =>
    request<T>({ url, method: 'GET', ...options }),

  post: <T, D = unknown>(url: string, data?: D, options?: Omit<RequestOptions<D>, 'url' | 'method' | 'data'>) =>
    request<T, D>({ url, method: 'POST', data, ...options }),

  put: <T, D = unknown>(url: string, data?: D, options?: Omit<RequestOptions<D>, 'url' | 'method' | 'data'>) =>
    request<T, D>({ url, method: 'PUT', data, ...options }),

  patch: <T, D = unknown>(url: string, data?: D, options?: Omit<RequestOptions<D>, 'url' | 'method' | 'data'>) =>
    request<T, D>({ url, method: 'PATCH', data, ...options }),

  delete: <T>(url: string, options?: Omit<RequestOptions, 'url' | 'method'>) =>
    request<T>({ url, method: 'DELETE', ...options }),
};
