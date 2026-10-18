// 意见反馈·全屏表单页（devops#554；原型 518 variant C）。
// type 分段（🐞 Bug 反馈 / 💡 产品建议）联动占位文案；描述必填点亮提交按钮；
// 0-9 张图四列格（wx.chooseMedia，超 10MB 跳过）＋删除。
// 提交两段式：先逐张 POST /feedback-images 拿 cos_key，再 POST /feedbacks
// （client_version 由 services 层静默注入，页面零展示）。上传失败给用户可见提示。

import { submitFeedback, uploadFeedbackImage } from '../../services/feedback';

/** 单张上限，与后端 feedbackImageMaxBytes 一致 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 9;

/** 与 Go IsFeedbackType 对齐的类型表 */
const TYPES: Array<{ type: 'bug' | 'suggestion'; label: string; placeholder: string }> = [
  { type: 'bug', label: '🐞 Bug 反馈', placeholder: '遇到了什么问题？什么操作触发的？' },
  { type: 'suggestion', label: '💡 产品建议', placeholder: '想让我们做什么？为什么？' },
];

interface FeedbackFormPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  types: Array<{ type: 'bug' | 'suggestion'; label: string; placeholder: string }>;
  type: 'bug' | 'suggestion';
  placeholder: string;
  content: string;
  /** 本地临时路径，提交时逐张上传换 cos_key */
  pics: string[];
  submitting: boolean;
  canSubmit: boolean;
}

interface FeedbackFormPageHandlers {
  onBack(): void;
  onTypeTap(e: WechatMiniprogram.TouchEvent): void;
  onContentInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  onAddPic(): void;
  onDeletePic(e: WechatMiniprogram.TouchEvent): void;
  onPreviewPic(e: WechatMiniprogram.TouchEvent): void;
  onSubmit(): void;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
  let width = 375;
  try {
    const win = wx.getWindowInfo();
    statusPx = win.statusBarHeight;
    width = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    statusPx = sys.statusBarHeight;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

Page<FeedbackFormPageData, FeedbackFormPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    types: TYPES,
    type: 'bug',
    placeholder: TYPES[0].placeholder,
    content: '',
    pics: [],
    submitting: false,
    canSubmit: false,
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/feedback/feedback' }) });
  },

  onTypeTap(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as 'bug' | 'suggestion';
    const def = TYPES.find((t) => t.type === type);
    if (!def || type === this.data.type) return;
    this.setData({ type, placeholder: def.placeholder });
  },

  onContentInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const content = e.detail.value;
    this.setData({ content, canSubmit: content.trim().length > 0 });
  },

  onAddPic() {
    const remain = MAX_IMAGES - this.data.pics.length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const oversize = res.tempFiles.filter((f) => f.size > IMAGE_MAX_BYTES);
        const ok = res.tempFiles.filter((f) => f.size <= IMAGE_MAX_BYTES).map((f) => f.tempFilePath);
        if (oversize.length) {
          wx.showToast({ title: `${oversize.length} 张图超过 10MB，已跳过`, icon: 'none' });
        }
        if (ok.length) {
          this.setData({ pics: this.data.pics.concat(ok).slice(0, MAX_IMAGES) });
        }
      },
    });
  },

  onDeletePic(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) return;
    const pics = this.data.pics.slice();
    pics.splice(index, 1);
    this.setData({ pics });
  },

  onPreviewPic(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) return;
    wx.previewImage({ urls: this.data.pics, current: this.data.pics[index] });
  },

  async onSubmit() {
    if (!this.data.canSubmit || this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      // 两段式：逐张上传拿 cos_key（失败即中止，保留本地图让用户重试）
      const keys: string[] = [];
      for (const path of this.data.pics) {
        keys.push(await uploadFeedbackImage(path));
      }
      await submitFeedback({
        type: this.data.type,
        content: this.data.content.trim(),
        images: keys,
      });
      wx.showToast({ title: '已提交 · 我们会尽快回复', icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/feedback/feedback' }) }), 600);
    } catch (err) {
      const msg = errMsg(err, '提交失败');
      wx.showToast({ title: msg.length > 15 ? '提交失败，请重试' : msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
