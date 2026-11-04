// 每日签到 + 积分服务层 —— 对齐 devops#883 三端点契约（镜像 Go api.checkins DTO）。
import { http } from './request';

/** POST /api/users/me/check-ins 响应。镜像 Go `checkInResponse`。 */
export interface CheckInResult {
  /** 当日重复签到为 true：重复快照 +0 分，不是错误（#847 item 8）。 */
  already_checked_in: boolean;
  streak_days: number;
  cycle_position: number;
  points_earned: number;
  balance: number;
  /** 本次签到集齐 7 天一轮（客户端彩蛋 #851）。 */
  d7_completed: boolean;
}

/** GET .../status 里「今天」块。 */
export interface CheckInTodayBlock {
  /** 服务器上海日历日 YYYY-MM-DD。 */
  date: string;
  can_check_in: boolean;
  /** 下一次签到（今天或明天）能拿的分。 */
  reward_preview: number;
  /** 下一次签到将开启新一轮（断签 / 昨日集齐 D7）。 */
  would_start_new_cycle: boolean;
}

/** 7 格本轮进度单元格。 */
export interface CheckInCycleCell {
  position: number;
  /** 已签格=得分快照，未签格=该位置的奖励预览。 */
  points: number;
  status: 'checked' | 'today' | 'upcoming';
}

/** 当月已签一天（含得分快照）。 */
export interface CheckInMonthEntry {
  date: string;
  points: number;
}

/** GET /api/users/me/check-ins/status —— 签到页整页状态单次读取。 */
export interface CheckInStatus {
  today: CheckInTodayBlock;
  streak_days: number;
  /** 恒 7 格。 */
  cycle: CheckInCycleCell[];
  balance: number;
  month: {
    /** 今天所在月 YYYY-MM。 */
    label: string;
    checked: CheckInMonthEntry[];
  };
}

/** 一步签到（幂等）。 */
export function createCheckIn(): Promise<CheckInResult> {
  return http.post<CheckInResult>('/api/users/me/check-ins');
}

/** 拉取签到页整页状态。 */
export function getCheckInStatus(): Promise<CheckInStatus> {
  return http.get<CheckInStatus>('/api/users/me/check-ins/status');
}
