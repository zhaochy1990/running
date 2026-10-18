// 意见反馈服务层 —— 对接 stride-api 的反馈会话接口（devops#554）。
// 后端契约：`internal/api/feedback.go`（devops#552，契约 #519 决议）：
//
//	POST   /api/users/me/feedback-images        传图拿 cos_key（multipart `file`，单张 ≤10MB）
//	POST   /api/users/me/feedbacks              提交（≤9 图）
//	GET    /api/users/me/feedbacks              会话列表（无分页；total_unread 喂「我的」页红点）
//	GET    /api/users/me/feedbacks/:id          线程详情（服务端读即清官方回复未读）
//	POST   /api/users/me/feedbacks/:id/replies  追问（已关闭 → 409 feedback_closed）
//
// 版本号页面零展示（#554 定稿）：bug/suggestion 一律在 services 层静默注入
// client_version，表单与详情卡都不出现版本行。

import { http } from './request';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/config';
import { logger } from '../utils/logger';

/** 反馈类型（与 Go storage.FeedbackTypeBug/Suggestion 一致）。 */
export type FeedbackType = 'bug' | 'suggestion';

/** 反馈状态三态。 */
export type FeedbackStatus = 'open' | 'replied' | 'closed';

/** 会话列表行（GET /api/users/me/feedbacks 的 items）。 */
export interface FeedbackItem {
  id: number;
  type: FeedbackType;
  content: string;
  /** COS object key（仅提交用；展示用详情里的 image_urls） */
  images: string[];
  status: FeedbackStatus;
  /** 已采纳关联的产品路线 feature id，null = 未采纳 */
  adopted_feature_id: number | null;
  /** UTC RFC3339（展示前必须转上海墙钟，见 utils/feedbackRows） */
  created_at: string;
  /** 最新一回合（官方或本人），null = 还没人回复 */
  last_reply: { author: string; content: string; created_at: string } | null;
  /** 官方有未读回复 */
  unread: boolean;
}

export interface FeedbackListResponse {
  total_unread: number;
  items: FeedbackItem[];
}

/** 线程里的一个回合。author: user（右侧气泡）/ admin（左侧「STRIDE 团队」）。 */
export interface FeedbackReply {
  id: number;
  author: 'user' | 'admin';
  content: string;
  /** UTC RFC3339 */
  created_at: string;
}

/** 线程详情（GET /api/users/me/feedbacks/:id）。 */
export interface FeedbackDetailResponse {
  feedback: {
    id: number;
    type: FeedbackType;
    content: string;
    /** 服务端由 cos_key 建好的公开 URL */
    image_urls: string[];
    status: FeedbackStatus;
    adopted_feature_id: number | null;
    created_at: string;
  };
  replies: FeedbackReply[];
}

// 客户端版本号：正式版取发布版本号，开发/体验版退回 envVersion
// （develop/trial/release）。≤32 字符（Go binding max=32）。
function clientVersion(): string {
  try {
    const mp = wx.getAccountInfoSync().miniProgram;
    return `wxmp/${mp.version || mp.envVersion}`.slice(0, 32);
  } catch {
    return 'wxmp/unknown';
  }
}

/**
 * 上传一张反馈图片，返回后端 cos_key（「先传拿 key 再提交」两段式的前段）。
 * wx.uploadFile 是文件通道，不走 services/request.ts 的 JSON 封装；
 * 错误处理与 services/profile.ts 的头像上传同款。
 */
export function uploadFeedbackImage(filePath: string): Promise<string> {
  const token = wx.getStorageSync(STORAGE_KEYS.TOKEN) as string | undefined;
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${API_BASE_URL}/api/users/me/feedback-images`,
      filePath,
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 60000,
      success: (res) => {
        let body: { cos_key?: string; error?: string; detail?: string } = {};
        try {
          body = JSON.parse(res.data);
        } catch {
          // 解析失败走下面的状态码分支兜底
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.cos_key) {
          resolve(body.cos_key);
          return;
        }
        logger.error('feedback image upload http', res.statusCode, String(res.data).slice(0, 200));
        reject(new Error(body.error || body.detail || '图片上传失败'));
      },
      fail: (err) => {
        // 合法域名未配置等客户端侧失败只在这里可见
        logger.error('feedback image uploadFile fail', err.errMsg);
        reject(new Error(err.errMsg || '图片上传失败'));
      },
    });
  });
}

/** 提交反馈（≤9 张图的 cos_key 必须是本人上传得到的）。 */
export function submitFeedback(input: {
  type: FeedbackType;
  content: string;
  images: string[];
}): Promise<FeedbackItem> {
  return http.post<FeedbackItem>('/api/users/me/feedbacks', {
    type: input.type,
    content: input.content,
    images: input.images,
    // 版本号静默注入，页面零展示（#554 定稿）
    client_version: clientVersion(),
  });
}

/** 我的反馈会话列表（无分页；total_unread 喂「我的」页红点）。 */
export function listFeedbacks(): Promise<FeedbackListResponse> {
  return http.get<FeedbackListResponse>('/api/users/me/feedbacks');
}

/** 线程详情；服务端读即清官方回复的未读。 */
export function getFeedbackDetail(id: number): Promise<FeedbackDetailResponse> {
  return http.get<FeedbackDetailResponse>(`/api/users/me/feedbacks/${id}`);
}

/** 追问一条回复；已关闭的会话后端回 409 feedback_closed。 */
export function replyFeedback(id: number, content: string): Promise<FeedbackReply> {
  return http.post<FeedbackReply>(`/api/users/me/feedbacks/${id}/replies`, { content });
}
