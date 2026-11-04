// 新增/编辑收货地址（devops#886 地址簿配套表单；原型注明「表单原型略」，
// 字段 = #884 契约 addressCreateRequest 七项）。?id= 有值即编辑态。
// 省市区 V1 用纯文本输入（不引地区选择器数据包）。
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import { createAddress, listAddresses, pointsErrorCopy, updateAddress } from '../../services/points';
import type { AddressPayload } from '../../services/points';

interface AddressFormData {
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
}

interface AddressFormPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1 显示回主页的小房子 */
  canBack: boolean;
  /** 编辑态标题「编辑地址」；新增态「新增地址」。 */
  editing: boolean;
  guest: boolean;
  loading: boolean;
  loadFailed: boolean;
  saving: boolean;
  form: AddressFormData;
}

interface AddressFormPageHandlers {
  onBack(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onNameInput(e: WechatMiniprogram.Input): void;
  onPhoneInput(e: WechatMiniprogram.Input): void;
  onProvinceInput(e: WechatMiniprogram.Input): void;
  onCityInput(e: WechatMiniprogram.Input): void;
  onDistrictInput(e: WechatMiniprogram.Input): void;
  onDetailInput(e: WechatMiniprogram.Input): void;
  onDefaultToggle(e: WechatMiniprogram.SwitchChange): void;
  onSave(): void;
  load(): Promise<void>;
  _id?: number;
  /** 编辑态回填只做一次（防 onShow 重入覆盖用户正在输入的内容）。 */
  _loaded?: boolean;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

const EMPTY_FORM: AddressFormData = {
  name: '',
  phone: '',
  province: '',
  city: '',
  district: '',
  detail: '',
  isDefault: false,
};

Page<AddressFormPageData, AddressFormPageHandlers>({
  data: {
    statusBarHeight: 0,
    canBack: false,
    editing: false,
    guest: false,
    loading: false,
    loadFailed: false,
    saving: false,
    form: EMPTY_FORM,
  },

  onLoad(options: Record<string, string | undefined>) {
    this._id = Number(options?.id || 0) || 0;
    const editing = this._id > 0;
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      editing,
      loading: editing,
    });
  },

  onShow() {
    if (!userStore.getState().isAuthenticated) {
      this.setData({ guest: true, loading: false });
      return;
    }
    this.setData({ guest: false });
    if ((this._id || 0) > 0 && !this._loaded) {
      void this.load();
    }
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onGuestLogin() {
    openLogin(currentRouteForRedirect() || '/pages/addresses/addresses');
  },

  // 编辑态回填（契约无单条 GET 端点，从列表里找本条）。
  async load() {
    const id = this._id || 0;
    this.setData({ loading: true, loadFailed: false });
    try {
      const res = await listAddresses();
      const addr = res.addresses.find((a) => a.id === id);
      if (!addr) {
        this.setData({ loading: false, loadFailed: true });
        return;
      }
      this._loaded = true;
      this.setData({
        loading: false,
        form: {
          name: addr.receiver_name,
          phone: addr.receiver_phone,
          province: addr.province,
          city: addr.city,
          district: addr.district,
          detail: addr.address_detail,
          isDefault: addr.is_default,
        },
      });
    } catch {
      this.setData({ loading: false, loadFailed: true });
    }
  },

  onRetry() {
    void this.load();
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.name': e.detail.value });
  },

  onPhoneInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.phone': e.detail.value });
  },

  onProvinceInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.province': e.detail.value });
  },

  onCityInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.city': e.detail.value });
  },

  onDistrictInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.district': e.detail.value });
  },

  onDetailInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.detail': e.detail.value });
  },

  onDefaultToggle(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'form.isDefault': e.detail.value });
  },

  async onSave() {
    if (this.data.saving) return;
    const id = this._id || 0;
    const f = this.data.form;
    if (!f.name.trim() || !f.phone.trim() || !f.province.trim() || !f.city.trim() || !f.district.trim() || !f.detail.trim()) {
      wx.showToast({ title: '请填写完整的收货信息', icon: 'none' });
      return;
    }
    // 手机号先本地把关（后端 422 文案不友好，仓内无可复用校验工具）
    if (!/^1\d{10}$/.test(f.phone.trim())) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload: AddressPayload = {
      receiver_name: f.name.trim(),
      receiver_phone: f.phone.trim(),
      province: f.province.trim(),
      city: f.city.trim(),
      district: f.district.trim(),
      address_detail: f.detail.trim(),
      is_default: f.isDefault,
    };
    try {
      if (id > 0) {
        await updateAddress(id, payload);
      } else {
        await createAddress(payload);
      }
      wx.showToast({ title: '已保存', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 400);
    } catch (err: unknown) {
      this.setData({ saving: false });
      wx.showToast({ title: pointsErrorCopy(err, '保存失败，请稍后再试'), icon: 'none' });
    }
  },
});
