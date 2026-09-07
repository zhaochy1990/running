import { http } from './request';
import { AUTH_BASE_URL, STORAGE_KEYS } from '../constants/config';
import type { UserProfile } from '../types/api';

// auth-service 身份端点（与 services/auth.ts 一致）：GET/PATCH /api/users/me。
const ME_ENDPOINT = `${AUTH_BASE_URL}/api/users/me`;
// 头像上传端点：小程序把 chooseAvatar 拿到的临时文件 POST 给 auth-service，
// 由 auth-service 写入腾讯云 COS 并返回公开 avatar_url（二进制不进 MySQL / 小程序端）。
const AVATAR_ENDPOINT = `${AUTH_BASE_URL}/api/users/me/avatar`;

interface AvatarUploadResponse {
  avatar_url: string;
}

// 上传头像临时文件到 auth-service；成功返回公开 avatar_url。
export async function uploadAvatar(filePath: string): Promise<string> {
  const token = wx.getStorageSync(STORAGE_KEYS.TOKEN) as string | undefined;

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: AVATAR_ENDPOINT,
      filePath,
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: (res) => {
        let body: Partial<AvatarUploadResponse> & { detail?: string; message?: string } = {};
        try {
          body = JSON.parse(res.data);
        } catch {
          // ignore parse error; fall through to status check
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.avatar_url) {
          resolve(body.avatar_url);
          return;
        }
        reject(new Error(body.detail || body.message || '头像上传失败'));
      },
      fail: (err) => reject(new Error(err.errMsg || '头像上传失败')),
    });
  });
}

// 更新身份昵称/头像（auth-service PATCH /api/users/me）。返回更新后的用户。
export async function updateProfile(patch: {
  name?: string;
  avatar_url?: string;
}): Promise<UserProfile> {
  return http.patch<UserProfile>(ME_ENDPOINT, patch);
}

// 拉取当前用户（登录后 / 保存后回读用）。
export function fetchMe(): Promise<UserProfile> {
  return http.get<UserProfile>(ME_ENDPOINT);
}
