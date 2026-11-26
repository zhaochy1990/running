import { getManualStrengthRecord } from '../../services/manual-strength';
import { ApiError } from '../../services/request';
import { userStore } from '../../store/index';
import type { ManualStrengthRecord } from '../../types/manual-strength';
import { epochToShanghaiHm, epochToShanghaiYmd } from '../../utils/date';
import { strengthSetLabel } from '../../utils/manual-strength';

interface PageData {
  record: ManualStrengthRecord | null;
  timeLabel: string;
  actionRows: Array<{ key: number; name: string; sets: Array<{ key: number; label: string }> }>;
  error: string;
  loading: boolean;
}

interface PageHandlers {
  recordId: string;
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
  closed: false,
  data: {
    record: null,
    timeLabel: '',
    actionRows: [],
    error: '',
    loading: true,
  },

  onLoad(options) {
    this.recordId = options.recordId || '';
  },

  onShow() {
    void this.load();
  },

  onUnload() {
    this.closed = true;
  },

  async load() {
    await userStore.waitForAuth();
    const { user, isAuthenticated } = userStore.getState();
    if (this.closed) return;
    if (!isAuthenticated || !user || !this.recordId) {
      this.setData({ error: '无法查看这条训练记录', loading: false, record: null });
      return;
    }
    try {
      const record = await getManualStrengthRecord(user.id, this.recordId);
      if (this.closed) return;
      this.setData({
        record,
        timeLabel: trainingTimeLabel(record),
        actionRows: record.actions.map((action, index) => ({
          key: index,
          name: action.name,
          sets: action.sets.map((set, key) => ({ key, label: strengthSetLabel(set) })),
        })),
        error: '',
        loading: false,
      });
    } catch (err) {
      if (this.closed) return;
      const unavailable = err instanceof ApiError && [400, 403, 404].includes(err.statusCode);
      this.setData({ error: unavailable ? '未找到这条训练记录' : '暂时无法加载记录', loading: false, record: null });
    }
  },

  onEdit() {
    if (!this.data.record) return;
    wx.navigateTo({ url: `/pages/manual-strength/manual-strength?edit=${encodeURIComponent(this.data.record.id)}` });
  },
});
