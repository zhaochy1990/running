// 现场工作人员核销页 —— devops#869（Epic #862 P6）。
// 隐藏页（无入口、仅路径可达）：扫「工作码」小程序码直达（page=
// pages/lottery-verify/lottery-verify，scene `a=<活动ID>`，#678 落地页同款解析）。
// 流程：登录门槛（核销端点用户级 JWT）→ 输 3 位中奖编号 → lookup 中奖详情卡
// （奖品名/图/中奖时间/状态）→ 核对用户手机中奖页与实物后「确认核销」（二步确认，
// redeem 落核销人 openid+时间）→ 完成态；已核销编号再查只展示已核销+时间、无核销
// 按钮。白名单未命中（403 not_staff，后端回显请求者自己的 openid）：展示+复制
// 引导后台添加，加白后重新查询即可。免登录冷开由 app.ts PUBLIC_ENTRY_PAGES
// 白名单放行（不拽 onboarding；JWT 由静默登录或登录页 redirect 回跳补齐）。
import { ApiError } from '../../services/request';
import {
  lookupLotteryWinning,
  redeemLotteryWinning,
  type LotteryVerifyEntry,
} from '../../services/lottery';
import { userStore } from '../../store/index';
import { fmtShanghaiMdHm } from '../../utils/format';
import { parseLotteryEntry } from '../../utils/lotteryScene';
import { openLogin } from '../../utils/authGate';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

/** 中奖编号固定 3 位数字（000-999，与后端 WINNING_CODE_RE 同口径）。 */
const CODE_RE = /^\d{3}$/;

type PageState = 'loading' | 'gate' | 'ready' | 'notfound';
/** 详情卡：none=无（输入态）drawn=待核销（有核销按钮）verified=已核销（只读）。 */
type EntryState = 'none' | 'drawn' | 'verified';

interface VerifyPageData {
  statusBarHeight: number;
  pageState: PageState;
  /** 3 位编号输入（原样输入不补零：编号即用户手机中奖页展示的 3 位串）。 */
  codeInput: string;
  canLookup: boolean;
  looking: boolean;
  redeeming: boolean;
  /** 输入区下方错误提示（编号不存在 / 限速 / 服务不可用等）。 */
  errorHint: string;
  entryState: EntryState;
  entryCode: string;
  prizeName: string;
  prizeImage: string;
  wonTimeText: string;
  verifiedTimeText: string;
  /** 白名单未命中引导卡。 */
  staffBlocked: boolean;
  blockedOpenid: string;
}

