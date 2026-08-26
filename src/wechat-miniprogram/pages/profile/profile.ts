import { userStore } from '../../store/index';
import type { UserProfile } from '../../types/api';

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
}

interface ProfilePageHandlers {
  onMenuTap(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
  onLogout(): void;
  onEditProfile(): void;
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
  { key: 'privacy', title: '隐私与权限', iconPath: '/assets/icons/lock.svg' },
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
  },

  onShow() {
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
