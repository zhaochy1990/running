// 积分商城页（devops#886，UI 权威 = devops#852 resolution + 原型
// prototypes/852-redeem-spike.html 变体 A 横排大卡）。
// 数据来自 #884 契约：products / redemptions / addresses + #883 check-ins/status（余额）。
// 商品四态：正常粉「兑换」/ 售罄（蒙层+灰钮）/ 达限（灰钮）/ 积分不足走确认抽屉不足态。
// 运费（devops#905）：抽屉按选中地址实时算运费（镜像服务端 shippingFeeFor 口径），
// 带运费订单确认后直接拉起微信支付（取消=静默，成功进订单页）。
// 尺码（devops#910）：by_sku 商品抽屉必选尺码（售罄码置灰），数量上限 = 
// min(限购余量, 选中码 stock, 99)；single 商品不渲染尺码区，行为与现网一致；
// 订单尺码快照（sku_label）在成功弹卡与订单页展示。
import { userStore } from '../../store/index';
import { openLogin } from '../../utils/authGate';
import { getCheckInStatus } from '../../services/checkin';
import { ApiError } from '../../services/request';
import {
  createRedemption,
  listAddresses,
  listPointProducts,
  newIdempotencyKey,
  payErrorCopy,
  payShippingFee,
  pointsErrorCopy,
  waitOrderSettled,
} from '../../services/points';
import type { PointProduct, PointProductSku, UserAddress } from '../../services/points';
import { formatFen, shippingFeeFen } from '../../utils/shipping';
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
  /** by_sku = 抽屉选尺码（devops#910）；旧后端无 spec_mode → single，现网行为。 */
  bySku: boolean;
  /** by_sku 的尺码行（sort_order ASC，服务端原样透传）；single 恒空。 */
  skus: PointProductSku[];
  /** 运费策略 + 运费（分）：抽屉按地址实时换算（devops#905）。 */
  policy: string;
  feeFen: number;
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
  /** 步进上限：by_sku 选中码 = min(限购余量, 码 stock, 99)，未选/single = min(限购余量, 99)。 */
  sheetMaxQty: number;
  /** 尺码区数据（devops#910）：by_sku 才非空（渲染 chips）；sheetSkuId=0 表示未选（提交被拦）。 */
  sheetSkus: PointProductSku[];
  sheetSkuId: number;
  sheetAddresses: SheetAddress[];
  sheetSelectedId: number;
  /** 抽屉三态文案：兑换后剩余 / 积分不足还差 N 分。 */
  sheetAfter: number;
  sheetLack: number;
  sheetInsufficient: boolean;
  sheetNoAddress: boolean;
  sheetSubmitting: boolean;
  /** 运费（devops#905）：sheetFeeText = 「包邮」/「¥N」/未选地址「—」；
   * 合计 = 「N 积分」，非「包邮」才追加「+ M」（未选地址保留「+ —」，devops#920）。 */
  sheetFeeText: string;
  sheetFeeFree: boolean;
  sheetTotalText: string;
  /** 兑换成功居中弹卡。 */
  okVisible: boolean;
  okName: string;
  /** 尺码快照（devops#910）：by_sku 订单展示，single/旧单空 = 不渲染该行。 */
  okSku: string;
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
  /** 尺码 chip 点选（devops#910）：售罄码拒绝；切换联动步进上限并夹取数量。 */
  onSkuTap(e: WechatMiniprogram.TouchEvent): void;
  onSheetClose(): void;
  onQtyMinus(): void;
  onQtyPlus(): void;
  onSheetSelectAddr(e: WechatMiniprogram.TouchEvent): void;
  onSheetManageAddr(): void;
  onSheetAddAddr(): void;
  onSheetConfirm(): void;
  /** 带运费订单的支付流：prepay → wx.requestPayment → 结局分流（订单页/静默）。 */
  startPayment(orderId: string): Promise<void>;
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

