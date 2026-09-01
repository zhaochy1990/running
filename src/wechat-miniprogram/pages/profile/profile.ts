import { userStore } from '../../store/index';
import { triggerSync, pollPipeline } from '../../services/sync';
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
}

interface ProfilePageHandlers {
  onMenuTap(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
  onLogout(): void;
  onEditProfile(): void;
  onSyncTap(): void;
  startSync(userId: string): Promise<void>;
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
    wx.showToast({ title: `「${key}」建设中`, icon: 'none' });
  },

  onEditProfile() {
    wx.showToast({ title: '资料编辑建设中', icon: 'none' });
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
