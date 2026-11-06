// 积分商城页（devops#886，UI 权威 = devops#852 resolution + 原型
// prototypes/852-redeem-spike.html 变体 A 横排大卡）。
// 数据来自 #884 契约：products / redemptions / addresses + #883 check-ins/status（余额）。
// 商品四态：正常粉「兑换」/ 售罄（蒙层+灰钮）/ 达限（灰钮）/ 积分不足走确认抽屉不足态。
import { userStore } from '../../store/index';
import { openLogin } from '../../utils/authGate';
import { getCheckInStatus } from '../../services/checkin';
import { ApiError } from '../../services/request';
import {
  createRedemption,
  listAddresses,
  listPointProducts,
  newIdempotencyKey,
  pointsErrorCopy,
} from '../../services/points';
import type { PointProduct, UserAddress } from '../../services/points';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

/** 商品卡视图模型：服务端字段 + 客户端推导的置灰态。 */
interface MallProduct {
  id: number;
  name: string;
  description: string;
  imageUrl: string;
  price: number;
  /** 每人限 N 件（0=不限不展示）。 */
  limit: number;
  redeemed: number;
  soldOut: boolean;
  limitHit: boolean;
}

/** 确认抽屉里的地址行。 */
interface SheetAddress {
  id: number;
  /** 「姓名　省 市 区 · 详址」单行截断。 */
  text: string;
}

interface PointsMallPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1 显示回主页的小房子 */
  canBack: boolean;
  guest: boolean;
  loading: boolean;
  loadFailed: boolean;
  balance: number;
  products: MallProduct[];
  /** 确认抽屉。 */
  sheetVisible: boolean;
  sheetName: string;
  sheetPrice: number;
  /** 兑换数量（步进器）；合计 = price × qty。 */
  sheetQty: number;
  sheetTotal: number;
  /** 步进上限：限购商品 = 余量，不限 = 99。 */
  sheetMaxQty: number;
  sheetAddresses: SheetAddress[];
  sheetSelectedId: number;
  /** 抽屉三态文案：兑换后剩余 / 积分不足还差 N 分。 */
  sheetAfter: number;
  sheetLack: number;
  sheetInsufficient: boolean;
  sheetNoAddress: boolean;
  sheetSubmitting: boolean;
  /** 兑换成功居中弹卡。 */
  okVisible: boolean;
  okName: string;
  okCost: number;
  okBalance: number;
  /** 兑换规则弹窗（hero「兑换规则」唤起）。 */
  rulesVisible: boolean;
}

interface PointsMallPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBack(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onNavOrders(): void;
  onHeroDetail(): void;
  onHeroCheckin(): void;
  onRedeemTap(e: WechatMiniprogram.TouchEvent): void;
  onSheetClose(): void;
  onQtyMinus(): void;
  onQtyPlus(): void;
  onSheetSelectAddr(e: WechatMiniprogram.TouchEvent): void;
  onSheetManageAddr(): void;
  onSheetAddAddr(): void;
  onSheetConfirm(): void;
  onOkOrders(): void;
  onOkContinue(): void;
  onRulesTap(): void;
  onRulesClose(): void;
  /** 阻断抽屉内点按冒泡到遮罩（遮罩 bindtap=关闭）。 */
  noop(): void;
  load(silent?: boolean): Promise<void>;
  /** 按（可能已变化的）地址簿/余额重算抽屉展示态。 */
  refreshSheet(): void;
  openSheet(product: MallProduct): void;
  _addresses?: UserAddress[];
  /** 本次兑换尝试的幂等键：抽屉关闭/成功/业务拒绝后换新，网络失败重试复用。 */
  _idemKey?: string;
  /** 抽屉当前商品（sheet 的数据源，跨 onShow 刷新用）。 */
  _sheetProduct?: MallProduct;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

/** 商品卡四态推导：售罄（stock=0）与达限（redeemed≥limit>0）是两种置灰原因，视觉区分。 */
function toMallProduct(p: PointProduct): MallProduct {
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    imageUrl: p.image_url || '',
    price: p.points_price,
    limit: p.per_user_limit,
    redeemed: p.redeemed_count,
    soldOut: p.stock <= 0,
    limitHit: p.per_user_limit > 0 && p.redeemed_count >= p.per_user_limit,
  };
}

function toSheetAddress(a: UserAddress): SheetAddress {
  return {
    id: a.id,
    text: `${a.receiver_name}　${a.province} ${a.city} ${a.district} · ${a.address_detail}`,
  };
}

