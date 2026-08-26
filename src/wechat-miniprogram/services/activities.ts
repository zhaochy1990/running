// 活动列表服务层。

import { http } from './request';
import type { ActivitiesListResponse } from '../types/activity';

/** 拉取用户活动列表（默认最近 20 条）。 */
export function getActivities(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ActivitiesListResponse> {
  // 小程序运行环境不保证 URLSearchParams，手动拼 query 字符串。
  const parts: string[] = [];
  if (opts.limit != null) parts.push(`limit=${opts.limit}`);
  if (opts.offset != null) parts.push(`offset=${opts.offset}`);
  const qs = parts.length > 0 ? `?${parts.join('&')}` : '';
  return http.get<ActivitiesListResponse>(
    `/api/${encodeURIComponent(userId)}/activities${qs}`,
  );
}
