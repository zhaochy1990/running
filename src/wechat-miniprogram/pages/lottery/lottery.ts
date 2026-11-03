// 抽奖活动落地页 + 结果页 —— devops#868（Epic #862 P5）。
// 扫易拉宝小程序码直达（page=pages/lottery/lottery，scene `a=<活动ID>&s=<点位号>`）：
// 免登录可看奖档 / 剩余库存 / 规则文案 / 时间窗状态（P1 公开端点，auth:false）；
// 点「立即抽奖」三态引导——未登录 openLogin(redirect=本页完整路径，登录页 #702
// 回跳分支直达，新用户跳过 onboarding)；已登录未绑表（GET /api/users/me/watch
// logged_in 判定）去 watch 页绑表带 redirect 回跳（P4 #864）；已绑表 POST draw
// （服务端硬校验为准，客户端缓存态只做引导分流）。中奖 3 位编号大字页 /
// 谢谢参与页；已参与者进页预取 my-result 直接渲染结果态，按钮变「查看我的
// 中奖编号」。免登录冷开由 app.ts PUBLIC_ENTRY_PAGES 白名单放行（coach-share 先例）。
import { ApiError } from '../../services/request';
import {
  drawLottery,
  getLotteryActivity,
  getLotteryMyResult,
  reportLotteryEvent,
  type LotteryEventStage,
  type LotteryPrizeView,
  type LotteryStatus,
} from '../../services/lottery';
import { getWatchInfo } from '../../services/watch';
import { userStore } from '../../store/index';
import { fmtShanghaiMdHm } from '../../utils/format';
import { lotteryPhaseMeta, parseLotteryEntry } from '../../utils/lotteryScene';
import { openLogin } from '../../utils/authGate';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

/** 抽奖动效最短展示窗口：API 太快回来也要让「抽奖中」转一圈再揭晓。 */
const DRAW_MIN_ANIMATION_MS = 900;

type LoadState = 'loading' | 'ready' | 'notfound' | 'error';
type PageMode = 'landing' | 'result';
/** 三态引导的客户端缓存态（服务端 draw 硬校验为准，unknown 时点按钮直接试 draw）。 */
type GateState = 'unknown' | 'need_login' | 'need_watch' | 'ready';

/** 奖档展示行（兜底档不出现在陈列里）。 */
interface PrizeRow {
  key: string;
  name: string;
  imageUrl: string;
  /** 「剩余 N 份」/「已抽完」；null（不会出现，兜底已滤掉）防御空串。 */
  remainingText: string;
  out: boolean;
}

interface LotteryPageData {
  statusBarHeight: number;
  loadState: LoadState;
  /** landing=活动陈列；result=中奖编号 / 谢谢参与。 */
  pageMode: PageMode;
  name: string;
  heroImage: string;
  rulesText: string;
  status: LotteryStatus;
  phaseLabel: string;
  phaseHint: string;
  prizes: PrizeRow[];
  /** 主 CTA 文案与可点性（participated → 「查看我的中奖编号」）。 */
  ctaLabel: string;
  ctaDisabled: boolean;
  /** CTA 上方引导提示（未登录 / 未绑表时的门槛说明，ready 或已参与时为空）。 */
  gateHint: string;
  drawing: boolean;
  /** 结果态（resultWon 区分中奖页 / 谢谢参与页）。 */
  resultWon: boolean;
  resultCode: string;
  resultPrizeName: string;
  resultPrizeImage: string;
  resultTimeText: string;
  resultVerified: boolean;
}

