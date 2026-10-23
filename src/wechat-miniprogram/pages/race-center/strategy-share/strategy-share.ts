// 比赛策略只读分享落地页 —— #506。好友点开分享卡片（含未登录）直接看分享者
// 当前那一版策略：免登录拉公开端点 GET /api/race-strategies/shared/:user/:race/:version，
// 链接里的 UUID 三元组就是访问边界（链接即看，无 token / 过期 / 撤销）。
// 纯只读：无版本切换 / 编辑 / 教练操作，行数据构造复用 utils/raceStrategyRows，
// 样式整包 @import 报告页的 strategy.wxss。底部 CTA「生成我的比赛策略」：
// 已登录跳赛事详情（策略入口在详情页策略卡），未登录走现有登录流程。
// 参数缺失 / 版本已删 → 「该分享已失效」空态，不白屏。

import { ApiError } from '../../../services/request';
import { getSharedRaceStrategy } from '../../../services/race-strategy';
import { raceDayLabel, toStrategyView, type StrategyView } from '../../../utils/raceStrategyRows';
import { userStore } from '../../../store/index';

interface StrategySharePageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1（冷开分享卡直达）显示回主页的小房子 */
  canBack: boolean;
  loading: boolean;
  /** 非空时整页空态（链接失效 / 网络失败），文案已用户可读。 */
  error: string;
  view: StrategyView | null;
  raceDayText: string;
}

interface StrategySharePageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  refresh(userId: string, versionId: number): Promise<void>;
  onBack(): void;
  onGoCenter(): void;
  /** 底部 CTA：已登录跳该赛事详情（策略入口），未登录走现有登录流程。 */
  onGenerateTap(): void;
  _raceId: number;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<StrategySharePageData, StrategySharePageHandlers>({
  data: {
    statusBarHeight: 0,
    canBack: false,
    loading: true,
    error: '',
    view: null,
    raceDayText: '',
  },

  _raceId: 0,

  onLoad(options) {
    this.setData({ statusBarHeight: statusBarHeight(), canBack: getCurrentPages().length > 1 });
    const userId = String(options.user || '');
    const raceId = Number(options.id);
    const versionId = Number(options.version);
    if (!userId || !raceId || raceId <= 0 || !versionId || versionId <= 0) {
      this.setData({ loading: false, error: '该分享已失效' });
      return;
    }
    this._raceId = raceId;
    void this.refresh(userId, versionId);
  },

  async refresh(userId: string, versionId: number) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await getSharedRaceStrategy(userId, String(this._raceId), String(versionId));
      // 服务端对损坏 content 回空对象：缺 pace_segments 就当失效，别让
      // toStrategyView 白屏。
      if (!Array.isArray(res.strategy?.content?.pace_segments)) {
        this.setData({ loading: false, error: '该分享已失效' });
        return;
      }
      const view = toStrategyView(res.strategy.content);
      // 赛事名以 race_calendar 行为准：content 里的 race_name 是生成时的副本，
      // 赛事改名后会过期。
      view.raceName = res.race.name;
      this.setData({
        loading: false,
        error: '',
        view,
        raceDayText: raceDayLabel(res.race.race_date),
      });
    } catch (err: unknown) {
      // 400/404（链接坏/已删）与网络/5xx 分开文案；都能从空态进赛事中心。
      const status = err instanceof ApiError ? err.statusCode : 0;
      this.setData({
        loading: false,
        error: status >= 500 || status === 0 ? '加载失败，请稍后重试' : '该分享已失效',
      });
    }
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onGoCenter() {
    wx.switchTab({ url: '/pages/race-center/race-center' });
  },

  onGenerateTap() {
    if (userStore.getState().user) {
      wx.navigateTo({ url: `/pages/race-center/detail?id=${this._raceId}` });
      return;
    }
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
