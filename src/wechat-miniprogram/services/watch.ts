// 手表管理服务层 —— 与 Web 端 `frontend/src/api.ts` 的 Watch 契约一致。

import { http } from './request';

export type WatchProvider = 'coros' | 'garmin';

/** 手表状态（GET /api/users/me/watch）。镜像 Go `watchInfoResponse`。 */
export interface WatchInfo {
  provider: string | null;
  provider_display_name: string | null;
  logged_in: boolean;
  email: string | null;
  device: string | null;
  last_sync_at: string | null;
  capabilities: string[];
}

/** 绑定（login）响应（POST /api/users/me/watch/login）。 */
export interface WatchLoginResult {
  ok?: boolean;
  region?: string;
  user_id?: string;
  error?: string;
}

/** 拉取当前用户手表状态。 */
export function getWatchInfo(): Promise<WatchInfo> {
  return http.get<WatchInfo>('/api/users/me/watch');
}

/** 绑定手表：登录 provider 账号并持久化凭据。 */
export function watchLogin(
  provider: WatchProvider,
  email: string,
  password: string,
  region: 'cn' | 'global' = 'cn',
): Promise<WatchLoginResult> {
  return http.post<
    WatchLoginResult,
    { provider: WatchProvider; email: string; password: string; region: 'cn' | 'global' }
  >('/api/users/me/watch/login', { provider, email, password, region });
}

/** 解除绑定：清空手表凭据（已同步数据保留）。 */
export function disconnectWatch(): Promise<{ ok: boolean; provider: string }> {
  return http.delete<{ ok: boolean; provider: string }>('/api/users/me/watch');
}
