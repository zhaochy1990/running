// 积分商城 API 服务层 —— 对齐 devops#884 契约（镜像 Go api.points / api.addresses DTO）。
// 分页响应按仓库惯例包对象信封：{redemptions, next_cursor}（#686 契约备注）。
import { ApiError, http } from './request';

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
}

export interface PointProductsResponse {
  products: PointProduct[];
}

/** 订单两态：pending_shipment → shipped（终态，无逆向，#849）。 */
export type RedemptionStatus = 'pending_shipment' | 'shipped';

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

/** 409/404 业务码文案（points.go:252 契约注释 + addresses.go 409 address_limit_reached）。 */
const REDEEM_ERROR_COPY: Record<string, string> = {
  insufficient_points: '积分不足，去签到赚积分吧',
  limit_reached: '已达每人限购上限',
  out_of_stock: '手慢了，商品已售罄',
  product_inactive: '商品已下架',
  address_not_found: '收货地址不存在，请重新选择',
  address_limit_reached: '收货地址最多 10 条',
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
