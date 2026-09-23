import { sendBindPhoneCode, wechatBindAccount, wechatBindPhone } from '../../services/auth';
import { userStore } from '../../store/index';

// 手机号验证码登录的特性开关（issue #335）：auth-service 的新 grant
// wechat_phone_bind 已上线后置 true；auth 回滚/未上线的窗口期置 false，
// 登录页回落到默认邮箱 tab，手机号 tab 禁用。
const PHONE_LOGIN_AVAILABLE = true;

// 验证码倒计时时长（秒），与设计稿「52 秒后重发」的禁用倒计时文案一致
const CODE_RESEND_SECONDS = 60;

type LoginTab = 'email' | 'phone';
type FocusField = '' | 'email' | 'password' | 'phone' | 'code';

interface LoginPageData {
  tab: LoginTab;
  email: string;
  password: string;
  showPassword: boolean;
  phone: string;
  code: string;
  codeCountdown: number;
  focusField: FocusField;
  loading: boolean;
  errorMsg: string;
}

// 页面自定义方法（TCustom 泛型，供 this 类型收窄）
interface LoginPageHandlers {
  onSwitchTab(e: WechatMiniprogram.TouchEvent): void;
  onFieldFocus(e: WechatMiniprogram.TouchEvent): void;
  onFieldBlur(): void;
  onEmailInput(e: WechatMiniprogram.Input): void;
  onPasswordInput(e: WechatMiniprogram.Input): void;
  onTogglePassword(): void;
  onForgotPasswordTap(): void;
  onPhoneInput(e: WechatMiniprogram.Input): void;
  onCodeInput(e: WechatMiniprogram.Input): void;
  onGetCode(): Promise<void>;
  startCodeCountdown(): void;
  onLoginTap(): Promise<void>;
  submitEmail(): Promise<void>;
  submitPhone(): Promise<void>;
  onTermsTap(): void;
  onPrivacyTap(): void;
}

// 倒计时 timer（页面实例卸载时清理，避免残留定时器）
let codeTimer: ReturnType<typeof setInterval> | null = null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1\d{10}$/;

Page<LoginPageData, LoginPageHandlers>({
  data: {
    // 默认手机号 tab（开关开启时）：新用户无需已有账号即可注册；邮箱密码 tab
    // 保留给老用户。开关关闭时回落邮箱 tab。
    tab: PHONE_LOGIN_AVAILABLE ? ('phone' as LoginTab) : ('email' as LoginTab),
    email: '',
    password: '',
    showPassword: false,
    phone: '',
    code: '',
    codeCountdown: 0,
    focusField: '',
    loading: false,
    errorMsg: '',
  },

  onUnload() {
    if (codeTimer) {
      clearInterval(codeTimer);
      codeTimer = null;
    }
  },

  // --- 通用 ---

  onSwitchTab(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as LoginTab;
    if (tab === this.data.tab) return;
    if (tab === 'phone' && !PHONE_LOGIN_AVAILABLE) {
      this.setData({ errorMsg: '手机号登录暂未开放，请使用邮箱登录' });
      return;
    }
    this.setData({ tab, errorMsg: '', focusField: '' });
  },

  onFieldFocus(e: WechatMiniprogram.TouchEvent) {
    this.setData({ focusField: e.currentTarget.dataset.field as FocusField });
  },

  onFieldBlur() {
    this.setData({ focusField: '' });
  },

  // --- 邮箱登录 ---

  onEmailInput(e: WechatMiniprogram.Input) {
    this.setData({ email: e.detail.value, errorMsg: '' });
  },

  onPasswordInput(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, errorMsg: '' });
  },

  onTogglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  onForgotPasswordTap() {
    // 忘记密码页 /register 恢复流程暂未上线（小程序内无对应路由）
    wx.showToast({ title: '暂未开放，请联系客服', icon: 'none' });
  },

  // --- 手机号登录 ---

  onPhoneInput(e: WechatMiniprogram.Input) {
    this.setData({ phone: e.detail.value, errorMsg: '' });
  },

  onCodeInput(e: WechatMiniprogram.Input) {
    this.setData({ code: e.detail.value, errorMsg: '' });
  },

  async onGetCode() {
    const { phone, codeCountdown, loading } = this.data;
    if (codeCountdown > 0 || loading) return;

    if (!PHONE_LOGIN_AVAILABLE) {
      this.setData({ errorMsg: '手机号登录暂未开放，请使用邮箱登录' });
      return;
    }

    if (!PHONE_RE.test(phone)) {
      this.setData({ errorMsg: '请输入正确的手机号' });
      return;
    }

    // 发送失败不启动倒计时（服务端 60 秒冷却 / 日上限的中文提示展示在错误区）
    this.setData({ loading: true, errorMsg: '' });
    try {
      await sendBindPhoneCode(phone);
      this.startCodeCountdown();
      wx.showToast({ title: '验证码已发送', icon: 'none' });
    } catch (err) {
      this.setData({
        errorMsg: err instanceof Error ? err.message : '发送失败，请重试',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  startCodeCountdown() {
    this.setData({ codeCountdown: CODE_RESEND_SECONDS });
    if (codeTimer) clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      const next = this.data.codeCountdown - 1;
      if (next <= 0) {
        if (codeTimer) clearInterval(codeTimer);
        codeTimer = null;
        this.setData({ codeCountdown: 0 });
        return;
      }
      this.setData({ codeCountdown: next });
    }, 1000);
  },

  // --- 提交 ---

  async onLoginTap() {
    const { tab, loading } = this.data;
    if (loading) return;

    if (tab === 'email') {
      await this.submitEmail();
      return;
    }
    await this.submitPhone();
  },

  async submitEmail() {
    const email = this.data.email.trim();
    const password = this.data.password;

    if (!email) {
      this.setData({ errorMsg: '请输入邮箱' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      this.setData({ errorMsg: '邮箱格式不正确' });
      return;
    }
    if (!password) {
      this.setData({ errorMsg: '请输入密码' });
      return;
    }

    this.setData({ loading: true, errorMsg: '' });
    try {
      const result = await wechatBindAccount(email, password);
      if (!result.ok) return;
      userStore.setUser(result.user);
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 1000);
    } catch (err) {
      this.setData({
        errorMsg: err instanceof Error ? err.message : '登录失败，请重试',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async submitPhone() {
    if (!PHONE_LOGIN_AVAILABLE) {
      this.setData({ errorMsg: '手机号登录暂未开放，请使用邮箱登录' });
      return;
    }

    const phone = this.data.phone;
    const code = this.data.code;
    if (!PHONE_RE.test(phone)) {
      this.setData({ errorMsg: '请输入正确的手机号' });
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      this.setData({ errorMsg: '请输入 6 位验证码' });
      return;
    }

    this.setData({ loading: true, errorMsg: '' });
    try {
      const result = await wechatBindPhone(phone, code);
      userStore.setUser(result.user);
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        if (result.registered) {
          // 新注册用户一次性进入手表绑定引导页（可跳过）。
          // redirectTo 替换登录页：返回键不再回到已登录状态的登录页。
          wx.redirectTo({ url: '/pages/watch-onboarding/watch-onboarding' });
          return;
        }
        wx.switchTab({ url: '/pages/index/index' });
      }, 1000);
    } catch (err) {
      this.setData({
        errorMsg: err instanceof Error ? err.message : '登录失败，请重试',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  // --- 法务链接 ---

  onTermsTap() {
    // 服务条款 Web 页暂未在小程序内接入（web-view 路由未建）
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onPrivacyTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },
});
