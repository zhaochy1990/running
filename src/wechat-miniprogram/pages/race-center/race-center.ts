// 赛事中心页 —— 全年路跑赛事密表（#392，#384 定稿的 C 紧凑清单版式）。
//
// 数据走 services/race-center（GET /api/race-calendar #390，收藏 toggle #391）。
// 不做跨页面数据缓存（人工验收教训：列表/详情各自持 favorited 副本必然漂移）：
// 每次进入页面都重拉当前 年份×省份 的整年数据（scope=all 一页 100 场 + 翻页
// 兜底，生产单年约 40 场）；已有数据时静默后台刷新、旧列表先行，不闪屏。
// 「即将开跑」（race_date >= 今天）与 项目类型 / 收藏视图在客户端切换，即点
// 即生效；省份走服务端过滤（province= 省名原文，静态 34 省列表见
// constants/provinces，不随后端数据渲染）。
// 纯视图变换（徽章/缩写/分组/筛选）在 utils/raceCenterRows，配套自检。

import {
  getRaceCalendar,
  toggleRaceFavorite,
  type RaceCalendarRace,
} from '../../services/race-center';
import { filterRaces, groupByMonth } from '../../utils/raceCenterRows';
import { PROVINCES } from '../../constants/provinces';
import { shanghaiToday } from '../../utils/date';
import { userStore } from '../../store/index';

/** 筛选栏的项目类型选项：''=全部。token 词汇见 internal/racetypes。 */
const TYPE_OPTIONS: Array<{ label: string; token: string }> = [
  { label: '全部', token: '' },
  { label: '全马', token: 'Marathon' },
  { label: '半马', token: 'HalfMarathon' },
  { label: '10K', token: '10Km' },
];

const PER_PAGE = 100;
/** 翻页兜底：50 页 × 100 = 5000 场，远超单年现实规模，防 total 异常时死循环。 */
const MAX_PAGES = 50;

interface RaceCenterPageData {
  statusBarHeight: number;
  loading: boolean;
  error: string;
  years: string[];
  yearIndex: number;
  typeLabels: string[];
  typeIndex: number;
  /** 省份下拉选项：['全部', ...34 省级行政区]（静态，constants/provinces） */
  provinceNames: string[];
  provinceIndex: number;
  favOnly: boolean;
  groups: ReturnType<typeof groupByMonth>;
  viewCount: number;
  /** 非空时渲染空态文案（区分收藏空 / 筛选空 / 年份无数据） */
  emptyText: string;
}

