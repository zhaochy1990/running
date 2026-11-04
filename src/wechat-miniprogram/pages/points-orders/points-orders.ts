// 我的兑换页（devops#886，UI 权威 = devops#852 resolution + 原型）。
// 订单卡：订单号 R-xxxx + 日期 / 商品行（占位图/名/寄达地/-N 分）/ 两态 chip
// （橙待发货 #f5a623 / 绿已发货 #34b47a）/ 已发货追加运单号行+复制。
// cursor 分页倒序（#884 契约，服务端已按 id DESC）。
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import { listRedemptions } from '../../services/points';
import type { PointRedemption } from '../../services/points';
import { fmtShanghaiMdHm } from '../../utils/format';

/** 订单卡视图模型。 */
interface OrderRow {
  id: string;
  /** YYYY-MM-DD HH:mm（上海墙钟）。 */
  date: string;
  name: string;
  /** 寄达地「省 市 区」。 */
  destination: string;
  cost: number;
  shipped: boolean;
  trackingNo: string;
}

interface PointsOrdersPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1 显示回主页的小房子 */
  canBack: boolean;
  guest: boolean;
  loading: boolean;
  loadFailed: boolean;
  orders: OrderRow[];
  /** cursor 分页：next_cursor=null 到底。 */
  loadingMore: boolean;
  hasMore: boolean;
}

interface PointsOrdersPageHandlers {
  onBack(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onCopyTracking(e: WechatMiniprogram.TouchEvent): void;
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

function toOrderRow(r: PointRedemption): OrderRow {
  return {
    id: r.id,
    date: fmtShanghaiMdHm(r.created_at),
    name: r.product_name,
    destination: `${r.province} ${r.city} ${r.district}`,
    cost: r.points_cost,
    shipped: r.status === 'shipped',
    trackingNo: r.tracking_no || '',
  };
}

Page<PointsOrdersPageData, PointsOrdersPageHandlers>({
  data: {
    statusBarHeight: 0,
    canBack: false,
    guest: false,
    loading: true,
    loadFailed: false,
    orders: [],
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
      // 商城/订单均为登录态页面：直链冷进先引导登录，登录后 reLaunch 回本页。
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
    openLogin(currentRouteForRedirect() || '/pages/points-orders/points-orders');
  },

  async load() {
    this.setData({ loading: this.data.orders.length === 0, loadFailed: false });
    try {
      const res = await listRedemptions();
      this._cursor = res.next_cursor || '';
      this.setData({
        loading: false,
        loadFailed: false,
        orders: res.redemptions.map(toOrderRow),
        hasMore: Boolean(res.next_cursor),
      });
    } catch {
      this.setData({ loading: false, loadFailed: this.data.orders.length === 0 });
    }
  },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const res = await listRedemptions(this._cursor);
      this._cursor = res.next_cursor || '';
      this.setData({
        loadingMore: false,
        orders: this.data.orders.concat(res.redemptions.map(toOrderRow)),
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

  // 已发货订单：复制运单号（#852 resolution 指定 wx.setClipboardData）。
  onCopyTracking(e: WechatMiniprogram.TouchEvent) {
    const no = String(e.currentTarget.dataset.no || '');
    if (!no) return;
    wx.setClipboardData({
      data: no,
      success: () => wx.showToast({ title: '运单号已复制', icon: 'none' }),
    });
  },
});
