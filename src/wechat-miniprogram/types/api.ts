// API 通用响应结构
export interface ApiResponse<T = unknown> {
  data: T;
  message?: string;
}

// 分页参数
export interface PaginationParams {
  page?: number;
  page_size?: number;
}

// 分页响应
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

// API 错误码（与后端对齐）
// STRIDE 数据面（Python/Go）返回 {detail, code}；auth-service 返回 {error, message}。
export enum ApiErrorCode {
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  VALIDATION_ERROR = 422,
  WECHAT_NEEDS_BINDING = 'wechat_needs_binding',
  WECHAT_ALREADY_BOUND = 'wechat_already_bound',
  WECHAT_INVALID_CODE = 'wechat_invalid_code',
  WECHAT_NOT_CONFIGURED = 'wechat_not_configured',
  WECHAT_RATE_LIMITED = 'wechat_rate_limited',
  INVALID_CREDENTIALS = 'invalid_credentials',
  // SMS 验证码（auth-service /api/auth/sms/send 与 wechat_phone_bind grant）
  SMS_CODE_INVALID = 'sms_code_invalid',
  SMS_CODE_EXPIRED = 'sms_code_expired',
  SMS_ATTEMPTS_EXCEEDED = 'sms_attempts_exceeded',
  SMS_SEND_COOLDOWN = 'sms_send_cooldown',
  SMS_DAILY_LIMIT = 'sms_daily_limit',
  SMS_NOT_CONFIGURED = 'sms_not_configured',
  USER_DISABLED = 'user_disabled',
}

// 业务错误响应（兼容 STRIDE {detail, code} 与 auth-service {error, message}）
export interface ApiErrorResponse {
  detail?: string;
  code?: string;
  error?: string;
  message?: string;
}

// 用户信息（与 auth-service GET /api/users/me 对齐，核心字段子集）
export interface UserProfile {
  id: string;
  email?: string;
  name?: string;
  avatar_url?: string;
  wechat_bound: boolean;
}

// token_exchange（RFC 8693）标准 token 响应 —— 登录/绑定成功都返回这个，
// 不携带 user 对象；用户信息另调 GET /api/users/me 获取（暴露 wechat_bound）。
export interface AuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  // wechat_phone_bind grant 自动注册（新建手机号账号）时为 true，其余场景不出现；
  // 客户端借此一次性进入手表绑定引导页（ADR 0011）。
  registered?: boolean;
}

// 微信登录 / 绑定结果：
// - 成功（已绑定账号）：ok=true，附带拉取到的用户信息
// - 未绑定：ok=false + needsBinding=true，调用方跳绑定页
export type WechatLoginResult =
  | { ok: true; user: UserProfile }
  | { ok: false; needsBinding: true };

// 手机号 + 验证码绑定登录（wechat_phone_bind grant）结果：成功返回用户信息；
// registered=true 表示本次新建了手机号账号，客户端应一次性进入手表绑定引导页。
// 失败一律抛错（中文文案），因此没有 needsBinding 分支。
export type PhoneBindResult = { ok: true; user: UserProfile; registered: boolean };
