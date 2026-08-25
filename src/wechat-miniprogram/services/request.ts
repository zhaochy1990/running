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

// wx.request 在当前模拟器/基础库环境只返回 RequestTask（不返回 Promise），
// 直接 `await wx.request(...)` 拿到的是 RequestTask 对象（没有 statusCode/data）。
// 这里用 success/fail 回调显式包一层 Promise，保证所有环境都能拿到响应。
function wxRequest(options: RequestOptions): Promise<WxRequestResponse> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method: options.method,
      data: options.data,
      header: options.header,
      timeout: options.timeout,
      success: (res) => resolve(res as unknown as WxRequestResponse),
      fail: (err) => reject(err),
    } as WechatMiniprogram.RequestOption);
  });
}

// 正在进行中的 token 刷新 promise（防止并发刷新）
let refreshPromise: Promise<string> | null = null;

async function getToken(): Promise<string | undefined> {
  const res = wx.getStorageSync(STORAGE_KEYS.TOKEN);
  return res || undefined;
}

async function refreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = wx.getStorageSync(STORAGE_KEYS.REFRESH_TOKEN);
    if (!refreshToken) {
      throw new Error('no_refresh_token');
    }

    try {
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
        // 刷新失败 → 清 token，由上层处理（跳转绑定页等）
        wx.removeStorageSync(STORAGE_KEYS.TOKEN);
        wx.removeStorageSync(STORAGE_KEYS.REFRESH_TOKEN);
        wx.removeStorageSync(STORAGE_KEYS.TOKEN_EXPIRES_AT);
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
