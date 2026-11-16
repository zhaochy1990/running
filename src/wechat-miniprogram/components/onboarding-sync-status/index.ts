// 首次同步 session 状态卡（devops#1015 / epic devops#1004 T11；Web 对应物
// frontend/src/components/OnboardingSyncBanner.tsx）。
//
// 挂在「今日」与「记录」两个 tab 页顶部：绑表进首页（或换设备回来）后持续
// 展示服务端推导的分阶段进度。行为约束（继承 spec）：
//   - 只读观察：GET /users/me/onboarding/sync 轮询，绝不创建 session、不写
//     任何东西；worker 在服务端跑，杀进程 / 换设备 / 多端同时看都只是观察。
//   - 404（尚无 session）/ 403、503（开关关闭）→ 永久静默隐藏，老部署行为不变。
//   - 终态停止轮询：completed / superseded 整卡隐藏；failed / completed_with_gaps
//     保留展示（错误 + 重试 / 缺项说明），重试走 POST {retry:true}，只恢复未完成
//     工作并复用已成功凭据。
//   - 游客态（未登录）完全静默：认证 settle 后才起轮询，否则 GET 会 401 触发
//     登录跳转，把游客拽进登录页。
//   - 合法缺测（gaps，厂商真没有）与待抓取失败（error）分开渲染，不互相冒充。

import {
  getOnboardingSyncSession,
  isNoSession,
  isSessionEntryUnavailable,
  retryOnboardingSyncSession,
  type OnboardingSyncView,
} from '../../services/onboarding-sync';
import {
  SESSION_POLL_MS,
  isSessionTerminal,
  shouldHideStatusCard,
  toSyncStatusViewModel,
  type SyncStatusViewModel,
} from '../../utils/onboardingSession';
import { userStore } from '../../store/index';
import { logger } from '../../utils/logger';

/** 折叠偏好（跨启动记忆；与 Web 的 stride.onboarding-sync-banner.collapsed 同思路）。 */
const COLLAPSED_KEY = 'stride:onboarding-sync-status:collapsed';

interface OnboardingSyncStatusData {
  visible: boolean;
  vm: SyncStatusViewModel | null;
  expanded: boolean;
  retrying: boolean;
  retryError: string;
}

/** 实例字段（非渲染数据）：挂在 this 上避免模块级状态多实例（两个 tab 页各一份）串扰。 */
type OnboardingSyncStatusInstance = {
  /** 宿主页当前可见：hide 后迟到的异步回调一律作废。 */
  _pageShown: boolean;
  _detached: boolean;
  /** 用户点过「忽略」：本组件实例生命周期内不再出现（重进页面会重新评估）。 */
  _dismissed: boolean;
  _polling: boolean;
  _pollTimer: ReturnType<typeof setTimeout> | null;
  _inFlight: boolean;
};

type OnboardingSyncStatusMethods = {
  beginPollWhenAuthed(): Promise<void>;
  startPoll(): void;
  stopPoll(): void;
  scheduleTick(): void;
  tick(): Promise<void>;
  applyView(view: OnboardingSyncView): void;
  onRetry(): Promise<void>;
  onDismiss(): void;
  onToggle(): void;
  onGoActivities(): void;
};

Component<OnboardingSyncStatusData, {}, OnboardingSyncStatusMethods, [], OnboardingSyncStatusInstance>({
  data: {
    visible: false,
    vm: null,
    expanded: true,
    retrying: false,
    retryError: '',
  },

  lifetimes: {
    attached() {
      this._pageShown = false;
      this._detached = false;
      this._dismissed = false;
      this._polling = false;
      this._pollTimer = null;
      this._inFlight = false;
      this.setData({ expanded: wx.getStorageSync(COLLAPSED_KEY) !== '1' });
    },
    detached() {
      this._detached = true;
      this.stopPoll();
    },
  },

  // 页面显示才轮询、切走即停：后台 tab 不发无意义请求。
  pageLifetimes: {
    show() {
      this._pageShown = true;
      void this.beginPollWhenAuthed();
    },
    hide() {
      this._pageShown = false;
      this.stopPoll();
    },
  },

  methods: {
    async beginPollWhenAuthed() {
      await userStore.waitForAuth();
      if (this._detached || !this._pageShown) return;
      // 已忽略 / 未登录都不再发请求（忽略后轮询只剩浪费流量；游客发 GET 会 401
      // 触发登录跳转，必须完全静默）。
      if (this._dismissed) return;
      if (!userStore.getState().isAuthenticated) return;
      this.startPoll();
    },

    startPoll() {
      if (this._polling) return;
      this._polling = true;
      void this.tick();
    },

    stopPoll() {
      this._polling = false;
      if (this._pollTimer) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
    },

    scheduleTick() {
      if (!this._polling) return;
      this._pollTimer = setTimeout(() => {
        this._pollTimer = null;
        void this.tick();
      }, SESSION_POLL_MS);
    },

    async tick() {
      if (!this._polling || this._inFlight) return;
      this._inFlight = true;
      try {
        const view = await getOnboardingSyncSession();
        // 请求期间可能已被 stopPoll（切页 / 卸载）：结果丢弃，不再 setData。
        if (!this._polling) return;
        this.applyView(view);
        if (isSessionTerminal(view.state)) {
          // 终态后链路不再自行推进，轮询到此为止；重试成功会重启轮询。
          this.stopPoll();
          return;
        }
      } catch (err) {
        if (!this._polling) return;
        if (isNoSession(err) || isSessionEntryUnavailable(err)) {
          // 404 = 尚无 session（没走过新流程的老用户）；403/503 = 开关关闭。
          // 两种情况入口对该客户端都等于不存在：静默隐藏并停止轮询。
          this.setData({ visible: false, vm: null });
          this.stopPoll();
          return;
        }
        // 暂时性错误（网络 / 5xx）：保留上一次视图，下一轮继续。
        logger.warn('[onboarding-sync] 状态查询暂时失败，保留上次视图', err instanceof Error ? err.message : String(err));
      } finally {
        this._inFlight = false;
      }
      this.scheduleTick();
    },

    applyView(view: OnboardingSyncView) {
      const visible = !shouldHideStatusCard(view, this._dismissed);
      this.setData({ visible, vm: visible ? toSyncStatusViewModel(view) : null });
    },

    // 显式重试：POST {retry:true} 只重新派发未完成工作，已成功范围服务端复用
    // 凭据不重拉。成功后若未到终态则恢复轮询。
    async onRetry() {
      if (this.data.retrying) return;
      this.setData({ retrying: true, retryError: '' });
      try {
        const view = await retryOnboardingSyncSession();
        if (this._detached) return;
        this.applyView(view);
        if (!isSessionTerminal(view.state)) this.startPoll();
      } catch (err) {
        if (this._detached) return;
        logger.error('[onboarding-sync] 重试失败', err instanceof Error ? err.message : String(err));
        this.setData({ retryError: '重试失败，请稍后再试' });
      } finally {
        if (!this._detached) this.setData({ retrying: false });
      }
    },

    onDismiss() {
      // 忽略 = 本实例内隐藏并停止轮询（failed 终态本就不会再推进，留着轮询只费流量）。
      this._dismissed = true;
      this.stopPoll();
      this.setData({ visible: false, vm: null });
    },

    onToggle() {
      const expanded = !this.data.expanded;
      this.setData({ expanded });
      wx.setStorageSync(COLLAPSED_KEY, expanded ? '0' : '1');
    },

    onGoActivities() {
      wx.switchTab({ url: '/pages/activities/activities' });
    },
  },
});
