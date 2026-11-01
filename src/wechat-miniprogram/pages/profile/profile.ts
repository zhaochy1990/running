import { userStore } from '../../store/index';
import { openLogin } from '../../utils/authGate';
import { triggerSync, pollPipeline } from '../../services/sync';
import { getWatchInfo } from '../../services/watch';
import { listFeedbacks } from '../../services/feedback';
import type { UserProfile } from '../../types/api';
import type { PollPipelineHandle } from '../../services/sync';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

interface MenuRow {
  key: string;
  title: string;
  iconPath: string;
  /** 可选副标题（仅意见反馈行用：带出产品路线二级 tab） */
  subtitle?: string;
}

interface ProfilePageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  /** 游客态（未登录）：资料卡显示登录引导，菜单操作引导登录而非强跳 */
  guest: boolean;
  user: UserProfile | null;
  name: string;
  email: string;
  avatarUrl: string;
  rows: MenuRow[];
  /** 意见反馈入口红点（total_unread，99+ 截断），0/隐藏 */
  feedbackUnread: number;
  syncing: boolean;
  lastSyncText: string;
}

interface ProfilePageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onMenuTap(): void;
  onRowTap(e: WechatMiniprogram.TouchEvent): void;
  onOpenProfileEdit(): void;
  onSyncTap(): void;
  startSync(userId: string): Promise<void>;
  refreshLastSync(): Promise<void>;
  refreshFeedbackUnread(): Promise<void>;
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
  { key: 'plan', title: '我的训练计划', iconPath: '/assets/icons/calendar_month.svg' },
  { key: 'training-status', title: '训练状态', iconPath: '/assets/icons/trend_up.svg' },
  { key: 'race-center', title: '赛事中心', iconPath: '/assets/icons/sprint.svg' },
  { key: 'my-races', title: '我的比赛', iconPath: '/assets/icons/flag.svg' },
  // 2026-10-18 拍板：产品路线并入意见反馈页二级 tab（默认反馈 tab），
  // 菜单只留「意见反馈」一行，副标题带出路线
  {
    key: 'feedback',
    title: '意见反馈',
    iconPath: '/assets/icons/forum.svg',
    subtitle: '产品路线也在这里 · 每条我们都会看',
  },
];

Page<ProfilePageData, ProfilePageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    guest: false,
    user: null,
    name: '跑步爱好者',
    email: '',
    avatarUrl: '',
    rows: MENU_ROWS,
    feedbackUnread: 0,
    syncing: false,
    lastSyncText: '未同步',
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 3 });
    }

    const state = userStore.getState();
    const user = state.user;
    // 游客态（未登录）：资料卡即登录按钮（唯一的登录入口，用户自行选择），
    // 菜单操作 toast 提示。登录成功 switchTab 回来时自动切回已登录展示。
    this.setData({
      guest: !state.isAuthenticated,
      user,
      name: state.isAuthenticated ? (user?.name || '跑步爱好者') : '登录 / 注册',
      email: state.isAuthenticated ? (user?.email || '') : '登录后同步你的训练数据',
      avatarUrl: user?.avatar_url || '',
    });
    void this.refreshLastSync();
    void this.refreshFeedbackUnread();
  },

  // 意见反馈入口红点 = total_unread；未登录/失败静默保留现值
  async refreshFeedbackUnread() {
    if (!this.data.user?.id) return;
    try {
      const res = await listFeedbacks();
      this.setData({ feedbackUnread: res.total_unread });
    } catch {
      // 保留现值；临时网络错误不弹窗
    }
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
    // 游客态：菜单功能均需登录，toast 提示（登录入口在上方资料卡，自行选择）。
    if (this.data.guest) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    const key = e.currentTarget.dataset.key as string;
    if (key === 'plan') {
      wx.navigateTo({ url: '/pages/training-plan/training-plan' });
      return;
    }
    if (key === 'training-status') {
      wx.navigateTo({ url: '/pages/training-status/training-status' });
      return;
    }
    if (key === 'race-center') {
      wx.navigateTo({ url: '/pages/race-center/race-center' });
      return;
    }
    if (key === 'my-races') {
      wx.navigateTo({ url: '/pages/my-races/my-races' });
      return;
    }
    if (key === 'feedback') {
      wx.navigateTo({ url: '/pages/feedback/feedback' });
      return;
    }
    wx.showToast({ title: `「${key}」建设中`, icon: 'none' });
  },

  onOpenProfileEdit() {
    // 游客态：资料卡即登录按钮（本页唯一登录入口）。
    if (this.data.guest) {
      openLogin('/pages/profile/profile');
      return;
    }
    wx.navigateTo({ url: '/pages/profile-edit/profile-edit' });
  },

  onSyncTap() {
    if (this.data.syncing) return;

    const state = userStore.getState();
    const userId = state.user?.id;
    if (!userId || this.data.guest) {
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
});
