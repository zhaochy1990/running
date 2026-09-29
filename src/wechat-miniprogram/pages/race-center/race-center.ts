// 赛事中心页 —— 全年路跑赛事密表（#392，#384 定稿的 C 紧凑清单版式）。
//
// 数据走 services/race-center（GET /api/race-calendar #390，收藏 toggle #391）。
// 每年数据以 scope=all 整年拉全（一页 100 场 + 翻页兜底，生产单年约 40 场），
// 「即将开跑」（race_date >= 今天）在客户端过滤——年份内 项目类型 / 城市 /
// 收藏视图全部纯客户端切换，即点即生效；城市下拉选项也取自同一份整年数据。
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
  onShow(): void;
  onPullDownRefresh(): void;
  onYearChange(e: WechatMiniprogram.PickerChange): void;
  onTypeChange(e: WechatMiniprogram.PickerChange): void;
  onCityChange(e: WechatMiniprogram.PickerChange): void;
  onFavToggleTap(): void;
  onStarTap(e: WechatMiniprogram.TouchEvent): void;
  onRaceTap(e: WechatMiniprogram.TouchEvent): void;
  onPlansTap(): void;
  onBack(): void;
  refresh(bustCache: boolean): Promise<void>;
  applyView(): void;
  /** 每年整年数据缓存（键=年份，scope 恒 all）；实例级，页面关掉即弃 */
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

/** 年份选项：当前上海年份 ±1。 */
function yearOptions(): string[] {
  const y = parseInt(shanghaiToday().slice(0, 4), 10);
  return [String(y - 1), String(y), String(y + 1)];
}

/** 整年拉全：一页 100 场，不足 total 则续页。 */
async function fetchYear(year: string): Promise<RaceCalendarRace[]> {
  const out: RaceCalendarRace[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await getRaceCalendar({ year, scope: 'all', page, perPage: PER_PAGE });
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
      years,
      yearIndex: Math.max(years.indexOf(thisYear), 0),
    });
    void this.refresh(false);
  },

  // 未登录进入被拦下后，登录回来本页要能自愈（缓存命中时 refresh 不发请求）
  onShow() {
    if (!this.data.loading) void this.refresh(false);
  },

  onPullDownRefresh() {
    void this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  /** 载入（或重载）当前年份的整年数据并渲染。缓存命中时纯本地重算。 */
  async refresh(bustCache: boolean) {
    if (!userStore.getState().user) {
      this.setData({ loading: false, error: '请先登录后查看赛事日历' });
      return;
    }
    const year = this.data.years[this.data.yearIndex] || shanghaiToday().slice(0, 4);
    const seq = (this._fetchSeq += 1);

    if (bustCache || !this._cache.has(year)) {
      this.setData({ loading: true, error: '' });
      try {
        const rows = await fetchYear(year);
        // 已被更新的请求取代：本响应作废（不写缓存，新请求会带来更新的数据）
        if (seq !== this._fetchSeq) return;
        this._cache.set(year, rows);
      } catch (err: unknown) {
        if (seq !== this._fetchSeq) return;
        const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
        // 缓存里没有该年数据（如切年失败）：清空旧年残留视图，只留错误条；
        // 有缓存（如下拉刷新失败）：保留旧列表，banner 说明即可
        const patch: Partial<RaceCenterPageData> = { loading: false, error: msg };
        if (!this._cache.has(year)) {
          Object.assign(patch, { groups: [], viewCount: 0, emptyText: '' });
        }
        this.setData(patch);
        return;
      }
    }
    this.setData({ loading: false });
    this.applyView();
  },

  /** 用当前筛选条件重算 分组/计数/城市选项/空态。数据已在缓存，纯同步。 */
  applyView() {
    const year = this.data.years[this.data.yearIndex] || '';
    const rows = this._cache.get(year);
    if (!rows) return; // 该年数据未落地：保留现状，请求回来后统一重算

    // 城市按「值」记录选中身份：列表重算（刷新/切年）后按下标会漂到别的城市
    const selectedCity = this.data.cityIndex > 0 ? this.data.cityNames[this.data.cityIndex] || '' : '';

    // 默认视图只看即将开跑；收藏视图与往年看整年（往年的 upcoming 恒空）
    const floor =
      !this.data.favOnly && year >= shanghaiToday().slice(0, 4) ? shanghaiToday() : '';
    const inScope = floor ? rows.filter((r) => r.race_date >= floor) : rows;
    const filtered = filterRaces(inScope, {
      type: TYPE_OPTIONS[this.data.typeIndex].token,
      city: selectedCity,
      favoritesOnly: this.data.favOnly,
    });
    const groups = groupByMonth(filtered);

    // 城市选项取整年未过滤集合：年份内切换筛选时选项稳定，不随视图塌缩
    const cityNames = ['全部', ...cityOptions(rows)];
    const cityIndex = selectedCity ? Math.max(cityNames.indexOf(selectedCity), 0) : 0;

    let emptyText = '';
    if (groups.length === 0) {
      if (rows.length === 0) {
        emptyText = `${year} 年暂无已发布赛事 · 下拉刷新`;
      } else if (this.data.favOnly && this.data.typeIndex === 0 && !selectedCity) {
        emptyText = '还没有收藏的赛事 · 退出收藏筛选后点 ☆ 收藏';
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

  /** 收藏视图开关：纯客户端过滤，即点即生效。 */
  onFavToggleTap() {
    this.setData({ favOnly: !this.data.favOnly });
    this.applyView();
  },

  /** 行尾星标：乐观更新，服务端结果为准，失败回滚。catchtap 不冒泡进详情。 */
  async onStarTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id || this._pendingStars.has(id)) return;
    const rows = this._cache.get(this.data.years[this.data.yearIndex] || '');
    const row = rows?.find((r) => r.id === id);
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
    // 「我的赛事」右上角入口（#394）：参赛计划管理二级页
    wx.navigateTo({ url: '/pages/race-center/plans/plans' });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});
