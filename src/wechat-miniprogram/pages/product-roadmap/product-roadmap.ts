// 产品路线页（devops#553；原型 prototypes/514-roadmap-vote-spike.html variant C 定稿）。
// 结构：hero 聚合（我的投票/人次参与/想法已上线 + CTA 滚到投票池）→ 最近上线
// changelog 时间线（绿点 + 票数快照）→ 正在做（折叠，预计 chip）→ 投票池
// （折叠=Top3 预览+展开全部；票数降序；toggle pill ▲/✓）。
// 投票/撤销乐观更新 + 本地重排，不重拉列表（纯逻辑在 utils/roadmapRows，
// 配套自检）；接口幂等，同一想法的连点由 per-item in-flight guard 串行化；
// 请求失败回滚并静默重拉对齐服务端（弱网下请求可能已生效，以服务端为准）。

import {
  getRoadmap,
  unvoteRoadmapFeature,
  voteRoadmapFeature,
  type RoadmapAcceptedItem,
  type RoadmapBacklogItem,
  type RoadmapReleasedItem,
} from '../../services/roadmap';
import { ApiError } from '../../services/request';
import { shanghaiDateFromIso } from '../../utils/date';
import { togglePoolVote, type PoolVoteRow } from '../../utils/roadmapRows';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

/** 最近上线时间线行。 */
interface ReleasedRow {
  id: number;
  /** 上海日期 2026.10.14 样式 */
  date: string;
  title: string;
  description: string;
  /** 发布时票数快照（「由 N 位跑友投票促成」） */
  proof: number;
}

/** 正在做（已采纳）行。 */
interface AcceptedRow {
  id: number;
  title: string;
  description: string;
  /** 预计上线说明，空则隐藏 chip */
  plannedNote: string;
  votes: number;
}

/** 投票池行（可投票想法）。 */
interface PoolRow extends PoolVoteRow {
  title: string;
  description: string;
  category: string;
  isNew: boolean;
}

interface ProductRoadmapPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  loadError: string;
  myVotes: number;
  /** 人次参与：已上线想法的发布时票数快照之和（原型 C 口径） */
  participants: number;
  releasedRows: ReleasedRow[];
  acceptedRows: AcceptedRow[];
  planOpen: boolean;
  poolOpen: boolean;
  poolRows: PoolRow[];
}

interface ProductRoadmapPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onLoad(): void;
  onShow(): void;
  onBack(): void;
  onRetry(): void;
  onCtaTap(): void;
  onFoldPlan(): void;
  onFoldPool(): void;
  onExpandPool(): void;
  onVoteTap(e: WechatMiniprogram.TouchEvent): void;
  fetchRoadmap(): Promise<void>;
  scrollToPool(): void;
  /** 在飞的投票 feature id：同一想法的连点直接忽略 */
  _voting: Set<number>;
  /** 数据请求序号：慢响应回来时发现自己已过期则丢弃（同 my-races._fetchSeq） */
  _fetchSeq: number;
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
  // 顶栏 = 标题行 128rpx，再留 24rpx 呼吸
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

function toReleasedRow(r: RoadmapReleasedItem): ReleasedRow {
  return {
    id: r.id,
    // released_at 已是上海偏移的 RFC3339，取上海日期部分（时区纪律：禁 slice 裸用日期语义）
    date: shanghaiDateFromIso(r.released_at).replace(/-/g, '.'),
    title: r.title,
    description: r.description,
    proof: r.votes_snapshot,
  };
}

function toAcceptedRow(r: RoadmapAcceptedItem): AcceptedRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    plannedNote: r.planned_note,
    votes: r.votes,
  };
}

function toPoolRow(r: RoadmapBacklogItem): PoolRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    isNew: r.is_new,
    votes: r.votes,
    voted: r.voted,
  };
}

Page<ProductRoadmapPageData, ProductRoadmapPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  _voting: new Set(),
  _fetchSeq: 0,

  data: {
    statusBarHeight: 0,
    contentPaddingTop: 240,
    loading: true,
    loadError: '',
    myVotes: 0,
    participants: 0,
    releasedRows: [],
    acceptedRows: [],
    planOpen: false,
    poolOpen: false,
    poolRows: [],
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onShow() {
    void this.fetchRoadmap();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },

  onRetry() {
    void this.fetchRoadmap();
  },

  onCtaTap() {
    if (this.data.poolOpen) {
      this.scrollToPool();
      return;
    }
    this.setData({ poolOpen: true }, () => this.scrollToPool());
  },

  onFoldPlan() {
    this.setData({ planOpen: !this.data.planOpen });
  },

  onFoldPool() {
    this.setData({ poolOpen: !this.data.poolOpen });
  },

  onExpandPool() {
    this.setData({ poolOpen: true });
  },

  onVoteTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id as string);
    if (!id || this._voting.has(id)) return;
    const row = this.data.poolRows.find((r) => r.id === id);
    if (!row) return;

    const adding = !row.voted;
    const prevRows = this.data.poolRows;
    const prevMyVotes = this.data.myVotes;
    // 乐观更新 + 本地重排（不重拉列表）
    const [nextRows, nextMyVotes] = togglePoolVote(prevRows, id, prevMyVotes);
    this.setData({ poolRows: nextRows, myVotes: nextMyVotes });
    wx.showToast({ title: adding ? '已投票 · 再点一次可撤销' : '已撤销这一票', icon: 'none' });

    this._voting.add(id);
    const req = adding ? voteRoadmapFeature(id) : unvoteRoadmapFeature(id);
    void req
      .catch((err: unknown) => {
        // 回滚乐观更新；静默重拉对齐服务端（弱网下请求可能已生效）
        this.setData({ poolRows: prevRows, myVotes: prevMyVotes });
        const msg =
          err instanceof ApiError && err.code === 'not_votable' ? '该想法已排期，暂不可投' : '投票失败';
        wx.showToast({ title: msg, icon: 'none' });
        void this.fetchRoadmap();
      })
      .finally(() => {
        this._voting.delete(id);
      });
  },

  async fetchRoadmap() {
    const seq = ++this._fetchSeq;
    const hasData =
      this.data.poolRows.length > 0 ||
      this.data.releasedRows.length > 0 ||
      this.data.acceptedRows.length > 0;
    // 已有数据时静默刷新，不闪 loading
    if (!hasData) this.setData({ loading: true, loadError: '' });
    try {
      const res = await getRoadmap();
      if (seq !== this._fetchSeq) return;
      this.setData({
        loading: false,
        loadError: '',
        myVotes: res.summary.my_votes,
        participants: res.released.reduce((sum, r) => sum + r.votes_snapshot, 0),
        releasedRows: res.released.map(toReleasedRow),
        acceptedRows: res.accepted.map(toAcceptedRow),
        // 后端已按票数降序；本地保序，后续投票在客户端重排
        poolRows: res.backlog.map(toPoolRow),
      });
    } catch (err) {
      if (seq !== this._fetchSeq) return;
      this.setData({
        loading: false,
        loadError: err instanceof Error ? err.message : '加载失败',
      });
    }
  },

  scrollToPool() {
    const q = wx.createSelectorQuery();
    q.select('#pool-head').boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      const rect = res && res[0];
      const scroll = res && res[1];
      if (!rect || !scroll) return;
      // fixed 顶栏 = 状态栏 + 128rpx 标题行，落在其下方
      wx.pageScrollTo({
        scrollTop: scroll.scrollTop + rect.top - (this.data.statusBarHeight + 64),
        duration: 300,
      });
    });
  },
});