interface VerifyPageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  onShow(): void;
  onBack(): void;
  onLoginTap(): void;
  onCodeInput(event: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  onLookupTap(): void;
  onRedeemTap(): void;
  onCopyOpenidTap(): void;
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  settleGate(): Promise<void>;
  doLookup(): Promise<void>;
  doRedeem(): Promise<void>;
  /** lookup / redeem 共用的详情卡渲染。 */
  applyEntry(entry: LotteryVerifyEntry): void;
  /** 请求失败 → 页面态分流（not_staff 引导卡 / 活动 404 / 行内提示）。 */
  applyError(err: unknown): void;
  /** 本页完整路径（a 直参），登录 redirect 回跳目标。 */
  redirectPath(): string;
  /** 活动 ID（onLoad 解析）。 */
  _a: string;
  /** onLoad 时刻认证态快照：onShow 发现变化（登录页返回）时重判门槛。 */
  _authedSeen: boolean;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<VerifyPageData, VerifyPageHandlers>({
  data: {
    statusBarHeight: 0,
    pageState: 'loading',
    codeInput: '',
    canLookup: false,
    looking: false,
    redeeming: false,
    errorHint: '',
    entryState: 'none',
    entryCode: '',
    prizeName: '',
    prizeImage: '',
    wonTimeText: '',
    verifiedTimeText: '',
    staffBlocked: false,
    blockedOpenid: '',
  },

  _a: '',
  _authedSeen: false,

  onLoad(options) {
    this.setData({ statusBarHeight: statusBarHeight() });
    const entry = parseLotteryEntry(options);
    if (!entry) {
      // 工作码必须带活动 ID（scene a=<活动ID>）；缺参即无效码。
      this.setData({ pageState: 'notfound' });
      return;
    }
    this._a = entry.a;
    this._authedSeen = userStore.getState().isAuthenticated;
    void this.settleGate();
  },

  // 登录页 navigateTo 返回或后台静默登录完成后，认证态可能变化 → 重判门槛。
  onShow() {
    if (this._a && userStore.getState().isAuthenticated !== this._authedSeen) {
      void this.settleGate();
    }
  },

  // 顶栏 home：有上级返回上级；栈深 1（冷开扫码）navigateBack 必失败 → 回主页。
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/coach/coach' }),
    });
  },

  // 登录门槛：核销端点是用户级 JWT 鉴权，游客态进页引导登录（带 redirect 回跳）。
  async settleGate() {
    await userStore.waitForAuth();
    const authed = userStore.getState().isAuthenticated;
    this._authedSeen = authed;
    this.setData({ pageState: authed ? 'ready' : 'gate' });
  },

  onLoginTap() {
    openLogin(this.redirectPath());
  },

  redirectPath() {
    return `/pages/lottery-verify/lottery-verify?a=${this._a}`;
  },

  // 只留数字、最多 3 位（数字键盘下的粘贴 / 自动填充防御）。
  onCodeInput(event) {
    const raw = String(event.detail.value ?? '').replace(/\D/g, '').slice(0, 3);
    this.setData({ codeInput: raw, canLookup: CODE_RE.test(raw) });
  },

  onLookupTap() {
    if (!CODE_RE.test(this.data.codeInput) || this.data.looking || this.data.redeeming) return;
    void this.doLookup();
  },

  async doLookup() {
    this.setData({ looking: true, errorHint: '', staffBlocked: false, entryState: 'none' });
    try {
      this.applyEntry(await lookupLotteryWinning(this._a, this.data.codeInput));
    } catch (err) {
      this.applyError(err);
    } finally {
      this.setData({ looking: false });
    }
  },

  // 二步确认的第二步：详情卡已核对（对照用户手机中奖页与实物）才可点。
  onRedeemTap() {
    if (this.data.entryState !== 'drawn' || this.data.looking || this.data.redeeming) return;
    void this.doRedeem();
  },

  async doRedeem() {
    this.setData({ redeeming: true });
    try {
      const entry = await redeemLotteryWinning(this._a, this.data.entryCode);
      this.applyEntry(entry);
      // 并发核销（另一台设备先核了）：后端幂等返回已核销态，toast 区分两种结局。
      wx.showToast({
        title: entry.already_verified ? '该编号已被核销' : '核销成功',
        icon: entry.already_verified ? 'none' : 'success',
      });
      // 清输入：完成态后直接输下一个编号，连续核销不停手。
      this.setData({ codeInput: '', canLookup: false });
    } catch (err) {
      this.applyError(err);
    } finally {
      this.setData({ redeeming: false });
    }
  },

  applyEntry(entry) {
    const verified = entry.status === 'verified' || entry.verified_at !== null;
    this.setData({
      entryState: verified ? 'verified' : 'drawn',
      entryCode: entry.code,
      prizeName: entry.prize?.name || '',
      prizeImage: entry.prize?.image_url || '',
      wonTimeText: fmtShanghaiMdHm(entry.won_at),
      verifiedTimeText: entry.verified_at ? fmtShanghaiMdHm(entry.verified_at) : '',
      errorHint: '',
    });
  },

  applyError(err) {
    if (err instanceof ApiError) {
      // 白名单未命中：后端回显请求者自己的 openid，引导卡展示+复制给后台添加；
      // 加白后无需重进页面，重新查询即可（每次请求都重过白名单）。
      if (err.statusCode === 403 && err.code === 'not_staff') {
        const openid = err.body.openid;
        this.setData({
          staffBlocked: true,
          blockedOpenid: typeof openid === 'string' ? openid : '',
          entryState: 'none',
        });
        return;
      }
      // 编号不存在 / 未中奖编号：中奖编号只存在于中奖记录，查无即此语义。
      if (err.statusCode === 404 && err.code === 'code_not_found') {
        this.setData({ entryState: 'none', errorHint: '未查到该编号，请核对后重输（未中奖用户没有编号）' });
        return;
      }
      // 活动 404（not_found）：工作码指向的活动不存在或已停用，整页空态。
      if (err.statusCode === 404) {
        this.setData({ pageState: 'notfound', entryState: 'none' });
        return;
      }
      if (err.statusCode === 429) {
        this.setData({ entryState: 'none', errorHint: '操作过于频繁，请稍后再试' });
        return;
      }
      // openid 解析未配置 / 上游失败（#866 门控）：非现场可自愈的问题，直说找管理员。
      if (err.statusCode === 503) {
        this.setData({ entryState: 'none', errorHint: '核销服务暂不可用，请联系管理员' });
        return;
      }
      this.setData({ entryState: 'none', errorHint: err.detail || '操作失败，请重试' });
      return;
    }
    this.setData({ entryState: 'none', errorHint: '网络开小差了，请重试' });
  },

  onCopyOpenidTap() {
    if (!this.data.blockedOpenid) return;
    wx.setClipboardData({ data: this.data.blockedOpenid });
  },

  // 隐藏工作页：不做定制分享（默认品牌卡，绝不把核销入口传播出去）。
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
});
