// 积分商城 API 服务层 —— 对齐 devops#884 契约（镜像 Go api.points / api.addresses DTO）。
// 分页响应按仓库惯例包对象信封：{redemptions, next_cursor}（#686 契约备注）。
// 运费支付流（prepay / wx.requestPayment / 订单支付态）对齐 devops#904 + #905
// （镜像 Go api.wxpay 契约）。
import { ApiError, http } from './request';
import type { ShippingPolicy } from '../utils/shipping';

/** GET /api/users/me/points/products 单项（仅 active 商品；redeemed_count 喂限购态）。 */
export interface PointProduct {
  id: number;
  name: string;
  description?: string | null;
  /** COS 直链；V1 admin 上传管道未建时为空 → 页面渲染占位色块。 */
  image_url?: string | null;
  points_price: number;
  stock: number;
  /** 0 = 不限购（#849 改判）。 */
  per_user_limit: number;
  redeemed_count: number;
  /** 运费策略 + 运费（分），jzsh_fee 对江浙沪外地址收 shipping_fee（devops#904）。 */
  shipping_policy: ShippingPolicy;
  shipping_fee: number;
}

export interface PointProductsResponse {
  products: PointProduct[];
}

/**
 * 订单状态机（devops#904）：带运费订单 pending_payment →（支付回调）pending_shipment
 * → shipped（终态）；免运订单直接 pending_shipment；pending_payment 逾期 30 分钟被
 * worker 关单 → cancelled（终态，积分原路退回）。
 */
export type RedemptionStatus = 'pending_payment' | 'pending_shipment' | 'shipped' | 'cancelled';

/** 订单支付态：free=免运不经过支付 / pending=待支付 / paid=运费已到账。 */
export type PaymentState = 'free' | 'pending' | 'paid';

/** GET/POST redemptions 的订单本体（收货六列为兑换时刻快照）。 */
export interface PointRedemption {
  /** 公开订单号（UUID），小程序渲染时加 "R-" 前缀。 */
  id: string;
  product_id: number;
  product_name: string;
  points_cost: number;
  /** 数量（旧客户端缺省=1；成本=单价×数量）。 */
  quantity: number;
  status: RedemptionStatus;
  tracking_no?: string | null;
  shipped_at?: string | null;
  /** 运费快照（分）与策略快照：兑换事务与扣分同一提交冻结（devops#904）。 */
  shipping_fee_snapshot: number;
  shipping_policy_snapshot: ShippingPolicy;
  payment_state: PaymentState;
  paid_at?: string | null;
  receiver_name: string;
  receiver_phone: string;
  province: string;
  city: string;
  district: string;
  address_detail: string;
  created_at: string;
}

export interface RedemptionsResponse {
  redemptions: PointRedemption[];
  /** null = 到底（倒序最后一页）。 */
  next_cursor?: string | null;
}

/** POST redemptions 响应：订单本体 + 扣分后余额 + 是否幂等重放。 */
export interface RedemptionCreateResult {
  order: PointRedemption;
  balance: number;
  replayed: boolean;
}

export interface UserAddress {
  id: number;
  receiver_name: string;
  receiver_phone: string;
  province: string;
  city: string;
  district: string;
  address_detail: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AddressesResponse {
  addresses: UserAddress[];
}

export interface AddressPayload {
  receiver_name: string;
  receiver_phone: string;
  province: string;
  city: string;
  district: string;
  address_detail: string;
  is_default?: boolean;
}

/** 拉商城商品列表（active，含本人 redeemed_count）。 */
export function listPointProducts(): Promise<PointProductsResponse> {
  return http.get<PointProductsResponse>('/api/users/me/points/products');
}

/** 兑换（服务端幂等：idempotency_key 命中重放已有订单，零副作用）。
 * key 由页面在打开确认抽屉时生成、整个尝试过程（含网络失败重试）复用，
 * 成功/业务拒绝后才换新——断网重试不会双扣。 */
export function createRedemption(productId: number, addressId: number, idempotencyKey: string, quantity = 1): Promise<RedemptionCreateResult> {
  return http.post<RedemptionCreateResult, { product_id: number; address_id: number; idempotency_key: string; quantity: number }>(
    '/api/users/me/points/redemptions',
    { product_id: productId, address_id: addressId, idempotency_key: idempotencyKey, quantity },
  );
}

/** 我的兑换倒序分页（cursor 透传即可，next_cursor=null 到底）。 */
export function listRedemptions(cursor?: string): Promise<RedemptionsResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return http.get<RedemptionsResponse>(`/api/users/me/points/redemptions${qs}`);
}

