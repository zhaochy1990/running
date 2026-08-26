// 训练负荷 / 健康服务层。

import { http } from './request';
import type { StrideTrainingLoadResponse } from '../types/health';

/** 拉取 STRIDE 自研训练负荷（STRIDE current + series）。 */
export function getStrideTrainingLoad(
  userId: string,
  days = 30,
): Promise<StrideTrainingLoadResponse> {
  return http.get<StrideTrainingLoadResponse>(
    `/api/${encodeURIComponent(userId)}/stride/training-load?days=${days}`,
  );
}
