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
export enum ApiErrorCode {
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  VALIDATION_ERROR = 422,
  WECHAT_NOT_BOUND = 'wechat_not_bound',
  WECHAT_LOGIN_FAILED = 'wechat_login_failed',
}

// 业务错误响应
export interface ApiErrorResponse {
  detail: string;
  code?: string;
}

// 用户信息（与后端 profile 对齐，核心字段子集）
export interface UserProfile {
  id: string;
  email?: string;
  name?: string;
  avatar_url?: string;
  wechat_bound: boolean;
}

// 微信登录响应
export interface WechatLoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: UserProfile;
  needs_binding: boolean;
}

// 微信绑定请求
export interface WechatBindRequest {
  code: string;
  email?: string;
  password?: string;
}
