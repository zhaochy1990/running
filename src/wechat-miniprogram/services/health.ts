// 训练负荷 / 健康服务层。

import { http } from './request';
import type {
  HealthResponse,
  HrvResponse,
  StrideTrainingLoadResponse,
  StrideZonesResponse,
} from '../types/health';

/** 拉取 STRIDE 自研训练负荷（STRIDE current + series）。 */
export function getStrideTrainingLoad(
  userId: string,
  days = 30,
): Promise<StrideTrainingLoadResponse> {
  return http.get<StrideTrainingLoadResponse>(
    `/api/${encodeURIComponent(userId)}/stride/training-load?days=${days}`,
  );
}

/** 拉取健康记录 + HRV 快照 + RHR 基线（/api/{user}/health）。 */
export function getHealth(userId: string, days = 90): Promise<HealthResponse> {
  return http.get<HealthResponse>(
    `/api/${encodeURIComponent(userId)}/health?days=${days}`,
  );
}

/** 拉取逐日 HRV 记录（/api/{user}/hrv）。 */
export function getHrv(userId: string, days = 90): Promise<HrvResponse> {
  return http.get<HrvResponse>(
    `/api/${encodeURIComponent(userId)}/hrv?days=${days}`,
  );
}

/** 拉取 STRIDE 自研阈值 + 配速/心率区间（/api/{user}/stride/zones）。 */
export function getStrideZones(userId: string): Promise<StrideZonesResponse> {
  return http.get<StrideZonesResponse>(
    `/api/${encodeURIComponent(userId)}/stride/zones`,
  );
}
