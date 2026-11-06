// 地址簿页（devops#886；UI = 抖音商城地址页布局，用户 11-06 拍板）。
// 双模式（#886 scope 4）：管理（标题「收货地址」）与单选（?mode=pick，
// 标题「选择地址」，右侧 radio 圆圈，点卡即带 id 回商城抽屉）。两种模式
// 卡片都带操作行（设默认/复制/编辑/删除，抖音式；catchtap 防误触点卡回传）。
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import { createAddress, deleteAddress, listAddresses, pointsErrorCopy, setAddressDefault } from '../../services/points';
import type { UserAddress } from '../../services/points';

/** 地址卡视图模型（抖音式分层展示）。 */
interface AddressRow {
  id: number;
  name: string;
  phone: string;
  /** 「省 市 区」灰行。 */
  region: string;
  /** 详细地址（粗体行）。 */
  detail: string;
  /** 复制按钮构造 payload 用的独立字段。 */
  province: string;
  city: string;
  district: string;
  isDefault: boolean;
  selected: boolean;
}

interface AddressesPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1 显示回主页的小房子 */
  canBack: boolean;
  /** 单选模式（?mode=pick）：标题「选择地址」，点卡即回传，无操作行/新增钮。 */
  pickMode: boolean;
  guest: boolean;
  loading: boolean;
  loadFailed: boolean;
  addresses: AddressRow[];
}

interface AddressesPageHandlers {
  onBack(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onAddressTap(e: WechatMiniprogram.TouchEvent): void;
  onSetDefault(e: WechatMiniprogram.TouchEvent): void;
  onEdit(e: WechatMiniprogram.TouchEvent): void;
  /** 复制：即时克隆一条新地址（不带走默认标记）。 */
  onCopy(e: WechatMiniprogram.TouchEvent): void;
  onDelete(e: WechatMiniprogram.TouchEvent): void;
  /** 操作行空白区冒泡拦截（单选模式防误触点卡回传）。 */
  onActsTap(): void;
  onAdd(): void;
  load(silent?: boolean): Promise<void>;
  _pickSelected?: number;
  /** 设默认/删除防双击重入（无对应 data 展示态，实例锁即可，同 checkin 范式）。 */
  _busy?: boolean;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<AddressesPageData, AddressesPageHandlers>({
  data: {
    statusBarHeight: 0,
    canBack: false,
    pickMode: false,
    guest: false,
    loading: true,
    loadFailed: false,
    addresses: [],
  },

  onLoad(options: Record<string, string | undefined>) {
    this._pickSelected = Number(options?.selected || 0) || 0;
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      pickMode: options?.mode === 'pick',
    });
  },

  onShow() {
    if (!userStore.getState().isAuthenticated) {
      this.setData({ guest: true, loading: false });
      return;
    }
    const silent = this.data.addresses.length > 0 || this.data.loadFailed;
    this.setData({ guest: false });
    void this.load(silent);
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onGuestLogin() {
    openLogin(currentRouteForRedirect() || '/pages/addresses/addresses');
  },

  async load(silent?: boolean) {
    if (!silent) {
      this.setData({ loading: true, loadFailed: false });
    }
    try {
      const res = await listAddresses();
      const pickMode = this.data.pickMode;
      const selected = this._pickSelected;
      this.setData({
        loading: false,
        loadFailed: false,
        addresses: res.addresses.map((a: UserAddress) => ({
          id: a.id,
          name: a.receiver_name,
          phone: a.receiver_phone,
          region: `${a.province} ${a.city} ${a.district}`,
          detail: a.address_detail,
          province: a.province,
          city: a.city,
          district: a.district,
          isDefault: a.is_default,
          selected: pickMode && a.id === selected,
        })),
      });
    } catch {
      if (silent) return;
      this.setData({ loading: false, loadFailed: true });
    }
  },

  onRetry() {
    void this.load();
  },

  // 单选模式：点卡即回传商城抽屉并返回。
  onAddressTap(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.pickMode) return;
    const id = Number(e.currentTarget.dataset.id);
    const ch = this.getOpenerEventChannel?.();
    if (ch) {
      ch.emit?.('addressSelected', { id });
    }
    wx.navigateBack();
  },

  // 管理模式：设为默认（粉字，非默认才显示；服务端清同用户其余默认位）。
  async onSetDefault(e: WechatMiniprogram.TouchEvent) {
    if (this._busy) return;
    this._busy = true;
    const id = Number(e.currentTarget.dataset.id);
    try {
      await setAddressDefault(id);
      wx.showToast({ title: '已设为默认', icon: 'none' });
      void this.load(true);
    } catch (err: unknown) {
      wx.showToast({ title: pointsErrorCopy(err, '设置失败，请稍后再试'), icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  onEdit(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/address-form/address-form?id=${Number(e.currentTarget.dataset.id)}` });
  },

  // 复制（抖音式即时克隆；is_default 恒 false，防抢走原默认位；超 10 条上限由后端报错透出）。
  async onCopy(e: WechatMiniprogram.TouchEvent) {
    if (this._busy) return;
    this._busy = true;
    const row = this.data.addresses.find((a) => a.id === Number(e.currentTarget.dataset.id));
    if (!row) {
      this._busy = false;
      return;
    }
    try {
      await createAddress({
        receiver_name: row.name,
        receiver_phone: row.phone,
        province: row.province,
        city: row.city,
        district: row.district,
        address_detail: row.detail,
        is_default: false,
      });
      wx.showToast({ title: '已复制', icon: 'none' });
      void this.load(true);
    } catch (err: unknown) {
      wx.showToast({ title: pointsErrorCopy(err, '复制失败，请稍后再试'), icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  // 操作行容器级冒泡拦截：catchtap 空实现，缝隙点击不落到卡片上。
  onActsTap() {
    // 链接自身的 catchtap 已拦截，这里只兜行内空白区。
  },

  // 删除（原型：直接删 + toast，无二次确认弹层）。
  async onDelete(e: WechatMiniprogram.TouchEvent) {
    if (this._busy) return;
    this._busy = true;
    const id = Number(e.currentTarget.dataset.id);
    try {
      await deleteAddress(id);
      wx.showToast({ title: '已删除', icon: 'none' });
      void this.load(true);
    } catch (err: unknown) {
      wx.showToast({ title: pointsErrorCopy(err, '删除失败，请稍后再试'), icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  // 分节头右侧「＋ 新建地址」文字链。
  onAdd() {
    wx.navigateTo({ url: '/pages/address-form/address-form' });
  },
});