/** 流水类型（storage/point_models.go：earn_checkin/redeem V1 产生，expire/adjust 留位）。 */
export type PointTransactionType = 'earn_checkin' | 'redeem' | 'expire' | 'adjust';

/** GET /api/users/me/points 流水单项（#883 契约）。 */
export interface PointTransaction {
  id: string;
  type: PointTransactionType;
  /** 已带符号：earn_checkin 正 / redeem 负（storage/points.go 写入时定号）。 */
  amount: number;
  /** redeem = 订单号（UUID，页面渲染 R- 前缀）；其余为空。 */
  ref: string;
  remark?: string | null;
  created_at: string;
}

/** 明细分页响应：对象信封 {balance, transactions, next_cursor}（#686 契约备注）。 */
export interface PointsLedgerResponse {
  balance: number;
  transactions: PointTransaction[];
  /** null = 到底（服务端 50 条/页，倒序）。 */
  next_cursor?: string | null;
}

/** 积分余额 + 流水倒序分页（cursor 透传即可，next_cursor=null 到底）。 */
export function listPointsLedger(cursor?: string): Promise<PointsLedgerResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return http.get<PointsLedgerResponse>(`/api/users/me/points${qs}`);
}

/** 地址簿列表（服务端保证至多一条 is_default）。 */
export function listAddresses(): Promise<AddressesResponse> {
  return http.get<AddressesResponse>('/api/users/me/addresses');
}

export function createAddress(payload: AddressPayload): Promise<UserAddress> {
  return http.post<UserAddress, AddressPayload>('/api/users/me/addresses', payload);
}

export function updateAddress(id: number, payload: Partial<AddressPayload>): Promise<UserAddress> {
  return http.patch<UserAddress, Partial<AddressPayload>>(`/api/users/me/addresses/${id}`, payload);
}

export function deleteAddress(id: number): Promise<void> {
  return http.delete<void>(`/api/users/me/addresses/${id}`);
}

/** 设默认（服务端同事务清同用户其余默认位）。 */
export function setAddressDefault(id: number): Promise<UserAddress> {
  return http.patch<UserAddress, Record<string, never>>(`/api/users/me/addresses/${id}/default`, {});
}

/** 409/404/503 业务码文案（points.go:252 契约注释 + devops#904 payment_unavailable）。 */
const REDEEM_ERROR_COPY: Record<string, string> = {
  insufficient_points: '积分不足，去签到赚积分吧',
  limit_reached: '已达每人限购上限',
  out_of_stock: '手慢了，商品已售罄',
  product_inactive: '商品已下架',
  address_not_found: '收货地址不存在，请重新选择',
  address_limit_reached: '收货地址最多 10 条',
  // 带运费商品兑换时支付模块未配置（503，事务回滚零扣积分）——票面指定文案。
  payment_unavailable: '支付通道暂未开放，请稍后再试',
};

/**
 * #884 错误码 → 中文文案映射（票面第 6 条）。命中返回映射值；
 * 未识别的业务码回落 fallback；网络层错误（无 code）同样回落。
 */
export function pointsErrorCopy(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code) {
    const copy = REDEEM_ERROR_COPY[err.code];
    if (copy) return copy;
  }
  return fallback;
}

