import { wechatBindAccount } from '../../services/auth';
import { userStore } from '../../store/index';

interface BindPageData {
  email: string;
  password: string;
  loading: boolean;
  errorMsg: string;
}

Page({
  data: {
    email: '',
    password: '',
    loading: false,
    errorMsg: '',
  } as BindPageData,

  onEmailInput(e: WechatMiniprogram.Input) {
    this.setData({ email: e.detail.value, errorMsg: '' });
  },

  onPasswordInput(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, errorMsg: '' });
  },

  async onBindTap() {
    const { email, password } = this.data;

    if (!email) {
      this.setData({ errorMsg: '请输入邮箱' });
      return;
    }
    if (!password) {
      this.setData({ errorMsg: '请输入密码' });
      return;
    }

    this.setData({ loading: true, errorMsg: '' });

    try {
      const result = await wechatBindAccount(email, password);
      if (result.ok) {
        userStore.setUser(result.user);
      }

      wx.showToast({ title: '绑定成功', icon: 'success' });

      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '绑定失败';
      this.setData({ errorMsg: msg });
    } finally {
      this.setData({ loading: false });
    }
  },

  onBackTap() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },
});
