import { userStore } from '../../store/index';
import { triggerSync, pollPipeline } from '../../services/sync';
import { uploadAvatar, updateProfile } from '../../services/profile';
import { getWatchInfo } from '../../services/watch';
import type { UserProfile } from '../../types/api';
import type { PollPipelineHandle } from '../../services/sync';

interface MenuRow {
  key: string;
  title: string;
  iconPath: string;
}

interface ProfilePageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  user: UserProfile | null;
  name: string;
  email: string;
  avatarUrl: string;
  rows: MenuRow[];
  syncing: boolean;
  lastSyncText: string;
  // 资料编辑 sheet
  editVisible: boolean;
  editAvatarTemp: string;
  editAvatarUrl: string;
  editName: string;
  saving: boolean;
}

interface ProfilePageHandlers {
  onMenuTap(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
  onLogout(): void;
  onEditProfile(): void;
  onCloseEdit(): void;
  noop(): void;
  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>): void;
  onNameInput(e: WechatMiniprogram.Input): void;
  onSaveName(): void;
  saveAvatar(): void;
  onSyncTap(): void;
  startSync(userId: string): Promise<void>;
  refreshLastSync(): Promise<void>;
  /** 当前同步任务的轮询句柄，存实例上以避免模块级状态在多实例间串扰。 */
  _pollHandle?: PollPipelineHandle;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function relativeTime(ms: number): string {
  if (ms < 0) ms = 0;
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
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

const MENU_ROWS: MenuRow[] = [
  { key: 'profile', title: '个人资料', iconPath: '/assets/icons/person.svg' },
  { key: 'plan', title: '我的训练计划', iconPath: '/assets/icons/calendar_month.svg' },
  { key: 'watch', title: '手表管理', iconPath: '/assets/icons/schedule.svg' },
];

Page<ProfilePageData, ProfilePageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    user: null,
    name: '跑步爱好者',
    email: '',
    avatarUrl: '',
    rows: MENU_ROWS,
    syncing: false,
    lastSyncText: '未同步',
    editVisible: false,
    editAvatarTemp: '',
    editAvatarUrl: '',
    editName: '',
    saving: false,
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 3 });
    }

    const state = userStore.getState();
    const user = state.user;
    this.setData({
      user,
      name: user?.name || '跑步爱好者',
      email: user?.email || '',
      avatarUrl: user?.avatar_url || '',
    });
    void this.refreshLastSync();
  },

  async refreshLastSync() {
    if (!this.data.user?.id) {
      this.setData({ lastSyncText: '未同步' });
      return;
    }
    try {
      const info = await getWatchInfo();
      const lastSync = info.last_sync_at;
      this.setData({
        lastSyncText: lastSync
          ? `上次同步 ${relativeTime(Date.now() - Date.parse(lastSync))}`
          : '未同步',
      });
    } catch {
      // 保留上次值；临时网络错误不打断页面。
    }
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onUnload() {
    if (this._pollHandle) {
      this._pollHandle.cancel();
      this._pollHandle = undefined;
    }
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onRowTap(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key as string;
    if (key === 'watch') {
      wx.navigateTo({ url: '/pages/watch/watch' });
      return;
    }
    wx.showToast({ title: `「${key}」建设中`, icon: 'none' });
  },

  onEditProfile() {
    this.setData({
      editVisible: true,
      editAvatarTemp: '',
      editAvatarUrl: this.data.avatarUrl,
      editName: this.data.name,
    });
  },

  onCloseEdit() {
    if (this.data.saving) return;
    this.setData({ editVisible: false });
  },

  noop() {
    // 阻止 sheet 内点击冒泡到 mask（catchtap 已拦截，这里留空占位）。
  },

  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    // 选完头像立即保存，但不关 sheet、不弹提示——用户可能还要继续授权昵称。
    this.setData({ editAvatarTemp: e.detail.avatarUrl });
    void this.saveAvatar();
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ editName: e.detail.value });
  },

  // 昵称在输入结束（失焦）时保存，无需点按钮；空值不提交。不弹提示。
  async onSaveName() {
    const name = this.data.editName.trim();
    if (!name || name === this.data.name || this.data.saving) return;
    this.setData({ saving: true });
    try {
      const updated = await updateProfile({ name });
      userStore.setUser(updated);
      this.setData({ name: updated.name || name, user: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      wx.showToast({ title: msg.length > 15 ? '保存失败' : msg, icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 只保存头像（选完即存），不关 sheet、不弹成功提示。
  async saveAvatar() {
    if (this.data.saving || !this.data.editAvatarTemp) return;
    this.setData({ saving: true });
    try {
      const avatarUrl = await uploadAvatar(this.data.editAvatarTemp);
      const updated = await updateProfile({ avatar_url: avatarUrl });
      userStore.setUser(updated);
      this.setData({
        avatarUrl: updated.avatar_url || avatarUrl,
        editAvatarUrl: updated.avatar_url || avatarUrl,
        editAvatarTemp: '',
        user: updated,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '头像保存失败';
      wx.showToast({ title: msg.length > 15 ? '头像保存失败' : msg, icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onSyncTap() {
    if (this.data.syncing) return;

    const state = userStore.getState();
    const userId = state.user?.id;
    if (!userId) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }

    this.setData({ syncing: true });
    void this.startSync(userId);
  },

  async startSync(userId: string) {
    try {
      const res = await triggerSync(userId);
      if (!res.run_id) {
        throw new Error('同步任务创建失败');
      }

      const poll = pollPipeline(res.run_id);
      this._pollHandle = poll;
      await poll.promise;
      await this.refreshLastSync();
      wx.showToast({ title: '同步成功', icon: 'success' });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'cancelled') {
        return;
      }
      const msg = err instanceof Error ? err.message : '同步失败';
      wx.showToast({ title: msg.length > 15 ? '同步失败' : msg, icon: 'none' });
    } finally {
      // 只清「自己创建」的句柄：若页面已因卸载/重登进入新实例而替换了 handle，
      // 不覆盖新实例的句柄。
      if (this._pollHandle) {
        this._pollHandle = undefined;
        this.setData({ syncing: false });
      }
    }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: (res) => {
        if (res.confirm) {
          userStore.clear();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      },
    });
  },
});