/** 兑换幂等键（页面每次打开确认抽屉生成一个；风格同 onboarding.ts 降级 key）。 */
export function newIdempotencyKey(): string {
  return `mp-redeem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 运费支付流（devops#905；prepay 契约 = wxpay.go，五参数原样喂 wx.requestPayment）
// ─────────────────────────────────────────────────────────────────────────────

/** POST redemptions/:id/pay 响应：wx.requestPayment 五参数（契约原样，不加工）。 */
export interface WxPayParams {
  timeStamp: string;
  nonceStr: string;
  /** 预支付交易会话 ID（prepay_id=…），字段名即字面 package。 */
  package: string;
  signType: string;
  paySign: string;
}

/** 拉起一次运费支付的整体结局：paid=支付完成 / cancel=用户取消（静默返回不弹错）。 */
export type PayOutcome = 'paid' | 'cancel';

/**
 * 应收运费订单的支付流：现取 wx.login 身份令牌 → prepay 拿五参数 → 唤起收银台。
 *
 * openid：prepay 契约要 JSAPI payer openid（wxpay.go 注释「取自小程序自身
 * wx.login 上下文、每次现取、不落存储」）。auth-service 面板暂不透出 openid，
 * 现取的 wx.login code 是客户端唯一的新鲜身份令牌；真实支付联调本身
 * blocked-on-credentials（票面 AC），资质到位后 code→openid 的解析点由
 * 后端/auth-service 落定，客户端「每次现取」约定不变。
 *
 * 取消与失败严格分流：wx.requestPayment errMsg 含 cancel = 用户主动取消，
 * 返回 'cancel' 由调用方静默处理（订单留待支付、可回订单页重试），绝不弹错；
 * 其余 fail 与 prepay 的业务错误（409 payment_not_pending / 502
 * wxpay_upstream_error / 503 payment_unavailable）向上抛，文案走 payErrorCopy。
 */
export async function payShippingFee(orderId: string): Promise<PayOutcome> {
  let code: string;
  try {
    ({ code } = await wx.login());
  } catch {
    // wx.login 失败是登录态/appid 层面的问题，直接透传 errMsg 会是英文。
    throw new Error('微信登录态获取失败，请稍后再试');
  }
  if (!code) throw new Error('微信登录态获取失败，请稍后再试');
  const params = await http.post<WxPayParams, { openid: string }>(
    `/api/users/me/points/redemptions/${orderId}/pay`,
    { openid: code },
  );
  try {
    // 五参数契约原样透传；wx 类型把 signType 收成字面量联合（v3 固定 "RSA"），
    // 线上字符串在此收窄一次。
    await wx.requestPayment({
      ...params,
      signType: params.signType as WechatMiniprogram.RequestPaymentOption['signType'],
    });
    return 'paid';
  } catch (err: unknown) {
    const msg = (err as { errMsg?: string } | null)?.errMsg ?? '';
    if (msg.indexOf('cancel') !== -1) return 'cancel';
    throw new Error('支付未完成，请稍后再试');
  }
}

/** 支付链路错误码 → 中文文案（wxpay.go 契约码；未识别回落 fallback）。 */
const PAY_ERROR_COPY: Record<string, string> = {
  // 409：门控=status=pending_payment；超时关单后重试/回调已落账都会走到这。
  payment_not_pending: '订单已取消或已支付，请刷新查看',
  // 502：微信侧 prepay 失败。
  wxpay_upstream_error: '支付通道异常，请稍后再试',
  // 503：支付模块未配置（与兑换侧同一文案，票面指定）。
  payment_unavailable: '支付通道暂未开放，请稍后再试',
};

export function payErrorCopy(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const copy = err.code ? PAY_ERROR_COPY[err.code] : undefined;
    return copy || fallback;
  }
  // 非 ApiError（payShippingFee 自抛的中文 Error）直接展示其 message。
  return err instanceof Error && err.message ? err.message : fallback;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等指定订单离开待支付（支付回调落库是异步的：requestPayment 成功 ≠ 服务端
 * 已翻状态）。最多 3 次、间隔 1.5s，查到即返回 true；超时/网络抖动返回
 * false —— 页面按当前列表态展示（仍待支付就留给「去支付」重试）。
 * 只查第一页：刚创建/刚支付的订单必在最前。
 */
export async function waitOrderSettled(orderId: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1500);
    try {
      const res = await listRedemptions();
      const hit = res.redemptions.find((r) => r.id === orderId);
      if (hit && hit.status !== 'pending_payment') return true;
    } catch {
      // 网络抖动不中断等待，继续下一轮。
    }
  }
  return false;
}
