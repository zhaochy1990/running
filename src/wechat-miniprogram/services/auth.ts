import { http } from './request';
import { STORAGE_KEYS } from '../constants/config';
import type { UserProfile, WechatLoginResponse } from '../types/api';

// 微信登录 → 后端换 JWT
// 后端需实现 POST /api/auth/wechat-login，接收 { code }，返回：
//   - 已绑定：access_token + refresh_token + user（wechat_bound=true）
//   - 未绑定：needs_binding=true，临时 token 或 state 供下一步绑定用
export async function wechatLogin(): Promise<WechatLoginResponse> {
  const { code } = await wx.login();
  if (!code) {
    throw new Error('wx.login 返回空 code');
  }

  const response = await http.post<WechatLoginResponse>(
    '/api/auth/wechat-login',
    { code },
    { auth: false },
  );

  // 已绑定 → 存 token
  if (!response.needs_binding && response.access_token) {
    persistTokens(response.access_token, response.refresh_token, response.expires_in);
    persistUser(response.user);
  }

  return response;
}

// 微信绑定已有账号
// 后端需实现 POST /api/auth/wechat-bind，接收 { code, email, password }
export async function wechatBindAccount(
  email: string,
  password: string,
): Promise<WechatLoginResponse> {
  const { code } = await wx.login();
  if (!code) {
    throw new Error('wx.login 返回空 code');
  }

  const response = await http.post<WechatLoginResponse>(
    '/api/auth/wechat-bind',
    { code, email, password },
    { auth: false },
  );

  if (response.access_token) {
    persistTokens(response.access_token, response.refresh_token, response.expires_in);
    persistUser(response.user);
  }

  return response;
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
