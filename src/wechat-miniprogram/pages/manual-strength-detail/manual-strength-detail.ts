import { getManualStrengthRecord } from '../../services/manual-strength';
import { ApiError } from '../../services/request';
import { userStore } from '../../store/index';
import type { ManualStrengthRecord } from '../../types/manual-strength';
import { epochToShanghaiHm, epochToShanghaiYmd } from '../../utils/date';
import { strengthSetLabel } from '../../utils/manual-strength';

interface PageData {
  record: ManualStrengthRecord | null;
  timeLabel: string;
  summaryLabel: string;
  actionRows: Array<{ key: number; name: string; sets: Array<{ number: number; label: string }> }>;
  error: string;
  loading: boolean;
  canRetry: boolean;
}

interface PageHandlers {
  recordId: string;
  unsubscribeViewer: (() => void) | null;
  closed: boolean;
  load(): Promise<void>;
  onEdit(): void;
}

function trainingTimeLabel(record: ManualStrengthRecord): string {
  const start = Date.parse(record.started_at);
  const end = Date.parse(record.ended_at);
  const day = epochToShanghaiYmd(start);
  const endDay = epochToShanghaiYmd(end);
  return `${day} ${epochToShanghaiHm(start)} – ${endDay === day ? '' : `${endDay} `}${epochToShanghaiHm(end)}`;
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
  },

  onLoad(options) {
    this.recordId = options.recordId || '';
  },

  onShow() {
    void this.load();
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
      if (this.closed) return;
      const setCount = record.actions.reduce((total, action) => total + action.sets.length, 0);
      this.setData({
        record,
        timeLabel: trainingTimeLabel(record),
        summaryLabel: `手动记录 · ${record.actions.length} 个动作 / ${setCount} 组`,
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
      if (this.closed) return;
      const unavailable = err instanceof ApiError && [400, 403, 404].includes(err.statusCode);
      this.setData({ error: unavailable ? '未找到这条训练记录' : '暂时无法加载记录', loading: false, record: null, canRetry: !unavailable });
    }
  },

  onEdit() {
    if (!this.data.record) return;
    wx.navigateTo({ url: `/pages/manual-strength/manual-strength?edit=${encodeURIComponent(this.data.record.id)}` });
  },
});
