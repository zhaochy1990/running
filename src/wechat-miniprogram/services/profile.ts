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

// wx.uploadFile 只接受本地文件路径。chooseAvatar 对「微信头像」返回的是
// https://thirdwx.qlogo.cn/... 远端 URL（而非本地临时路径），需先下载到本地
// 临时路径再上传；相册/拍摄返回的本地临时路径则直接上传。
async function toLocalPath(src: string): Promise<string> {
  // 本地临时路径：新格式 wxfile://tmp_xxx，模拟器老格式 http://tmp/xxx
  if (src.startsWith('wxfile://') || src.includes('/tmp/')) return src;
  // 其余按远端 URL 处理（微信头像 CDN），先下载到本地临时路径
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: src,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => reject(new Error(err.errMsg || '下载头像失败')),
    });
  });
}

// 上传头像到 auth-service（auth-service 写 COS）；成功返回公开 avatar_url。
export async function uploadAvatar(avatarUrl: string): Promise<string> {
  const token = wx.getStorageSync(STORAGE_KEYS.TOKEN) as string | undefined;
  const filePath = await toLocalPath(avatarUrl);

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

// ── 数据面 profile（身体数据 + display_name 的 source of truth，ADR 0013）──
// 与 auth-service 身份端点区分：昵称/头像走上面 ME_ENDPOINT，身体数据走这里。
const PROFILE_ENDPOINT = '/api/users/me/profile';

/** 跑龄档位（与 Go profileInput 的 oneof 一致）。 */
export type RunningAgeRange = 'unknown' | 'lt_6m' | '6m_1y' | '1y_3y' | '3y_plus';

/** 数据面 profile 核心字段（GET /api/users/me/profile 的 `profile`）。 */
export interface ProfileCore {
  display_name: string;
  dob: string;
  sex: string;
  height_cm: number;
  weight_kg: number;
  running_age_range: RunningAgeRange;
}

/** GET /api/users/me/profile 响应（只取小程序用到的字段）。 */
export interface MyProfileData {
  id: string;
  display_name: string;
  running_age_range: RunningAgeRange;
  profile: ProfileCore | null;
}

/** PATCH 可提交的字段子集（省略即不变）。 */
export interface ProfilePatch {
  display_name?: string;
  dob?: string;
  sex?: string;
  height_cm?: number;
  weight_kg?: number;
  running_age_range?: RunningAgeRange;
}

/** POST 整表字段（profile 不存在时建立）。 */
export interface ProfileInput {
  display_name: string;
  dob: string;
  sex: string;
  height_cm: number;
  weight_kg: number;
  running_age_range: RunningAgeRange;
}

/** 读取当前用户数据面 profile（`profile` 可能为 null，表示尚未建立）。 */
export function getMyProfile(): Promise<MyProfileData> {
  return http.get<MyProfileData>(PROFILE_ENDPOINT);
}

/** 建立 profile（整表 POST；已存在时后端为 upsert）。 */
export function postMyProfile(input: ProfileInput): Promise<{ ok: boolean }> {
  return http.post<{ ok: boolean }, ProfileInput>(PROFILE_ENDPOINT, input);
}

/** 逐字段更新已有 profile（不存在时后端返回 404）。 */
export function patchMyProfile(patch: ProfilePatch): Promise<{ ok: boolean; profile: ProfileCore }> {
  return http.patch<{ ok: boolean; profile: ProfileCore }, ProfilePatch>(PROFILE_ENDPOINT, patch);
}
