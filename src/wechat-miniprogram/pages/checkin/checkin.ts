// 每日签到页（devops#885，UI 权威 = devops#851 resolution + 原型 851-checkin-spike.html 变体 A）。
// 数据全部来自 #883 契约 GET .../check-ins/status（整页单读）；周历布局与
// 「本月已签 N 天」在客户端算（utils/checkinCalendar，纯函数有自检）。
import { userStore } from '../../store/index';
import { openLogin } from '../../utils/authGate';
import { createCheckIn, getCheckInStatus } from '../../services/checkin';
import type { CheckInStatus } from '../../services/checkin';
import { buildMonthBoard, cycleEarnedPoints, CYCLE_CUMULATIVE } from '../../utils/checkinCalendar';
import type { MonthCell } from '../../utils/checkinCalendar';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

// 断签（新一轮）hero 副文案 = 原型拍板文案；其余走默认文案。
const HERO_SUB_DEFAULT = '连续签到可以攒到更多积分哦～';
const HERO_SUB_NEW_ROUND = '今天签到即开启新一轮，连签 7 天可得 11 分';

// D7 彩蛋 pulse 播放时长（winPulse 0.9s × 2 轮 + 余量）后摘除 class，
// 避免展开/收起月历重建节点时反复重播（对齐原型 2s 摘 win-flash）。
const WIN_PULSE_MS = 2200;

interface CheckinPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1（冷开/登录 reLaunch 直达）显示回主页的小房子 */
  canBack: boolean;
  guest: boolean;
  loading: boolean;
  loadFailed: boolean;
  avatarUrl: string;
  streak: number;
  heroSub: string;
  canCheck: boolean;
  checking: boolean;
  ctaText: string;
  showResetBanner: boolean;
  /** D7 已签彩蛋横幅（常驻）。 */
  showWinBanner: boolean;
  /** 达成时刻的整排 pulse（2.2s 后摘除）。 */
  winPulse: boolean;
  balance: number;
  cycleEarned: number;
  monthCheckedCount: number;
  visibleRows: MonthCell[][];
  monthOpen: boolean;
  milestones: Array<{ cum: number; hit: boolean; label: string }>;
  /** 刚签到的浮动 +N（0 = 不展示）。 */
  justGained: number;
}

interface CheckinPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBack(): void;
  onToggleMonth(): void;
  onCheckIn(): void;
  onGuestLogin(): void;
  onRetry(): void;
  onDetailTap(): void;
  onMallTap(): void;
  load(silent?: boolean): Promise<void>;
  /** 浮动 +N 入场（1.4s 上飘淡出，1.6s 后复位）。 */
  floatOnce(points: number): void;
  /** D7 彩蛋 pulse 播完一轮即摘 class。 */
  armPulse(): void;
  _board?: ReturnType<typeof buildMonthBoard>;
  _initialGained?: number;
  /** 本次会话刚达成的 D7（CTA 响应 d7_completed 或一步签到带分进来），驱动一次 pulse。 */
  _justCompleted?: boolean;
  _floatTimer?: ReturnType<typeof setTimeout>;
  _pulseTimer?: ReturnType<typeof setTimeout>;
  _busy?: boolean;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

/** status.month.checked → YYYY-MM-DD → 得分快照映射（月历布局输入）。 */
function toCheckedMap(st: CheckInStatus): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of st.month.checked) {
    map[entry.date] = entry.points;
  }
  return map;
}

