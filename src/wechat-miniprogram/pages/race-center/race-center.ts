// 赛事中心页 —— 全年路跑赛事密表（#392，#384 定稿的 C 紧凑清单版式）。
//
// 数据走 services/race-center（GET /api/race-calendar #390，收藏 toggle #391）。
// 每年数据整年拉全（一页 100 场 + 翻页兜底，生产单年约 40 场），年份内
// 项目类型 / 城市 / 收藏视图全部客户端过滤，切换即生效；收藏视图改用
// scope=all 补拉整年，避免「今年已结束的收藏赛事」在 upcoming 集里丢失。
// 纯视图变换（徽章/缩写/分组/筛选）在 utils/raceCenterRows，配套自检。

import {
  getRaceCalendar,
  toggleRaceFavorite,
  type RaceCalendarRace,
} from '../../services/race-center';
import { cityOptions, filterRaces, groupByMonth } from '../../utils/raceCenterRows';
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
  contentPaddingTop: number;
  /** 筛选栏固定在顶栏下方的像素偏移（px，顶栏用 rpx 布局需换算） */
  filterBarTopPx: number;
  /** 月份分组头 sticky 的 top（筛选栏底沿），px */
  stickyTopPx: number;
  loading: boolean;
  error: string;
  years: string[];
  yearIndex: number;
  typeLabels: string[];
  typeIndex: number;
  cityNames: string[];
  cityIndex: number;
  favOnly: boolean;
  groups: ReturnType<typeof groupByMonth>;
  viewCount: number;
  /** 非空时渲染空态文案（区分收藏空 / 筛选空 / 年份无数据） */
  emptyText: string;
}