interface LotteryPageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  onShow(): void;
  onBack(): void;
  onRetryTap(): void;
  /** 抽奖遮罩 catchtouchmove 占位（阻断穿透滚动，无行为）。 */
  noop(): void;
  onCtaTap(): void;
  onBackToLandingTap(): void;
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  load(): Promise<void>;
  /** 认证 settle 后预取参与结果 + 绑表状态（决定三态引导与结果态）。 */
  prefetch(): Promise<void>;
  doDraw(): Promise<void>;
  /** draw / my-result 共用的结果态渲染。 */
  applyResult(result: {
    prize?: LotteryPrizeView | null;
    code?: string | null;
    status?: string;
    verified_at?: string | null;
    created_at?: string;
  }): void;
  refreshCta(): void;
  /** 本页完整路径（a + s），作为登录 / 绑表 redirect 回跳目标。 */
  redirectPath(): string;
  /** 入口参数（onLoad 解析；retry 复用） */
  _a: string;
  _s: string;
  /** #867 漏斗埋点：fire-and-forget 上报（失败静默）。 */
  _report(stage: LotteryEventStage): void;
  /** #867 漏斗阶段标记的 storage key（跨 reLaunch 实例传递）。 */
  _stageMarkKey(stage: 'login' | 'bind'): string;
  /** onLoad 时刻快照的认证态：onShow 发现变化（登录页返回 / silentLogin 完成）时重跑预取。 */
  _authedSeen: boolean;
  _gate: GateState;
  _participated: boolean;
  _status: LotteryStatus;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<LotteryPageData, LotteryPageHandlers>({
  data: {
    statusBarHeight: 0,
    loadState: 'loading',
    pageMode: 'landing',
    name: '',
    heroImage: '',
    rulesText: '',
    status: 'active',
    phaseLabel: '',
    phaseHint: '',
    prizes: [],
    ctaLabel: '立即抽奖',
    ctaDisabled: true,
    gateHint: '',
    drawing: false,
    resultWon: false,
    resultCode: '',
    resultPrizeName: '',
    resultPrizeImage: '',
    resultTimeText: '',
    resultVerified: false,
  },

  _a: '',
  _s: '',
  _authedSeen: false,
  _gate: 'unknown',
  _participated: false,
  _status: 'active',

  // #867 漏斗「登录/绑表」计数：watch 页绑定成功是 reLaunch 回来（全新实例），
  // 内存态存不住「上一个阶段」，用 storage 标记跨实例传递；上报后即清。
  _report(stage) {
    if (!this._a) return;
    reportLotteryEvent(this._a, stage, this._s || undefined);
  },

  onLoad(options) {
    const entry = parseLotteryEntry(options);
    this.setData({ statusBarHeight: statusBarHeight() });
    if (!entry) {
      this.setData({ loadState: 'notfound' });
      return;
    }
    this._a = entry.a;
    this._s = entry.s;
    this._authedSeen = userStore.getState().isAuthenticated;
    // #867 漏斗「进入」计数：每次有效进页计一次（直链 _s 为空 → 服务端记直链行）。
    this._report('enter');
    void this.load();
    void this.prefetch();
  },

  // 登录页 navigateTo 返回（未登录成功）或后台 silentLogin 完成后，认证态可能与
  // 进页时不同 → 重跑预取；watch 页绑定成功走 reLaunch 回来是全新实例，不走这里。
  onShow() {
    if (this._a && userStore.getState().isAuthenticated !== this._authedSeen) {
      void this.prefetch();
    }
  },

  // 顶栏 home：有上级返回上级；栈深 1（冷开扫码）navigateBack 必失败 → 回主页。
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/coach/coach' }),
    });
  },

  onRetryTap() {
    void this.load();
    void this.prefetch();
  },

  /** 抽奖遮罩 catchtouchmove 占位（阻断穿透滚动，无行为）。 */
  noop() {},

  async load() {
    this.setData({ loadState: 'loading' });
    try {
      const res = await getLotteryActivity(this._a);
      const meta = lotteryPhaseMeta(res.status, res.start_at, res.end_at);
      this._status = res.status;
      this.setData({
        loadState: 'ready',
        name: res.name,
        heroImage: res.hero_image || '',
        rulesText: res.rules_text || '',
        status: res.status,
        phaseLabel: meta.label,
        phaseHint: meta.hint,
        // 兜底档是「谢谢参与」落点，不是可陈列的实物奖档（无图无库存）。
        prizes: res.prizes
          .filter((prize) => !prize.is_fallback)
          .map((prize, index) => ({
            key: String(index),
            name: prize.name,
            imageUrl: prize.image_url || '',
            remainingText: prize.remaining === null ? '' : prize.remaining > 0 ? `剩余 ${prize.remaining} 份` : '已抽完',
            out: prize.remaining !== null && prize.remaining <= 0,
          })),
      });
      this.refreshCta();
    } catch (err) {
      // 404 = 不存在或未启用（与后端同口径）；其余（网络 / 5xx / 429）可重试。
      const status = err instanceof ApiError ? err.statusCode : 0;
      this.setData({ loadState: status === 404 ? 'notfound' : 'error' });
    }
  },

  // #867 漏斗阶段标记（跨 reLaunch 实例）：到达某阶段时落标记，完成后上报并清。
  _stageMarkKey(stage: 'login' | 'bind'): string {
    return `lottery:funnel:${stage}:${this._a}`;
  },

  async prefetch() {
    await userStore.waitForAuth();
    const authed = userStore.getState().isAuthenticated;
    this._authedSeen = authed;
    if (!authed) {
      this._gate = 'need_login';
      // 登录漏斗：先落「待登录」标记；登录回跳后（本实例或新实例）prefetch 发现
      // 已登录 → 计一次 login 并清标记。
      try {
        wx.setStorageSync(this._stageMarkKey('login'), 1);
      } catch {
        // storage 异常不拦流程。
      }
      this.setData({ gateHint: '登录并绑定运动手表即可参与' });
      this.refreshCta();
      return;
    }
    // 登录完成（含登录页回跳 / 新实例）：pending 标记在 → 计一次 login。
    try {
      const loginKey = this._stageMarkKey('login');
      if (wx.getStorageSync(loginKey)) {
        wx.removeStorageSync(loginKey);
        this._report('login');
      }
    } catch {
      // storage 异常不拦流程（漏斗少一条计数而已）。
    }
    try {
      // my-result 是参与判定源；watch 状态只影响引导文案，失败不阻塞（unknown 走 draw 兜底）。
      const [mine, watch] = await Promise.all([
        getLotteryMyResult(this._a),
        getWatchInfo().catch(() => null),
      ]);
      this._gate = watch ? (watch.logged_in ? 'ready' : 'need_watch') : 'unknown';
      // 绑表漏斗：到达 need_watch 落标记；标记在而 gate 已 ready（watch 页 reLaunch
      // 回来的新实例）→ 计一次 bind 并清标记。
      try {
        const bindKey = this._stageMarkKey('bind');
        if (this._gate === 'need_watch' && !mine.participated) {
          wx.setStorageSync(bindKey, 1);
        } else if (this._gate === 'ready' && wx.getStorageSync(bindKey)) {
          wx.removeStorageSync(bindKey);
          this._report('bind');
        }
      } catch {
        // storage 异常不拦流程。
      }
      if (mine.participated) {
        this.applyResult(mine);
        return;
      }
      this.setData({
        gateHint: this._gate === 'need_watch' ? '绑定运动手表即可参与' : '',
      });
      this.refreshCta();
    } catch {
      // my-result 网络失败：不拦页面（陈列照看），CTA 点按时服务端硬校验裁决。
      this._gate = 'unknown';
      this.setData({ gateHint: '' });
      this.refreshCta();
    }
  },

  onCtaTap() {
    if (this.data.loadState !== 'ready' || this.data.ctaDisabled || this.data.drawing) return;
    // 已参与：按钮是「查看我的中奖编号」，直接展示结果态。
    if (this._participated) {
      this.setData({ pageMode: 'result' });
      return;
    }
    const authed = userStore.getState().isAuthenticated;
    // 三态引导 1：未登录 → 登录页带 redirect（成功回跳本页；新用户跳过 onboarding）。
    if (!authed) {
      openLogin(this.redirectPath());
      return;
    }
    // 三态引导 2：已登录未绑表 → watch 页绑表，成功带 redirect 回跳（#864）。
    if (this._gate === 'need_watch') {
      wx.navigateTo({
        url: `/pages/watch/watch?redirect=${encodeURIComponent(this.redirectPath())}`,
      });
      return;
    }
    // 三态引导 3（含 unknown）：已绑表 → 抽奖。服务端硬校验为准：watch_not_bound
    // 403 时下一轮点按会被引导去绑表（doDraw 内即时导航）。
    void this.doDraw();
  },

  async doDraw() {
    this.setData({ drawing: true });
    try {
      const [result] = await Promise.all([
        drawLottery(this._a, this._s || undefined),
        new Promise((resolve) => setTimeout(resolve, DRAW_MIN_ANIMATION_MS)),
      ]);
      this.applyResult(result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 403 && err.code === 'watch_not_bound') {
          // 客户端缓存态过期（预取失败 / 刚解绑）：即时引导去绑表。
          this._gate = 'need_watch';
          this.setData({ gateHint: '绑定运动手表即可参与' });
          wx.navigateTo({
            url: `/pages/watch/watch?redirect=${encodeURIComponent(this.redirectPath())}`,
          });
        } else if (err.statusCode === 403 && err.code === 'activity_not_active') {
          // 时间窗已切换：重拉公开数据刷新状态章。
          wx.showToast({ title: '活动未开始或已结束', icon: 'none' });
          void this.load();
        } else if (err.statusCode === 409) {
          // 同一手表账号已在另一账号抽过（防刷唯一约束），本账号无法参与。
          wx.showModal({
            title: '无法参与',
            content: '该手表账号已参与过本活动，每个手表账号仅可参与一次',
            showCancel: false,
          });
        } else if (err.statusCode === 404) {
          this.setData({ loadState: 'notfound', pageMode: 'landing' });
        } else {
          wx.showToast({ title: err.detail || '抽奖失败，请重试', icon: 'none' });
        }
      } else {
        wx.showToast({ title: '网络开小差了，请重试', icon: 'none' });
      }
    } finally {
      this.setData({ drawing: false });
      this.refreshCta();
    }
  },

  applyResult(result) {
    // 兜底档（谢谢参与）无编号；编号非空即中奖。
    const code = typeof result.code === 'string' ? result.code : '';
    const won = code.length > 0;
    this._participated = true;
    this.setData({
      pageMode: 'result',
      resultWon: won,
      resultCode: code,
      resultPrizeName: result.prize?.name || '',
      resultPrizeImage: result.prize?.image_url || '',
      resultTimeText: fmtShanghaiMdHm(result.created_at || null),
      resultVerified: result.status === 'verified' || !!result.verified_at,
      gateHint: '',
    });
    this.refreshCta();
  },

  refreshCta() {
    if (this._participated) {
      this.setData({ ctaLabel: '查看我的中奖编号', ctaDisabled: false });
      return;
    }
    if (this._status !== 'active') {
      this.setData({
        ctaLabel: this._status === 'not_started' ? '活动未开始' : '活动已结束',
        ctaDisabled: true,
      });
      return;
    }
    this.setData({ ctaLabel: '立即抽奖', ctaDisabled: false });
  },

  redirectPath() {
    const s = this._s ? `&s=${encodeURIComponent(this._s)}` : '';
    return `/pages/lottery/lottery?a=${this._a}${s}`;
  },

  onBackToLandingTap() {
    this.setData({ pageMode: 'landing' });
  },

  // 现场传播：分享即本活动落地页（带 a 直参，接收者免登录可看陈列）；
  // 未就绪回落品牌分享。
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    if (this.data.loadState !== 'ready' || !this._a) {
      return defaultShareAppMessage();
    }
    return { title: this.data.name, path: this.redirectPath() };
  },

  onShareTimeline: defaultShareTimeline,
});