interface RaceCenterPageHandlers {
  onLoad(): void;
  onShow(): void;
  onPullDownRefresh(): void;
  onYearChange(e: WechatMiniprogram.PickerChange): void;
  onTypeChange(e: WechatMiniprogram.PickerChange): void;
  onProvinceChange(e: WechatMiniprogram.PickerChange): void;
  onFavToggleTap(): void;
  onStarTap(e: WechatMiniprogram.TouchEvent): void;
  onRaceTap(e: WechatMiniprogram.TouchEvent): void;
  onPlansTap(): void;
  onBack(): void;
  refresh(): Promise<void>;
  applyView(): void;
  /** 当前视图（年份×省份）已拉到的整年数据；实例级，页面关掉即弃。
   *  不跨页面缓存：每次进入页面重拉服务端真值（收藏星标跨页同步的前提）。 */
  _rows: RaceCalendarRace[];
  /** _rows 归属的 年份|省份 键：判断「重进重拉」还是「同键静默刷新」 */
  _rowsKey: string;
  /** 在途请求的键：onLoad+onShow 同帧双触发时只发一次 */
  _fetchingKey: string;
  /** 进行中的星标请求，防连点抖动 */
  _pendingStars: Set<number>;
  /** 请求序号，慢响应回来时发现自己已过期则丢弃 */
  _fetchSeq: number;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

/** 年份选项：当前上海年份 ±1。 */
function yearOptions(): string[] {
  const y = parseInt(shanghaiToday().slice(0, 4), 10);
  return [String(y - 1), String(y), String(y + 1)];
}

/** 整年拉全（可选省份服务端过滤）：一页 100 场，不足 total 则续页。 */
async function fetchYear(year: string, province: string): Promise<RaceCalendarRace[]> {
  const out: RaceCalendarRace[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await getRaceCalendar({
      year,
      scope: 'all',
      province: province || undefined,
      page,
      perPage: PER_PAGE,
    });
    out.push(...res.races);
    if (res.races.length === 0 || out.length >= res.total) break;
  }
  return out;
}

Page<RaceCenterPageData, RaceCenterPageHandlers>({
  data: {
    statusBarHeight: 0,
    loading: true,
    error: '',
    years: [],
    yearIndex: 1,
    typeLabels: TYPE_OPTIONS.map((o) => o.label),
    typeIndex: 0,
    provinceNames: ['全部', ...PROVINCES],
    provinceIndex: 0,
    favOnly: false,
    groups: [],
    viewCount: 0,
    emptyText: '',
  },

  // 实例级私有状态（随页面销毁丢弃）
  _rows: [],
  _rowsKey: '',
  _fetchingKey: '',
  _pendingStars: new Set<number>(),
  _fetchSeq: 0,

  onLoad() {
    const years = yearOptions();
    const thisYear = shanghaiToday().slice(0, 4);
    this.setData({
      statusBarHeight: statusBarHeight(),
      years,
      yearIndex: Math.max(years.indexOf(thisYear), 0),
    });
    void this.refresh();
  },

  // 每次进入（含从详情返回、登录回来自愈、小程序前台切回）都重拉服务端真值
  onShow() {
    void this.refresh();
  },

  onPullDownRefresh() {
    void this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /** 拉取（或静默重拉）当前 年份×省份 的整年数据并渲染。每次调用都发请求：
   *  同键在途时只发一次（onLoad+onShow 同帧双触发），已有数据时旧列表先行。 */
  async refresh() {
    if (!userStore.getState().user) {
      this.setData({ loading: false, error: '请先登录后查看赛事日历' });
      return;
    }
    const year = this.data.years[this.data.yearIndex] || shanghaiToday().slice(0, 4);
    const province = this.data.provinceIndex > 0 ? this.data.provinceNames[this.data.provinceIndex] || '' : '';
    const key = `${year}|${province || 'all'}`;
    if (this._fetchingKey === key) return; // 同一份数据已在拉取
    this._fetchingKey = key;
    const seq = (this._fetchSeq += 1);

    // 已有同键数据：静默后台刷新（旧列表先行，不转圈）；首拉才展示 loading
    const silent = this._rowsKey === key && this._rows.length > 0;
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const rows = await fetchYear(year, province);
      // 已被更新的请求取代：本响应作废
      if (seq !== this._fetchSeq) return;
      this._fetchingKey = '';
      this._rows = rows;
      this._rowsKey = key;
      this.setData({ loading: false });
      this.applyView();
    } catch (err: unknown) {
      if (seq !== this._fetchSeq) return;
      this._fetchingKey = '';
      const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
      // 首拉失败（没有旧列表可显示）：清空视图只留错误条；
      // 静默刷新失败：保留旧列表，banner 说明即可
      const patch: Partial<RaceCenterPageData> = { loading: false, error: msg };
      if (!silent) Object.assign(patch, { groups: [], viewCount: 0, emptyText: '' });
      this.setData(patch);
    }
  },

  /** 用当前筛选条件重算 分组/计数/空态。数据在 _rows，纯同步。 */
  applyView() {
    const year = this.data.years[this.data.yearIndex] || '';
    const province = this.data.provinceIndex > 0 ? this.data.provinceNames[this.data.provinceIndex] || '' : '';
    const rows = this._rows;

    // 默认视图只看即将开跑；收藏视图与往年看整年（往年的 upcoming 恒空）
    const floor =
      !this.data.favOnly && year >= shanghaiToday().slice(0, 4) ? shanghaiToday() : '';
    const inScope = floor ? rows.filter((r) => r.race_date >= floor) : rows;
    const filtered = filterRaces(inScope, {
      type: TYPE_OPTIONS[this.data.typeIndex].token,
      favoritesOnly: this.data.favOnly,
    });
    const groups = groupByMonth(filtered);

    let emptyText = '';
    if (groups.length === 0) {
      if (rows.length === 0) {
        emptyText = province
          ? `${province}暂无已发布赛事 · 换个省份或下拉刷新`
          : `${year} 年暂无已发布赛事 · 下拉刷新`;
      } else if (this.data.favOnly && this.data.typeIndex === 0 && !province) {
        emptyText = '还没有收藏的赛事 · 退出收藏筛选后点 ☆ 收藏';
      } else {
        emptyText = '当前筛选下没有赛事 · 换个条件试试';
      }
    }

    this.setData({ groups, viewCount: filtered.length, emptyText });
  },

  onYearChange(e: WechatMiniprogram.PickerChange) {
    // mode=selector 的 value 是数组下标；类型联合是共享 PickerChange 定义所致
    const yearIndex = Number(e.detail.value);
    if (yearIndex === this.data.yearIndex) return;
    // 省份是静态列表，与年份无关，选中态跨年保留
    this.setData({ yearIndex });
    void this.refresh();
  },

  onTypeChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ typeIndex: Number(e.detail.value) });
    this.applyView();
  },

  /** 省份切换：服务端过滤，按 年份×省份 取数（未缓存则发请求）。 */
  onProvinceChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ provinceIndex: Number(e.detail.value) });
    void this.refresh();
  },

  /** 收藏视图开关：纯客户端过滤，即点即生效。 */
  onFavToggleTap() {
    this.setData({ favOnly: !this.data.favOnly });
    this.applyView();
  },

  /** 行尾星标：乐观更新，服务端结果为准，失败回滚。catchtap 不冒泡进详情。 */
  async onStarTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id || this._pendingStars.has(id)) return;
    const row = this._rows.find((r) => r.id === id);
    if (!row) return;
    const next = !row.favorited;

    this._pendingStars.add(id);
    row.favorited = next;
    this.applyView();

    try {
      const res = await toggleRaceFavorite(id);
      row.favorited = res.favorited;
      this.applyView();
    } catch {
      row.favorited = !next;
      this.applyView();
      wx.showToast({ title: '收藏操作失败', icon: 'none' });
    } finally {
      this._pendingStars.delete(id);
    }
  },

  onRaceTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.navigateTo({ url: `/pages/race-center/detail?id=${id}` });
  },

  onPlansTap() {
    // 「我的赛事」右上角入口：跳「我的比赛」页，默认落在「我的赛事」tab
    wx.navigateTo({ url: '/pages/my-races/my-races' });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});