Page<PointsMallPageData, PointsMallPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    canBack: false,
    guest: false,
    loading: true,
    loadFailed: false,
    balance: 0,
    products: [],
    sheetVisible: false,
    sheetName: '',
    sheetPrice: 0,
    sheetQty: 1,
    sheetTotal: 0,
    sheetMaxQty: 99,
    sheetAddresses: [],
    sheetSelectedId: 0,
    sheetAfter: 0,
    sheetLack: 0,
    sheetInsufficient: false,
    sheetNoAddress: false,
    sheetSubmitting: false,
    okVisible: false,
    okName: '',
    okCost: 0,
    okBalance: 0,
    rulesVisible: false,
  },

  onLoad() {
    this._addresses = [];
    this._idemKey = '';
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
    });
  },

  onShow() {
    const guest = !userStore.getState().isAuthenticated;
    if (guest) {
      // 游客不发数据请求：结束 loading 直接呈现页面（登录引导遮罩盖在内容上）。
      this.setData({ guest, loading: false });
      return;
    }
    const silent = this.data.products.length > 0 || this.data.loadFailed;
    this.setData({ guest: false });
    void this.load(silent);
  },

  async load(silent?: boolean) {
    if (!silent) {
      this.setData({ loading: true, loadFailed: false });
    }
    try {
      // 余额走 #883 check-ins/status（本仓唯一余额读点）；商品/地址走 #884。
      const [st, productsRes, addrRes] = await Promise.all([
        getCheckInStatus(),
        listPointProducts(),
        listAddresses(),
      ]);
      this._addresses = addrRes.addresses;
      this.setData({
        loading: false,
        loadFailed: false,
        balance: st.balance,
        products: productsRes.products.map(toMallProduct),
      });
      // 抽屉开着时（管理地址/签到跳转回来）：以最新地址簿/余额重算抽屉态。
      if (this.data.sheetVisible) {
        this.refreshSheet();
      }
    } catch {
      if (silent) {
        // 静默刷新失败保留旧数据（下次 onShow 再校准）。
        return;
      }
      this.setData({ loading: false, loadFailed: true });
    }
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onGuestLogin() {
    openLogin('/pages/points-mall/points-mall');
  },

  onRetry() {
    void this.load();
  },

  onNavOrders() {
    wx.navigateTo({ url: '/pages/points-orders/points-orders' });
  },

  // 积分明细页已上线（#894），接管原占位 toast（单向跳转，同 onNavOrders 直接 navigateTo）。
  onHeroDetail() {
    wx.navigateTo({ url: '/pages/points-detail/points-detail' });
  },

  onHeroCheckin() {
    // mall↔checkin 互为 navigateTo 会单向涨栈（10 层上限后静默失败），fail 兜底 redirectTo。
    wx.navigateTo({
      url: '/pages/checkin/checkin',
      fail: () => wx.redirectTo({ url: '/pages/checkin/checkin' }),
    });
  },

  onRedeemTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.pid);
    const product = this.data.products.find((p) => p.id === id);
    if (!product || product.soldOut || product.limitHit) return;
    this.openSheet(product);
  },

  openSheet(product: MallProduct) {
    this._sheetProduct = product;
    // 每次打开抽屉换新幂等键：上一次尝试已终结（成功/拒绝/放弃）。
    this._idemKey = newIdempotencyKey();
    this.setData({
      sheetVisible: true,
      sheetName: product.name,
      sheetPrice: product.price,
      sheetQty: 1,
      // 限购商品按余量封顶（redeemed 服务端已按件数 SUM）；不限购 99。
      sheetMaxQty: product.limit > 0 ? Math.max(1, product.limit - product.redeemed) : 99,
      sheetSubmitting: false,
      okVisible: false,
    });
    this.refreshSheet();
  },

  /** 以最新地址簿/余额重算抽屉（默认地址预选、选中粉描边、剩余/不足三态）。 */
  refreshSheet() {
    const product = this._sheetProduct;
    if (!product || !this.data.sheetVisible) return;
    const addresses = this._addresses || [];
    const sheetAddresses = addresses.map(toSheetAddress);
    let selectedId = this.data.sheetSelectedId;
    if (!sheetAddresses.some((a) => a.id === selectedId)) {
      // 首选默认地址；选中项被删后回落默认；无地址置 0。
      const dflt = addresses.find((a) => a.is_default);
      selectedId = dflt ? dflt.id : 0;
    }
    const total = product.price * this.data.sheetQty;
    const after = this.data.balance - total;
    const insufficient = after < 0;
    this.setData({
      sheetAddresses,
      sheetSelectedId: selectedId,
      sheetNoAddress: sheetAddresses.length === 0,
      sheetTotal: total,
      sheetAfter: insufficient ? 0 : after,
      sheetLack: insufficient ? -after : 0,
      sheetInsufficient: insufficient,
    });
  },

  onSheetClose() {
    if (this.data.sheetSubmitting) return;
    this.setData({ sheetVisible: false });
    this._sheetProduct = undefined;
  },

  // 数量步进（1..sheetMaxQty）；改完重算合计/不足态。
  onQtyMinus() {
    if (this.data.sheetQty <= 1) return;
    this.setData({ sheetQty: this.data.sheetQty - 1 });
    this.refreshSheet();
  },

  onQtyPlus() {
    if (this.data.sheetQty >= this.data.sheetMaxQty) return;
    this.setData({ sheetQty: this.data.sheetQty + 1 });
    this.refreshSheet();
  },

  onSheetSelectAddr(e: WechatMiniprogram.TouchEvent) {
    this.setData({ sheetSelectedId: Number(e.currentTarget.dataset.aid) });
  },

  // 管理地址 ›：带当前选中进单选模式，挑完带回继续兑换。
  onSheetManageAddr() {
    const selected = this.data.sheetSelectedId;
    wx.navigateTo({
      url: `/pages/addresses/addresses?mode=pick&selected=${selected}`,
      events: {
        addressSelected: (payload: { id: number }) => {
          if (payload && payload.id) {
            this.setData({ sheetSelectedId: payload.id });
          }
        },
      },
    });
  },

  // 还没有收货地址 → 直接去管理模式新增（单选模式不显示新增钮）。
  onSheetAddAddr() {
    wx.navigateTo({ url: '/pages/addresses/addresses' });
  },

  async onSheetConfirm() {
    const product = this._sheetProduct;
    const idemKey = this._idemKey;
    if (!product || !idemKey || this.data.sheetSubmitting) return;
    if (this.data.sheetNoAddress || this.data.sheetInsufficient || !this.data.sheetSelectedId) return;
    this.setData({ sheetSubmitting: true });
    try {
      const res = await createRedemption(product.id, this.data.sheetSelectedId, idemKey, this.data.sheetQty);
      // 幂等键已消费：重放/replay 也一样，下一次兑换必须换新 key。
      this._idemKey = newIdempotencyKey();
      this.setData({
        sheetVisible: false,
        sheetSubmitting: false,
        okVisible: true,
        okName: res.order.product_name,
        okCost: res.order.points_cost,
        okBalance: res.balance,
        balance: res.balance,
      });
      this._sheetProduct = undefined;
      // 静默刷新商品列表：库存/已兑人数跟着走（四态即时校准）。
      void this.load(true);
    } catch (err: unknown) {
      this.setData({ sheetSubmitting: false });
      const copy = pointsErrorCopy(err, '兑换失败，请稍后再试');
      wx.showToast({ title: copy, icon: 'none' });
      const code = err instanceof ApiError ? err.code : undefined;
      // 商品态失效（售罄/达限/下架）：关抽屉回列表，静默刷新校准四态。
      if (code === 'limit_reached' || code === 'out_of_stock' || code === 'product_inactive') {
        this.setData({ sheetVisible: false });
        this._sheetProduct = undefined;
        void this.load(true);
        return;
      }
      // insufficient_points（余额被别端花掉）/ address_not_found（地址被别端删）：
      // 留在抽屉里，静默刷新余额/地址簿 → refreshSheet 自动翻转到不足态/回落默认地址。
      if (code === 'insufficient_points' || code === 'address_not_found') {
        void this.load(true);
      }
      // 网络错误保留幂等键，重试同一订单不会双扣。
    }
  },

  onOkOrders() {
    this.setData({ okVisible: false });
    wx.navigateTo({ url: '/pages/points-orders/points-orders' });
  },

  onOkContinue() {
    this.setData({ okVisible: false });
  },

  onRulesTap() {
    this.setData({ rulesVisible: true });
  },

  onRulesClose() {
    this.setData({ rulesVisible: false });
  },

  noop() {
    // 仅阻断冒泡
  },
});
