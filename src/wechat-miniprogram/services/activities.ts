// 活动列表 + 详情服务层。

import { http } from './request';
import type { ActivitiesListResponse, ActivityDetailResponse } from '../types/activity';

/** 拉取用户活动列表（默认最近 20 条）。dateFrom/dateTo 为上海 YYYY-MM-DD（含边界）。 */
export function getActivities(
  userId: string,
  opts: { limit?: number; offset?: number; dateFrom?: string; dateTo?: string } = {},
): Promise<ActivitiesListResponse> {
  // 小程序运行环境不保证 URLSearchParams，手动拼 query 字符串。
  const parts: string[] = [];
  if (opts.limit != null) parts.push(`limit=${opts.limit}`);
  if (opts.offset != null) parts.push(`offset=${opts.offset}`);
  if (opts.dateFrom) parts.push(`date_from=${encodeURIComponent(opts.dateFrom)}`);
  if (opts.dateTo) parts.push(`date_to=${encodeURIComponent(opts.dateTo)}`);
  const qs = parts.length > 0 ? `?${parts.join('&')}` : '';
  return http.get<ActivitiesListResponse>(
    `/api/${encodeURIComponent(userId)}/activities${qs}`,
  );
}

/** 拉取单个活动详情（默认不含 timeseries；图表需要时传 includeTimeseries）。 */
export function getActivityDetail(
  userId: string,
  labelId: string,
  opts: { includeTimeseries?: boolean } = {},
): Promise<ActivityDetailResponse> {
  const qs = opts.includeTimeseries ? '?include=timeseries' : '';
  return http.get<ActivityDetailResponse>(
    `/api/${encodeURIComponent(userId)}/activities/${encodeURIComponent(labelId)}${qs}`,
  );
}
