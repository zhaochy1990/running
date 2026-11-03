// 抽奖活动 API —— devops#868（Epic #862 P5 落地页）。
// 契约源：coach_agent_api src/routes/lottery.ts（#863 配置域 + #865 抽奖核心）。
// 公开端点免登录（auth:false，coach-share 同款）；draw / my-result 是用户级
// 认证端点（auth 默认 true）。

import { http } from './request';

/** 活动时间窗状态（公开端点 status 字段；与后端 lotteryPhase 同口径）。 */
export type LotteryStatus = 'not_started' | 'active' | 'ended';

/** 公开端点奖品档（展示字段；不含权重 / 配置库存）。 */
export interface LotteryPublicPrize {
  name: string;
  image_url?: string;
  /** 兜底档无库存概念（永不售罄）→ null；其余档位为当前可抽库存。 */
  remaining: number | null;
  is_fallback: boolean;
}

/** 免登录公开端点（GET /api/lottery/activities/:id）的活动展示数据。 */
export interface LotteryPublicActivity {
  id: number;
  name: string;
  hero_image?: string;
  rules_text?: string;
  start_at: string;
  end_at: string;
  status: LotteryStatus;
  prizes: LotteryPublicPrize[];
}

/** 结果态奖品视图（draw / my-result 共用；绝不带权重 / 配置库存）。 */
export interface LotteryPrizeView {
  name: string;
  image_url?: string;
  is_fallback: boolean;
}

/** POST /api/lottery/activities/:id/draw 响应（201 首次 / 200 重复参与同形）。 */
export interface LotteryDrawResult {
  participated: true;
  deduplicated?: boolean;
  prize: LotteryPrizeView | null;
  /** 3 位补零中奖编号；「谢谢参与」兜底档无编号（null）。 */
  code: string | null;
  /** 'drawn' 默认；核销域（P3）会置 'verified'。 */
  status: string;
  created_at: string;
}

/** GET /api/lottery/activities/:id/my-result 响应：未参与 {participated:false}；
 * 已参与与 draw 同形（多 verified_at）。 */
export interface LotteryMyResult {
  participated: boolean;
  prize?: LotteryPrizeView | null;
  code?: string | null;
  status?: string;
  verified_at?: string | null;
  created_at?: string;
}

/** 免登录拉活动展示数据（落地页首屏）。404 = 不存在或未启用。 */
export function getLotteryActivity(id: string): Promise<LotteryPublicActivity> {
  return http.get<LotteryPublicActivity>(`/api/lottery/activities/${id}`, { auth: false });
}

/** 抽奖（服务端硬校验时间窗 / 登录态 / 绑表；重复参与返回已有结果）。 */
export function drawLottery(id: string): Promise<LotteryDrawResult> {
  return http.post<LotteryDrawResult>(`/api/lottery/activities/${id}/draw`);
}

/** 预取本账号参与结果（落地页结果态渲染用）。 */
export function getLotteryMyResult(id: string): Promise<LotteryMyResult> {
  return http.get<LotteryMyResult>(`/api/lottery/activities/${id}/my-result`);
}