/** 商品卡四态推导：售罄（stock=0）与达限（redeemed≥limit>0）是两种置灰原因，视觉区分。
 * by_sku 商品后端返回的 stock = SKU 合计（仅展示，devops#909），全码售罄即 stock=0，
 * 同一口径喂蒙层+灰钮；旧后端返回商品级真库存，向后兼容。 */
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
    bySku: p.spec_mode === 'by_sku',
    skus: p.skus || [],
    // 旧后端无运费字段时 undefined → shippingFeeFen 按免运处理。
    policy: p.shipping_policy,
    feeFen: p.shipping_fee || 0,
  };
}

/** 步进上限（devops#910）：限购余量封顶（不限购 99）；by_sku 选中码再取码 stock。
 * 售罄码不可选，min 结果恒 ≥1；未选码时上限只受限购约束（提交另有闸门）。 */
function calcSheetMaxQty(product: MallProduct, skuId: number): number {
  const base = product.limit > 0 ? Math.max(1, product.limit - product.redeemed) : 99;
  if (!product.bySku || !skuId) return base;
  const sku = product.skus.find((s) => s.id === skuId);
  return sku ? Math.min(base, sku.stock) : base;
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
    sheetSkus: [],
    sheetSkuId: 0,
    sheetAddresses: [],
    sheetSelectedId: 0,
    sheetAfter: 0,
    sheetLack: 0,
    sheetInsufficient: false,
    sheetNoAddress: false,
    sheetSubmitting: false,
    sheetFeeText: '—',
    sheetFeeFree: false,
    sheetTotalText: '',
    okVisible: false,
    okName: '',
    okSku: '',
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
      // 注意 _sheetProduct/sheetSkus 保持打开时刻快照（single 商品同样如此），
      // 他端买空/改价不实时进抽屉，由提交时 409 业务码关抽屉静默刷新兜底 ——
      // 这是有意取舍，不是漏校准（devops#910 评审定版）。
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
      // by_sku 初始未选尺码（sheetSkuId=0），选中后上限再联动码库存（devops#910）。
      // 码表渲染看 sheetSkus.length：by_sku 但码表异常为空（后端回归）时视同
      // single 兜底，提交由服务端 sku_required 拦截 + toast，不留死端抽屉。
      sheetMaxQty: calcSheetMaxQty(product, 0),
      sheetSkus: product.bySku ? product.skus : [],
      sheetSkuId: 0,
      sheetSubmitting: false,
      okVisible: false,
      okSku: '',
    });
    this.refreshSheet();
  },

  /** 以最新地址簿/余额重算抽屉（默认地址预选、选中粉描边、剩余/不足三态、运费/合计）。 */
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
    // 运费只与选中地址的省份有关（每单固定，不随数量翻倍，同服务端口径）；
    // 未选地址显示 —，选中后切换地址即时刷新（devops#905 AC）。
    const selected = addresses.find((a) => a.id === selectedId);
    const feeFen = selected ? shippingFeeFen(product.policy, product.feeFen, selected.province) : 0;
    const free = !selected || feeFen <= 0;
    const feeText = selected ? (feeFen > 0 ? `¥${formatFen(feeFen)}` : '包邮') : '—';
    this.setData({
      sheetAddresses,
      sheetSelectedId: selectedId,
      sheetNoAddress: sheetAddresses.length === 0,
      sheetTotal: total,
      sheetAfter: insufficient ? 0 : after,
      sheetLack: insufficient ? -after : 0,
      sheetInsufficient: insufficient,
      sheetFeeText: feeText,
      sheetFeeFree: free,
      // 免运不带「+ 包邮」（devops#920，与下方运费行重复）；收现金保留「+ ¥N」。
      sheetTotalText: feeText === '包邮' ? `${total} 积分` : `${total} 积分 + ${feeText}`,
    });
  },

  onSheetClose() {
    if (this.data.sheetSubmitting) return;
    this.setData({ sheetVisible: false });
    this._sheetProduct = undefined;
  },

  // 尺码点选（devops#910）：提交中/售罄码（stock=0）/重复点选直接忽略；切换后
  // 步进上限联动码库存，已点数量超出时夹取，合计/不足态随 refreshSheet 重算。
  onSkuTap(e: WechatMiniprogram.TouchEvent) {
    const product = this._sheetProduct;
    if (!product || !product.bySku || this.data.sheetSubmitting) return;
    const sid = Number(e.currentTarget.dataset.sid);
    if (!sid || sid === this.data.sheetSkuId) return;
    const sku = product.skus.find((s) => s.id === sid);
    if (!sku || sku.stock <= 0) return;
    const maxQty = calcSheetMaxQty(product, sid);
    this.setData({
      sheetSkuId: sid,
      sheetMaxQty: maxQty,
      sheetQty: Math.min(this.data.sheetQty, maxQty),
    });
    this.refreshSheet();
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

  // 切地址：运费随省份即时刷新（devops#905 AC）。
  onSheetSelectAddr(e: WechatMiniprogram.TouchEvent) {
    this.setData({ sheetSelectedId: Number(e.currentTarget.dataset.aid) });
    this.refreshSheet();
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
            this.refreshSheet();
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
    // by_sku 未选尺码：按钮已置灰，此处兜底拦截（devops#910 AC）。
    // 码表空（异常兜底态）不拦——放行给服务端 sku_required + toast，不留死端。
    if (product.bySku && this.data.sheetSkus.length && !this.data.sheetSkuId) return;
    this.setData({ sheetSubmitting: true });
    try {
      const res = await createRedemption(product.id, this.data.sheetSelectedId, idemKey, this.data.sheetQty, this.data.sheetSkuId);
      // 幂等键已消费：重放/replay 也一样，下一次兑换必须换新 key。
      this._idemKey = newIdempotencyKey();
      // 带运费订单（pending_payment）：关抽屉直接进支付流（devops#905），
      // 免运订单维持原成功弹卡；旧后端无此状态，自然走原路径。
      if (res.order.status === 'pending_payment') {
        this.setData({ sheetVisible: false, sheetSubmitting: false, balance: res.balance });
        this._sheetProduct = undefined;
        void this.load(true);
        await this.startPayment(res.order.id);
        return;
      }
      this.setData({
        sheetVisible: false,
        sheetSubmitting: false,
        okVisible: true,
        okName: res.order.product_name,
        // 尺码快照：by_sku 订单展示，single/旧单缺省空 → 弹卡不渲染该行。
        okSku: res.order.sku_label || '',
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
      // 商品态失效（售罄/达限/下架/尺码行失效）：关抽屉回列表，静默刷新校准四态。
      // sku_invalid（devops#910）= 尺码行被删或换货，本地码表已过期，同口径关闭重校准。
      if (
        code === 'limit_reached' ||
        code === 'out_of_stock' ||
        code === 'product_inactive' ||
        code === 'sku_invalid'
      ) {
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

  /**
   * 带运费订单支付流（devops#905）：调用时抽屉已关、订单已建（pending_payment）。
   * 结局分流：
   * - paid：轮询等回调落账后进订单页（已支付态）；
   * - cancel（用户取消）：静默返回不弹错，订单留待支付，可去订单页「去支付」重试；
   * - 真实失败（prepay 业务码 / 收银台非取消错误）：toast 文案，订单同样留待支付。
   */
  async startPayment(orderId: string) {
    let outcome: 'paid' | 'cancel';
    try {
      outcome = await payShippingFee(orderId);
    } catch (err: unknown) {
      wx.showToast({ title: payErrorCopy(err, '支付未完成，请稍后再试'), icon: 'none' });
      return;
    }
    if (outcome === 'cancel') return; // 用户取消：静默返回
    await waitOrderSettled(orderId);
    wx.navigateTo({
      url: `/pages/points-orders/points-orders?paid=${orderId}`,
      fail: () => wx.switchTab({ url: '/pages/coach/coach' }),
    });
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
