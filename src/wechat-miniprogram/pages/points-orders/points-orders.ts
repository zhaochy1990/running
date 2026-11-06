// 我的兑换页（devops#886，UI 权威 = devops#852 resolution + 原型）。
// 订单卡：订单号 R-xxxx + 日期 / 商品行（占位图/名/尺码快照/寄达地/-N 分）/ 运费行
// （包邮/¥N，devops#905）/ 四态 chip（橙待支付 / 橙黄待发货 / 绿已发货 / 灰已取消）/
// 已发货追加运单号行+复制；待支付卡带「去支付」（重新 prepay 唤起收银台）；已取消卡
// 带超时取消说明（积分已退回，明细页见 adjust +N 流水）。
// 尺码快照（devops#910）：by_sku 订单展示 sku_label，single/旧单缺省 = 不渲染。
// cursor 分页倒序（#884 契约，服务端已按 id DESC）。
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import {
  listRedemptions,
  payErrorCopy,
  payShippingFee,
  waitOrderSettled,
} from '../../services/points';
import type { PointRedemption, RedemptionStatus } from '../../services/points';
import { fmtShanghaiMdHm } from '../../utils/format';
import { formatFen } from '../../utils/shipping';

/** 四态 chip：class 后缀 + 文案（橙待支付/橙黄待发货/绿已发货/灰已取消，devops#905）。 */
const STATUS_CHIPS: Record<RedemptionStatus, { cls: string; label: string }> = {
  pending_payment: { cls: 'unpaid', label: '待支付' },
  pending_shipment: { cls: 'pending', label: '待发货' },
  shipped: { cls: 'shipped', label: '已发货' },
  cancelled: { cls: 'cancelled', label: '已取消' },
};

/** 订单卡视图模型。 */
interface OrderRow {
  id: string;
  /** YYYY-MM-DD HH:mm（上海墙钟）。 */
  date: string;
  name: string;
  /** 寄达地「省 市 区」。 */
  destination: string;
  /** 尺码快照（devops#910）：by_sku 订单非空展示，single/旧单空 = 不渲染。 */
  skuLabel: string;
  cost: number;
  /** chip class 后缀 + 文案（四态，未知状态回落已取消灰 —— 展示层不瞎猜绿色）。 */
  chipCls: string;
  chipLabel: string;
  /** 运费行：包邮（绿）/ ¥N（兑换时刻快照，分→元）。 */
  feeFree: boolean;
  feeText: string;
  /** 待支付：显示「去支付」钮。 */
  payPending: boolean;
  /** 已取消：显示超时自动取消说明。 */
  cancelled: boolean;
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
  /** 正在拉起支付的订单 id（「去支付」钮置灰防重复点）。 */
  payingId: string;
}

interface PointsOrdersPageHandlers {
  onBack(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onCopyTracking(e: WechatMiniprogram.TouchEvent): void;
  /** 待支付订单「去支付」：重新 prepay → wx.requestPayment（devops#905）。 */
  onPayTap(e: WechatMiniprogram.TouchEvent): Promise<void>;
  load(): Promise<void>;
  /** 商城支付成功跳转（?paid=<id>）的落账轮询：仍待支付时等回调再校准一次。 */
  settleExpected(): Promise<void>;
  loadMore(): Promise<void>;
  _cursor?: string;
  /** 商城支付成功跳转带来的订单（?paid=<id>）：落账轮询锚点。 */
  _expectPaidId?: string;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function toOrderRow(r: PointRedemption): OrderRow {
  // 未知状态（未来新增）回落灰色，不猜绿色 —— 四态之外没有安全的默认。
  const chip = STATUS_CHIPS[r.status] || STATUS_CHIPS.cancelled;
  // 运费行直接用兑换时刻快照：0=包邮，>0=¥N（分→元，去尾零）。
  const feeFen = r.shipping_fee_snapshot || 0;
  return {
    id: r.id,
    date: fmtShanghaiMdHm(r.created_at),
    // 多件订单在名称后缀 ×N（旧后端无 quantity 字段时自然回退单件展示）。
    name: r.quantity > 1 ? `${r.product_name} ×${r.quantity}` : r.product_name,
    destination: `${r.province} ${r.city} ${r.district}`,
    skuLabel: r.sku_label || '',
    cost: r.points_cost,
    chipCls: chip.cls,
    chipLabel: chip.label,
    feeFree: feeFen <= 0,
    feeText: feeFen > 0 ? `¥${formatFen(feeFen)}` : '包邮',
    payPending: r.status === 'pending_payment',
    cancelled: r.status === 'cancelled',
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
    payingId: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    this._cursor = '';
    // 商城支付成功跳转携带的订单：首轮 load 后仍待支付则轮询等回调落账。
    this._expectPaidId = options && options.paid ? options.paid : '';
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
    await this.settleExpected();
  },

  // 支付回调落账是异步的（requestPayment 成功 ≠ 服务端已翻 paid）：商城支付
  // 成功跳转过来时若订单仍待支付，轮询几轮再拉一次列表；只有跳转锚点触发，
  // 消费后清零（onShow 重入不重放）。
  async settleExpected() {
    const id = this._expectPaidId || '';
    if (!id) return;
    this._expectPaidId = '';
    const stillPending = this.data.orders.some((o) => o.id === id && o.payPending);
    if (!stillPending) return;
    if (!(await waitOrderSettled(id))) return;
    await this.load();
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

  /**
   * 待支付订单「去支付」（devops#905）：重新 prepay 唤起收银台。
   * paid → 轮询落账后刷新列表（chip 翻已支付/待发货）；cancel（用户取消）→
   * 静默不弹错，订单留待支付可再点；真实失败 → toast 文案。收尾统一刷新一次，
   * 让超时关单等异步变化也能被看到。
   */
  async onPayTap(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.oid || '');
    if (!id || this.data.payingId) return;
    this.setData({ payingId: id });
    try {
      const outcome = await payShippingFee(id);
      if (outcome === 'paid') {
        await waitOrderSettled(id);
      }
    } catch (err: unknown) {
      wx.showToast({ title: payErrorCopy(err, '支付未完成，请稍后再试'), icon: 'none' });
    } finally {
      this.setData({ payingId: '' });
      await this.load();
    }
  },
});
