import { deleteManualStrengthRecord, getManualStrengthRecord } from '../../services/manual-strength';
import { openStrengthReview } from '../../services/coach';
import { ApiError } from '../../services/request';
import { userStore } from '../../store/index';
import type { ManualStrengthRecord } from '../../types/manual-strength';
import { epochToShanghaiHm, epochToShanghaiYmd } from '../../utils/date';
import { strengthSetLabel, summarizeStrengthActions } from '../../utils/manual-strength';
import { theme } from '../../utils/theme';

interface PageData {
  record: ManualStrengthRecord | null;
  timeLabel: string;
  summaryLabel: string;
  actionRows: Array<{ key: number; name: string; sets: Array<{ number: number; label: string }> }>;
  error: string;
  loading: boolean;
  canRetry: boolean;
  deleting: boolean;
}

interface PageHandlers {
  recordId: string;
  unsubscribeViewer: (() => void) | null;
  closed: boolean;
  load(): Promise<void>;
  onEdit(): void;
  onDelete(): Promise<void>;
  onCoachReview(): void;
}

function recordingTimeLabel(record: ManualStrengthRecord): string {
  const start = Date.parse(record.started_at);
  return `开始录入 ${epochToShanghaiYmd(start)} ${epochToShanghaiHm(start)}`;
}

Page<PageData, PageHandlers>({
  recordId: '',
  unsubscribeViewer: null,
  closed: false,
  data: {
    record: null,
    timeLabel: '',
    summaryLabel: '',
    actionRows: [],
    error: '',
    loading: true,
    canRetry: false,
    deleting: false,
  },

  onLoad(options) {
    this.recordId = options.recordId || '';
  },

  onShow() {
    if (!this.data.deleting) void this.load();
  },

  onUnload() {
    this.closed = true;
    this.unsubscribeViewer?.();
    this.unsubscribeViewer = null;
  },

  async load() {
    await userStore.waitForAuth();
    const { user, isAuthenticated } = userStore.getState();
    if (this.closed) return;
    if (!isAuthenticated || !user || !this.recordId) {
      this.setData({ error: '无法查看这条训练记录', loading: false, record: null });
      return;
    }
    if (!this.unsubscribeViewer) {
      this.unsubscribeViewer = userStore.subscribe((current) => {
        if (current.isAuthenticated && current.user?.id === user.id) return;
        this.closed = true;
        this.unsubscribeViewer?.();
        this.unsubscribeViewer = null;
        this.setData({ record: null, actionRows: [], summaryLabel: '', timeLabel: '', loading: false, canRetry: false, error: '当前账号已退出或切换' });
      });
    }
    try {
      const record = await getManualStrengthRecord(user.id, this.recordId);
      if (this.closed || this.data.deleting || !this.recordId) return;
      const { action_count, set_count } = summarizeStrengthActions(record.actions);
      this.setData({
        record,
        timeLabel: recordingTimeLabel(record),
        summaryLabel: `手动记录 · ${action_count} 个动作 / ${set_count} 组`,
        actionRows: record.actions.map((action, index) => ({
          key: index,
          name: action.name,
          sets: action.sets.map((set, index) => ({ number: index + 1, label: strengthSetLabel(set) })),
        })),
        error: '',
        loading: false,
        canRetry: false,
      });
    } catch (err) {
      if (this.closed || this.data.deleting || !this.recordId) return;
      const unavailable = err instanceof ApiError && [400, 403, 404].includes(err.statusCode);
      this.setData({ error: unavailable ? '未找到这条训练记录' : '暂时无法加载记录', loading: false, record: null, canRetry: !unavailable });
    }
  },

  onEdit() {
    if (!this.data.record || this.data.deleting) return;
    wx.navigateTo({ url: `/pages/manual-strength/manual-strength?edit=${encodeURIComponent(this.data.record.id)}` });
  },

  async onDelete() {
    const { record, deleting } = this.data;
    const { user, isAuthenticated } = userStore.getState();
    if (this.closed || deleting || !record || !isAuthenticated || !user) return;

    this.setData({ deleting: true });
    try {
      const choice = await wx.showModal({
        title: '删除这条训练记录？',
        content: '删除后无法恢复。',
        confirmText: '删除',
        confirmColor: theme.danger,
      });
      if (!choice.confirm || this.closed || userStore.getState().user?.id !== user.id) return;

      await deleteManualStrengthRecord(user.id, record.id);
      if (this.closed) return;
      this.recordId = '';
      this.setData({ record: null, actionRows: [], summaryLabel: '', timeLabel: '', error: '这条训练记录已删除' });
      wx.showToast({ title: '已删除', icon: 'success' });
      wx.navigateBack({
        fail: () => wx.switchTab({ url: '/pages/activities/activities' }),
      });
    } catch {
      if (!this.closed) wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    } finally {
      if (!this.closed) this.setData({ deleting: false });
    }
  },

  onCoachReview() {
    const { user, isAuthenticated } = userStore.getState();
    if (!this.closed && isAuthenticated && user && this.data.record && !this.data.deleting) {
      openStrengthReview(this.data.record.id, user.id);
    }
  },
});
