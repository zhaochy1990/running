import { http, ApiError } from './request';
import { AUTH_BASE_URL, CLIENT_ID, STORAGE_KEYS } from '../constants/config';
import { ApiErrorCode } from '../types/api';
import type { AuthTokenResponse, UserProfile, WechatLoginResult } from '../types/api';

// auth-service 端点（独立 IDaaS 前门，见 constants/config.ts 的 AUTH_BASE_URL）。
// 微信登录/绑定走 RFC 8693 token_exchange grant（POST /oauth/token）：
//   grant_type=token_exchange
//   client_id=<应用 public client id>（在请求体里，不需要 client secret）
//   subject_token=wx.login() 的 code
//   subject_token_type=wechat_mini_program
// 绑定流程在登录参数基础上追加 email + password。
// 成功返回标准 token 响应（无 user 对象）；用户信息通过 GET /api/users/me 获取。
const TOKEN_ENDPOINT = `${AUTH_BASE_URL}/oauth/token`;
const ME_ENDPOINT = `${AUTH_BASE_URL}/api/users/me`;

// 绑定页展示用的 auth-service 错误码 → 中文文案
const BIND_ERROR_MESSAGES: Record<string, string> = {
  [ApiErrorCode.INVALID_CREDENTIALS]: '邮箱或密码错误',
  [ApiErrorCode.WECHAT_ALREADY_BOUND]: '该微信已绑定其他账号',
  [ApiErrorCode.WECHAT_NEEDS_BINDING]: '该微信未绑定任何账号，请先绑定',
  [ApiErrorCode.WECHAT_INVALID_CODE]: '微信登录失败，请重试',
  [ApiErrorCode.WECHAT_NOT_CONFIGURED]: '微信登录未配置',
};

// 用 wx.login() 的 code 发起 token_exchange；extra 用于绑定流程追加 email/password。
async function exchangeWechatCode(extra: Record<string, string> = {}): Promise<AuthTokenResponse> {
  const { code } = await wx.login();
  if (!code) {
    throw new Error('wx.login 返回空 code');
  }

  return http.post<AuthTokenResponse>(
    TOKEN_ENDPOINT,
    {
      grant_type: 'token_exchange',
      client_id: CLIENT_ID,
      subject_token: code,
      subject_token_type: 'wechat_mini_program',
      ...extra,
    },
    { auth: false },
  );
}

// 用刚换到的 access token 拉取当前用户（Bearer 自动附加；401 会走刷新重试）。
async function fetchMe(): Promise<UserProfile> {
  return http.get<UserProfile>(ME_ENDPOINT);
}

// 启动时主动向 auth-service 验证本地 token 是否仍被服务端接受（GET /api/users/me）。
// 本地「未过期」但服务端已失效/吊销的 token 会在这里返回 401 —— request.ts 会先尝试
// refresh，refresh 也失败则清 token 并抛 session_expired。用于启动时确认登录态，
// 避免「token 已无效却仍停留在首页」的假登录态。
export function validateSession(): Promise<UserProfile> {
  return fetchMe();
}

// 登录成功后的收尾：存 token + 拉用户信息并缓存。
async function persistSession(tokens: AuthTokenResponse): Promise<UserProfile> {
  persistTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in);
  const user = await fetchMe();
  persistUser(user);
  return user;
}

// 微信登录：
// - 已绑定账号 → ok=true + user
// - 微信未绑定任何账号 → ok=false + needsBinding=true（上层跳绑定页）
// - 其它错误 → 抛错（上层统一走绑定页兜底）
export async function wechatLogin(): Promise<WechatLoginResult> {
  try {
    const tokens = await exchangeWechatCode();
    const user = await persistSession(tokens);
    return { ok: true, user };
  } catch (err) {
    if (err instanceof ApiError && err.code === ApiErrorCode.WECHAT_NEEDS_BINDING) {
      return { ok: false, needsBinding: true };
    }
    throw err;
  }
}

// 微信绑定已有账号（同一个 token_exchange grant，追加 email + password）。
// 成功后已登录并返回用户信息；失败抛中文错误（绑定页展示）。
export async function wechatBindAccount(
  email: string,
  password: string,
): Promise<WechatLoginResult> {
  try {
    const tokens = await exchangeWechatCode({ email, password });
    const user = await persistSession(tokens);
    return { ok: true, user };
  } catch (err) {
    if (err instanceof ApiError) {
      const message = BIND_ERROR_MESSAGES[err.code ?? ''] || err.message;
      throw new Error(message);
    }
    throw err;
  }
}

// 检查本地是否有有效 token
export function hasValidToken(): boolean {
  const token = wx.getStorageSync(STORAGE_KEYS.TOKEN);
  const expiresAt = wx.getStorageSync(STORAGE_KEYS.TOKEN_EXPIRES_AT);

  if (!token || !expiresAt) return false;

  const now = Math.floor(Date.now() / 1000);
  // 过期前 60 秒也视为即将过期，让 refresh 逻辑接管
  return expiresAt > now + 60;
}

// 获取当前登录用户信息
export function getStoredUser(): UserProfile | null {
  const user = wx.getStorageSync(STORAGE_KEYS.USER_INFO);
  return user || null;
}

// 退出登录
export function logout(): void {
  wx.removeStorageSync(STORAGE_KEYS.TOKEN);
  wx.removeStorageSync(STORAGE_KEYS.REFRESH_TOKEN);
  wx.removeStorageSync(STORAGE_KEYS.TOKEN_EXPIRES_AT);
  wx.removeStorageSync(STORAGE_KEYS.USER_INFO);
}

// --- 内部 ---

function persistTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  wx.setStorageSync(STORAGE_KEYS.TOKEN, accessToken);
  wx.setStorageSync(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
  wx.setStorageSync(STORAGE_KEYS.TOKEN_EXPIRES_AT, expiresAt);
}

function persistUser(user: UserProfile): void {
  wx.setStorageSync(STORAGE_KEYS.USER_INFO, user);
}