Page<CheckinPageData, CheckinPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    canBack: false,
    guest: false,
    loading: true,
    loadFailed: false,
    avatarUrl: '',
    streak: 0,
    heroSub: HERO_SUB_DEFAULT,
    canCheck: false,
    checking: false,
    ctaText: '',
    showResetBanner: false,
    showWinBanner: false,
    winPulse: false,
    balance: 0,
    cycleEarned: 0,
    monthCheckedCount: 0,
    visibleRows: [],
    monthOpen: false,
    milestones: CYCLE_CUMULATIVE.map((cum, i) => ({ cum, hit: false, label: `第${i + 1}天` })),
    justGained: 0,
  },

  onLoad(options: Record<string, string | undefined>) {
    const state = userStore.getState();
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      guest: !state.isAuthenticated,
      avatarUrl: state.user?.avatar_url || '',
    });
    // 一步签到成功 redirect 进页带上的刚得分（profile → POST 成功 → navigateTo）。
    this._initialGained = Number(options?.gained || 0) || 0;
  },

  onShow() {
    const guest = !userStore.getState().isAuthenticated;
    if (guest) {
      // 游客不发数据请求：结束 loading 直接呈现页面（登录引导遮罩盖在内容上）。
      this.setData({ guest, loading: false });
      return;
    }
    this.setData({ guest: false });
    void this.load();
  },

  onUnload() {
    for (const timer of [this._floatTimer, this._pulseTimer]) {
      if (timer) clearTimeout(timer);
    }
    this._floatTimer = undefined;
    this._pulseTimer = undefined;
  },

  async load(silent?: boolean) {
    if (!silent) {
      this.setData({ loading: true, loadFailed: false });
    }
    try {
      const st = await getCheckInStatus();
      const board = buildMonthBoard(st.today.date, toCheckedMap(st));
      this._board = board;

      const signedToday = !st.today.can_check_in;
      const cycle = st.cycle;
      const checkedCount = cycle.filter((cell) => cell.status === 'checked').length;
      const d7Signable = !signedToday && cycle.length === 7 && cycle[6].status === 'today';
      const d7Signed = signedToday && cycle.length === 7 && cycle[6].status === 'checked';
      const ctaText = signedToday
        ? '今日已签到'
        : `签到 +${st.today.reward_preview}${d7Signable ? ' · 集齐本轮' : ''}`;

      // 断签横幅严格对齐原型六态：只在 streak 归零（断签/首签）的今天亮；
      // 昨日集齐 D7 的「新周期第一天」不亮（hero 已表达连续 7 天）。
      const justCompleted = d7Signed && (this._justCompleted === true || (this._initialGained || 0) > 0);
      this._justCompleted = undefined;

      this.setData({
        loading: false,
        streak: st.streak_days,
        heroSub: st.streak_days === 0 ? HERO_SUB_NEW_ROUND : HERO_SUB_DEFAULT,
        canCheck: st.today.can_check_in,
        ctaText,
        showResetBanner: st.streak_days === 0,
        showWinBanner: d7Signed,
        winPulse: justCompleted,
        balance: st.balance,
        cycleEarned: cycleEarnedPoints(cycle),
        monthCheckedCount: board.checkedCount,
        visibleRows: this.data.monthOpen ? board.rows : [board.rows[board.weekIndex]],
        milestones: CYCLE_CUMULATIVE.map((cum, i) => ({
          cum,
          hit: i < checkedCount,
          label: `第${i + 1}天`,
        })),
      });

      if (justCompleted) {
        this.armPulse();
      }
      // 一步签到 redirect 进来：以刚签到态呈现浮动 +N（只放一次）。
      if (this._initialGained && this._initialGained > 0) {
        const gained = this._initialGained;
        this._initialGained = 0;
        this.floatOnce(gained);
      }
    } catch {
      if (silent) {
        // 静默刷新失败保留旧数据（如 CTA 已成功、余额/状态下次 onShow 再校准）。
        return;
      }
      this.setData({ loading: false, loadFailed: true });
    }
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onToggleMonth() {
    const board = this._board;
    if (!board) return;
    const monthOpen = !this.data.monthOpen;
    this.setData({
      monthOpen,
      visibleRows: monthOpen ? board.rows : [board.rows[board.weekIndex]],
    });
  },

  async onCheckIn() {
    if (this._busy || !this.data.canCheck) return;
    this._busy = true;
    this.setData({ checking: true });
    try {
      const res = await createCheckIn();
      if (res.points_earned > 0) {
        this.floatOnce(res.points_earned);
      }
      if (res.d7_completed) {
        this._justCompleted = true;
      }
      // 静默刷新整页状态（连签/本轮/月历/余额跟着走）。
      await this.load(true);
    } catch {
      wx.showToast({ title: '签到失败，请稍后再试', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ checking: false });
    }
  },

  onGuestLogin() {
    // 登录成功 reLaunch 回本页，续接签到流程。
    openLogin('/pages/checkin/checkin');
  },

  onRetry() {
    void this.load();
  },

  // 明细 / 商城：目标页未上线（T4 未合并），toast 占位。
  onDetailTap() {
    wx.showToast({ title: '积分明细建设中', icon: 'none' });
  },

  onMallTap() {
    wx.showToast({ title: '积分商城即将开放', icon: 'none' });
  },

  /** 浮动 +N 入场（原型 floatUp：1.4s 上飘淡出，之后复位）。 */
  floatOnce(points: number) {
    if (this._floatTimer) {
      clearTimeout(this._floatTimer);
    }
    this.setData({ justGained: points });
    this._floatTimer = setTimeout(() => {
      this._floatTimer = undefined;
      this.setData({ justGained: 0 });
    }, 1600);
  },

  /** D7 彩蛋 pulse 播完一轮即摘 class（月历重建节点不再重播）。 */
  armPulse() {
    if (this._pulseTimer) {
      clearTimeout(this._pulseTimer);
    }
    this._pulseTimer = setTimeout(() => {
      this._pulseTimer = undefined;
      this.setData({ winPulse: false });
    }, WIN_PULSE_MS);
  },
});
