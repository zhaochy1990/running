// 地址簿页（devops#886，UI 权威 = devops#852 resolution + 原型）。
// 双模式（#886 scope 4）：管理（默认标/设默认粉字/编辑/删除）与单选
// （选中粉描边、无操作行，确认抽屉「管理地址 ›」进入，挑完带 id 回商城）。
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import { deleteAddress, listAddresses, pointsErrorCopy, setAddressDefault } from '../../services/points';
import type { UserAddress } from '../../services/points';

/** 地址卡视图模型。 */
interface AddressRow {
  id: number;
  name: string;
  phone: string;
  /** 「省 市 区 · 详址」。 */
  addr: string;
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
  onDelete(e: WechatMiniprogram.TouchEvent): void;
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
          addr: `${a.province} ${a.city} ${a.district} · ${a.address_detail}`,
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

  // 底部虚线「＋新增收货地址（上限 10 条）」。
  onAdd() {
    wx.navigateTo({ url: '/pages/address-form/address-form' });
  },
});
