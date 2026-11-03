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

/** 抽奖（服务端硬校验时间窗 / 登录态 / 绑表；重复参与返回已有结果）。
 * scene=点位渠道号（易拉宝 scene 的 s 参数）可选透传——#867 看板漏斗按点位分组；
 * 非法值后端按未带处理，不阻塞抽奖。 */
export function drawLottery(id: string, scene?: string): Promise<LotteryDrawResult> {
  return http.post<LotteryDrawResult>(`/api/lottery/activities/${id}/draw`, scene ? { scene } : undefined);
}

/** 漏斗埋点阶段（#867 看板）：enter=进页（免登录）login=登录完成 bind=绑表完成。 */
export type LotteryEventStage = 'enter' | 'login' | 'bind';

/**
 * 漏斗埋点 ping（POST /api/lottery/activities/:id/events，公开端点——#867 看板）。
 * fire-and-forget：内部吞掉一切错误（埋点失败绝不打扰页面）；有 token 时带上
 * 供服务端可选归因（登录/绑表阶段），无 token 匿名（enter 阶段）。
 */
export function reportLotteryEvent(id: string, stage: LotteryEventStage, scene?: string): void {
  http
    .post<void>(
      `/api/lottery/activities/${id}/events`,
      { stage, ...(scene ? { scene } : {}) },
      { auth: true, timeout: 5_000 },
    )
    .catch(() => {
      // 埋点失败静默：看板少一条计数，不影响任何页面行为。
    });
}

/** 预取本账号参与结果（落地页结果态渲染用）。 */
export function getLotteryMyResult(id: string): Promise<LotteryMyResult> {
  return http.get<LotteryMyResult>(`/api/lottery/activities/${id}/my-result`);
}

// ── 核销域（devops#869，Epic #862 P6；契约源 #866 verify 路由） ──────────

/** 核销端点响应（lookup / redeem 同形；lookup 保证 prize 非空——中奖记录必有奖品档）。 */
export interface LotteryVerifyEntry {
  code: string;
  /** 'drawn'=待核销；'verified'=已核销。 */
  status: string;
  prize: LotteryPrizeView;
  won_at: string;
  verified_at: string | null;
  /** 核销人 openid（已核销时非空）。 */
  verified_by: string | null;
}

/** redeem 响应额外字段：并发核销（另一台设备先核了）时为 true，body 仍是已核销态。 */
export interface LotteryRedeemResult extends LotteryVerifyEntry {
  already_verified: boolean;
}

/** 取一枚新鲜 wx.login code（#866 鉴权链：code 一次性，每次查询/核销都要重新换
 * openid，不能复用启动登录那枚）。 */
async function freshWxLoginCode(): Promise<string> {
  const { code } = await wx.login();
  if (!code) throw new Error('wx.login 返回空 code');
  return code;
}

/** 查询/核销共用请求体 {code, wx_code}（403 not_staff 由页面按 ApiError 分流：
 * err.body.openid 是后端回显的请求者自己的 openid，展示+复制用）。 */
async function postVerify<T>(action: 'lookup' | 'redeem', activityId: string, code: string): Promise<T> {
  const wxCode = await freshWxLoginCode();
  return http.post<T>(`/api/lottery/activities/${activityId}/verify/${action}`, { code, wx_code: wxCode });
}

/** 查询中奖详情（输 3 位编号后的详情卡数据）。404 code_not_found = 编号不存在。 */
export function lookupLotteryWinning(activityId: string, code: string): Promise<LotteryVerifyEntry> {
  return postVerify<LotteryVerifyEntry>('lookup', activityId, code);
}

/** 确认核销（待核销→已核销，后端落核销人 openid+时间）；并发核销幂等返回已核销态。 */
export function redeemLotteryWinning(activityId: string, code: string): Promise<LotteryRedeemResult> {
  return postVerify<LotteryRedeemResult>('redeem', activityId, code);
}