interface RaceCenterPageHandlers {
  onLoad(): void;
  onPullDownRefresh(): void;
  onYearChange(e: WechatMiniprogram.PickerChange): void;
  onTypeChange(e: WechatMiniprogram.PickerChange): void;
  onCityChange(e: WechatMiniprogram.PickerChange): void;
  onFavToggleTap(): void;
  onStarTap(e: WechatMiniprogram.TouchEvent): void;
  onRaceTap(): void;
  onMyRacesTap(): void;
  onBack(): void;
  refresh(bustCache: boolean): Promise<void>;
  applyView(): void;
  /** 每年的整年数据缓存，键 `${year}:${scope}`；实例级，页面关掉即弃 */
  _cache: Map<string, RaceCalendarRace[]>;
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

function windowWidth(): number {
  try {
    return wx.getWindowInfo().windowWidth || 375;
  } catch {
    return wx.getSystemInfoSync().windowWidth || 375;
  }
}

/** 顶栏（128rpx）换算成 px 的总偏移：筛选栏 fixed 定位用。 */
function filterBarTop(): number {
  return statusBarHeight() + Math.round((128 * windowWidth()) / 750);
}

/** 筛选栏底沿（顶栏 128rpx + 筛选栏 88rpx）：月份头 sticky 定位用。 */
function stickyTop(): number {
  return statusBarHeight() + Math.round(((128 + 88) * windowWidth()) / 750);
}

function contentPaddingTopRpx(): number {
  return Math.round((statusBarHeight() * 750) / windowWidth()) + 128 + 88 + 32;
}

/** 年份选项：当前上海年份 ±1。 */
function yearOptions(): string[] {
  const y = parseInt(shanghaiToday().slice(0, 4), 10);
  return [String(y - 1), String(y), String(y + 1)];
}

/** 整年拉全：一页 100 场，不足 total 则续页。 */
async function fetchYear(year: string, scope: 'upcoming' | 'all'): Promise<RaceCalendarRace[]> {
  const out: RaceCalendarRace[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await getRaceCalendar({ year, scope, page, perPage: PER_PAGE });
    out.push(...res.races);
    if (res.races.length === 0 || out.length >= res.total) break;
  }
  return out;
}

Page<RaceCenterPageData, RaceCenterPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 280,
    filterBarTopPx: 88,
    stickyTopPx: 132,
    loading: true,
    error: '',
    years: [],
    yearIndex: 1,
    typeLabels: TYPE_OPTIONS.map((o) => o.label),
    typeIndex: 0,
    cityNames: ['全部'],
    cityIndex: 0,
    favOnly: false,
    groups: [],
    viewCount: 0,
    emptyText: '',
  },

  // 实例级私有状态（随页面销毁丢弃）
  _cache: new Map<string, RaceCalendarRace[]>(),
  _pendingStars: new Set<number>(),
  _fetchSeq: 0,

  onLoad() {
    const years = yearOptions();
    const thisYear = shanghaiToday().slice(0, 4);
    this.setData({
      statusBarHeight: statusBarHeight(),
      filterBarTopPx: filterBarTop(),
      stickyTopPx: stickyTop(),
      contentPaddingTop: contentPaddingTopRpx(),
      years,
      yearIndex: Math.max(years.indexOf(thisYear), 0),
    });
    void this.refresh(false);
  },

  onPullDownRefresh() {
    void this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  /** 载入（或重载）当前 年份+收藏视图 对应的整年数据并渲染。 */
  async refresh(bustCache: boolean) {
    if (!userStore.getState().user) {
      this.setData({ loading: false, error: '请先登录后查看赛事日历' });
      return;
    }
    const year = this.data.years[this.data.yearIndex] || shanghaiToday().slice(0, 4);
    const scope =
      this.data.favOnly || year < shanghaiToday().slice(0, 4) ? 'all' : 'upcoming';
    const key = `${year}:${scope}`;
    if (bustCache) this._cache.delete(key);

    const seq = (this._fetchSeq += 1);
    this.setData({ loading: true, error: '' });
    try {
      if (!this._cache.has(key)) {
        this._cache.set(key, await fetchYear(year, scope));
      }
      if (seq !== this._fetchSeq) return; // 已被更新的筛选请求取代
      this.setData({ loading: false });
      this.applyView();
    } catch (err: unknown) {
      if (seq !== this._fetchSeq) return;
      const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
      this.setData({ loading: false, error: msg });
    }
  },

  /** 用当前筛选条件重算 分组/计数/城市选项/空态。数据已在缓存，纯同步。 */
  applyView() {
    const year = this.data.years[this.data.yearIndex] || '';
    const scope = this.data.favOnly || year < shanghaiToday().slice(0, 4) ? 'all' : 'upcoming';
    const rows = this._cache.get(`${year}:${scope}`) || [];
    const filtered = filterRaces(rows, {
      type: TYPE_OPTIONS[this.data.typeIndex].token,
      city: this.data.cityIndex > 0 ? this.data.cityNames[this.data.cityIndex] : '',
      favoritesOnly: this.data.favOnly,
    });
    const groups = groupByMonth(filtered);

    // 城市选项来自该年未过滤集合；切换年份后若原选中城市不在列表则回落「全部」
    const cityNames = ['全部', ...cityOptions(rows)];
    const cityIndex =
      this.data.cityIndex < cityNames.length ? this.data.cityIndex : 0;

    let emptyText = '';
    if (groups.length === 0) {
      if (rows.length === 0) {
        emptyText = `${year} 年暂无已发布赛事 · 下拉刷新`;
      } else if (this.data.favOnly && filtered.length === 0 && this.data.typeIndex === 0 && cityIndex === 0) {
        emptyText = '还没有收藏的赛事 · 点行尾 ☆ 收藏感兴趣的赛事';
      } else {
        emptyText = '当前筛选下没有赛事 · 换个条件试试';
      }
    }

    this.setData({ groups, viewCount: filtered.length, cityNames, cityIndex, emptyText });
  },

  onYearChange(e: WechatMiniprogram.PickerChange) {
    // mode=selector 的 value 是数组下标；类型联合是共享 PickerChange 定义所致
    const yearIndex = Number(e.detail.value);
    if (yearIndex === this.data.yearIndex) return;
    // 换年城市集合重建，选中城市语义已失效，回落「全部」
    this.setData({ yearIndex, cityIndex: 0 });
    void this.refresh(false);
  },

  onTypeChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ typeIndex: Number(e.detail.value) });
    this.applyView();
  },

  onCityChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ cityIndex: Number(e.detail.value) });
    this.applyView();
  },

  /** 收藏视图开关：仅当需要补拉 scope=all 时才走网络，否则纯客户端过滤。 */
  onFavToggleTap() {
    this.setData({ favOnly: !this.data.favOnly });
    void this.refresh(false);
  },

  /** 行尾星标：乐观更新，服务端结果回来对账，失败回滚。catchtap 不冒泡进详情。 */
  async onStarTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id || this._pendingStars.has(id)) return;

    // 同一赛事可能同时存在于当年的 upcoming 与 all 两份缓存，翻转要一并改
    const touched: RaceCalendarRace[] = [];
    for (const rows of this._cache.values()) {
      const row = rows.find((r) => r.id === id);
      if (row) touched.push(row);
    }
    if (touched.length === 0) return;
    const next = !touched[0].favorited;

    this._pendingStars.add(id);
    for (const row of touched) row.favorited = next;
    this.applyView();

    try {
      const res = await toggleRaceFavorite(id);
      if (res.favorited !== next) {
        // 并发窗口被别处翻转：以服务端为准对账
        for (const row of touched) row.favorited = res.favorited;
        this.applyView();
      }
    } catch {
      for (const row of touched) row.favorited = !next;
      this.applyView();
      wx.showToast({ title: '收藏操作失败', icon: 'none' });
    } finally {
      this._pendingStars.delete(id);
    }
  },

  onRaceTap() {
    // 详情页是 #393 的范围，先给明确反馈而不是静默无响应
    wx.showToast({ title: '赛事详情即将上线', icon: 'none' });
  },

  onMyRacesTap() {
    wx.navigateTo({ url: '/pages/my-races/my-races' });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});
