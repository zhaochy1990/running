// 手表管理页 —— 绑定 / 解绑（镜像 Web 端 WatchPage 的交互）。
import {
  getWatchInfo,
  watchLogin,
  disconnectWatch,
  type WatchInfo,
  type WatchProvider,
} from '../../services/watch';
import { ApiError } from '../../services/request';

interface WatchPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  watch: WatchInfo;
  connected: boolean;
  error: string;
  success: string;
  connectProvider: WatchProvider | null;
  email: string;
  password: string;
  region: 'cn' | 'global';
  regionIndex: number;
  regionOptions: string[];
  connecting: boolean;
  disconnecting: boolean;
  showDisconnectConfirm: boolean;
}

interface WatchPageHandlers {
  onLoad(): void;
  onShow(): void;
  fetchWatch(): Promise<void>;
  onBack(): void;
  onSelectProvider(e: WechatMiniprogram.TouchEvent): void;
  onBackToProviders(): void;
  onEmailInput(e: WechatMiniprogram.Input): void;
  onPasswordInput(e: WechatMiniprogram.Input): void;
  onRegionChange(e: { detail: { value: number } }): void;
  onConnect(): Promise<void>;
  onDisconnectTap(): void;
  onCancelDisconnect(): void;
  onConfirmDisconnect(): Promise<void>;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
  let width = 375;
  try {
    const win = wx.getWindowInfo();
    statusPx = win.statusBarHeight;
    width = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    statusPx = sys.statusBarHeight;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

const REGION_OPTIONS = ['中国区', '国际区'];
const EMPTY_WATCH: WatchInfo = {
  provider: null,
  provider_display_name: null,
  logged_in: false,
  email: null,
  device: null,
  last_sync_at: null,
  capabilities: [],
};

function friendlyLoginError(err: unknown): string {
  // STRIDE 数据面错误体为 {error}/{detail}/{code}；Go watch/login 失败用 `error`
  // 返回可读文案，ApiError 会把它存进 `.code`。优先展示，避免裸 "status 400"。
  if (err instanceof ApiError) {
    if (err.code) return err.code;
    if (err.detail) return err.detail;
  }
  return '登录失败，请检查账号密码';
}

Page<WatchPageData, WatchPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    watch: EMPTY_WATCH,
    connected: false,
    error: '',
    success: '',
    connectProvider: null,
    email: '',
    password: '',
    region: 'cn',
    regionIndex: 0,
    regionOptions: REGION_OPTIONS,
    connecting: false,
    disconnecting: false,
    showDisconnectConfirm: false,
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onShow() {
    void this.fetchWatch();
  },

  async fetchWatch() {
    this.setData({ loading: true, error: '' });
    try {
      const info = await getWatchInfo();
      this.setData({ watch: info, connected: info.logged_in, loading: false });
    } catch {
      this.setData({ loading: false, error: '加载手表信息失败' });
    }
  },

  onBack() {
    wx.navigateBack();
  },

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    const provider = e.currentTarget.dataset.provider as WatchProvider;
    if (!provider) return;
    this.setData({ connectProvider: provider, error: '' });
  },

  onBackToProviders() {
    this.setData({ connectProvider: null, error: '' });
  },

  onEmailInput(e: WechatMiniprogram.Input) {
    this.setData({ email: e.detail.value, error: '' });
  },

  onPasswordInput(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, error: '' });
  },

  onRegionChange(e: { detail: { value: number } }) {
    const index = Number(e.detail.value) || 0;
    this.setData({ regionIndex: index, region: index === 1 ? 'global' : 'cn' });
  },

  async onConnect() {
    const { connectProvider, email, password, region, connecting } = this.data;
    if (connecting || !connectProvider || !email.trim() || !password.trim()) return;

    this.setData({ connecting: true, error: '' });
    try {
      await watchLogin(connectProvider, email.trim(), password, region);
      this.setData({
        success: '绑定成功',
        connectProvider: null,
        email: '',
        password: '',
        connecting: false,
      });
      wx.showToast({ title: '绑定成功', icon: 'success' });
      await this.fetchWatch();
      setTimeout(() => this.setData({ success: '' }), 3000);
    } catch (err) {
      this.setData({ connecting: false, error: friendlyLoginError(err) });
    }
  },

  onDisconnectTap() {
    this.setData({ showDisconnectConfirm: true });
  },

  onCancelDisconnect() {
    this.setData({ showDisconnectConfirm: false });
  },

  async onConfirmDisconnect() {
    if (this.data.disconnecting) return;
    this.setData({ disconnecting: true, error: '' });
    try {
      await disconnectWatch();
      this.setData({ success: '已解除绑定', showDisconnectConfirm: false, disconnecting: false });
      wx.showToast({ title: '已解除绑定', icon: 'success' });
      await this.fetchWatch();
      setTimeout(() => this.setData({ success: '' }), 3000);
    } catch {
      this.setData({ disconnecting: false, error: '解除绑定失败，请重试' });
    }
  },
});
