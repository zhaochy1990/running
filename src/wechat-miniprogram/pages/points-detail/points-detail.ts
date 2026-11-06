// 积分明细页（devops#894，消费已上线 #883 GET /api/users/me/points 契约）。
// 头部余额大数字（无边框白卡）+ 流水倒序列表（类型/时间/带符号分值，redeem 附订单号副行）
// + cursor 分页加载更多（范式对齐 points-orders；信封 {balance, transactions[], next_cursor}）。
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import { listPointsLedger } from '../../services/points';
import { toPointDetailRows } from '../../utils/pointDetailRows';
import type { PointDetailRow } from '../../utils/pointDetailRows';

interface PointsDetailPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1 显示回主页的小房子 */
  canBack: boolean;
  guest: boolean;
  loading: boolean;
  loadFailed: boolean;
  balance: number;
  rows: PointDetailRow[];
  /** cursor 分页：next_cursor=null 到底。 */
  loadingMore: boolean;
  hasMore: boolean;
}

interface PointsDetailPageHandlers {
  onBack(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onGoCheckin(): void;
  load(): Promise<void>;
  loadMore(): Promise<void>;
  _cursor?: string;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<PointsDetailPageData, PointsDetailPageHandlers>({
  data: {
    statusBarHeight: 0,
    canBack: false,
    guest: false,
    loading: true,
    loadFailed: false,
    balance: 0,
    rows: [],
    loadingMore: false,
    hasMore: false,
  },

  onLoad() {
    this._cursor = '';
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
    });
  },

  onShow() {
    if (!userStore.getState().isAuthenticated) {
      // 明细为登录态页面：直链冷进先引导登录，登录后 reLaunch 回本页。
      this.setData({ guest: true, loading: false });
      return;
    }
    this.setData({ guest: false });
    void this.load();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onGuestLogin() {
    openLogin(currentRouteForRedirect() || '/pages/points-detail/points-detail');
  },

  async load() {
    this.setData({ loading: this.data.rows.length === 0, loadFailed: false });
    try {
      const res = await listPointsLedger();
      this._cursor = res.next_cursor || '';
      this.setData({
        loading: false,
        loadFailed: false,
        balance: res.balance,
        rows: toPointDetailRows(res.transactions),
        hasMore: Boolean(res.next_cursor),
      });
    } catch {
      this.setData({ loading: false, loadFailed: this.data.rows.length === 0 });
    }
  },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const res = await listPointsLedger(this._cursor);
      this._cursor = res.next_cursor || '';
      this.setData({
        loadingMore: false,
        rows: this.data.rows.concat(toPointDetailRows(res.transactions)),
        hasMore: Boolean(res.next_cursor),
      });
    } catch {
      this.setData({ loadingMore: false });
      wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' });
    }
  },

  onRetry() {
    void this.load();
  },

  // 空态引导：明细↔checkin 互为 navigateTo 会单向涨栈（10 层上限后静默失败），fail 兜底 redirectTo。
  onGoCheckin() {
    wx.navigateTo({
      url: '/pages/checkin/checkin',
      fail: () => wx.redirectTo({ url: '/pages/checkin/checkin' }),
    });
  },
});
