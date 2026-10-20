// 产品路线面板（devops#553 原型 514 variant C；自 product-roadmap 页抽出为
// 共享组件——产品路线并入意见反馈页二级 tab 后，原页面保留为深链薄壳）。
// 2026-10-18 用户拍板：hero 聚合卡整卡移除；列表卡全部扁平化贴边
// （无卡底/圆角，内容直铺到屏幕边，行间用发丝线分隔）。
// 结构：最近上线 changelog 时间线（绿点 + 票数快照）→ 正在做（折叠，
// 预计 chip）→ 投票池（折叠=Top3 预览+展开全部；票数降序；toggle pill
// ▲/✓）。三区行都可点按进详情页（列表只渲染概述 blurb，markdown 正文
// 在详情页渲染）；投票/撤销乐观更新 + 本地重排，不重拉列表（纯逻辑在
// utils/roadmapRows，配套自检）；接口幂等，同一想法的连点由 per-item
// in-flight guard 串行化；请求失败回滚并静默重拉对齐服务端（弱网下
// 请求可能已生效，以服务端为准）。

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
import { roadmapBlurb, togglePoolVote, type PoolVoteRow } from '../../utils/roadmapRows';

/** 最近上线时间线行。blurb=列表概述（概述优先，存量行兜底截断描述）。 */
interface ReleasedRow {
  id: number;
  /** 上海日期 2026.10.14 样式 */
  date: string;
  title: string;
  blurb: string;
  /** 发布时票数快照（「由 N 位跑友投票促成」） */
  proof: number;
}

/** 正在做（已采纳）行。 */
interface AcceptedRow {
  id: number;
  title: string;
  blurb: string;
  /** 预计上线说明，空则隐藏 chip */
  plannedNote: string;
  votes: number;
}

/** 投票池行（可投票想法）。 */
interface PoolRow extends PoolVoteRow {
  title: string;
  blurb: string;
  category: string;
  isNew: boolean;
}

interface RoadmapPanelData {
  loading: boolean;
  loadError: string;
  releasedRows: ReleasedRow[];
  acceptedRows: AcceptedRow[];
  planOpen: boolean;
  poolOpen: boolean;
  poolRows: PoolRow[];
}

/** 实例字段（非渲染数据）：挂在 this 上避免模块级状态多实例串扰。 */
interface RoadmapPanelInstance {
  /** 在飞的投票 feature id：同一想法的连点直接忽略 */
  _voting: Set<number>;
  /** 数据请求序号：慢响应回来时发现自己已过期则丢弃 */
  _fetchSeq: number;
}

type RoadmapPanelMethods = {
  fetchRoadmap(): Promise<void>;
  onRetry(): void;
  onFoldPlan(): void;
  onFoldPool(): void;
  onExpandPool(): void;
  onVoteTap(e: WechatMiniprogram.TouchEvent): void;
  onFeatureTap(e: WechatMiniprogram.TouchEvent): void;
};

function toReleasedRow(r: RoadmapReleasedItem): ReleasedRow {
  return {
    id: r.id,
    // released_at 已是上海偏移的 RFC3339，取上海日期部分（时区纪律：禁 slice 裸用日期语义）
    date: shanghaiDateFromIso(r.released_at).replace(/-/g, '.'),
    title: r.title,
    blurb: roadmapBlurb(r.summary, r.description),
    proof: r.votes_snapshot,
  };
}

function toAcceptedRow(r: RoadmapAcceptedItem): AcceptedRow {
  return {
    id: r.id,
    title: r.title,
    blurb: roadmapBlurb(r.summary, r.description),
    plannedNote: r.planned_note,
    votes: r.votes,
  };
}

function toPoolRow(r: RoadmapBacklogItem): PoolRow {
  return {
    id: r.id,
    title: r.title,
    blurb: roadmapBlurb(r.summary, r.description),
    category: r.category,
    isNew: r.is_new,
    votes: r.votes,
    voted: r.voted,
  };
}

Component<RoadmapPanelData, {}, RoadmapPanelMethods, [], RoadmapPanelInstance>({
  data: {
    loading: true,
    loadError: '',
    releasedRows: [],
    acceptedRows: [],
    planOpen: false,
    poolOpen: false,
    poolRows: [],
  },

  lifetimes: {
    attached() {
      this._voting = new Set();
      this._fetchSeq = 0;
      void this.fetchRoadmap();
    },
  },

  // 宿主页 onShow 时静默刷新（已有数据不闪 loading），与其他页 onShow 重拉口径一致
  pageLifetimes: {
    show() {
      void this.fetchRoadmap();
    },
  },

  methods: {
    onRetry() {
      void this.fetchRoadmap();
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

    // 行点按 → 详情页（markdown 正文）；投票按钮是独立兄弟节点，不冒泡到这。
    onFeatureTap(e: WechatMiniprogram.TouchEvent) {
      const id = Number(e.currentTarget.dataset.id as string);
      if (!id) return;
      wx.navigateTo({ url: `/pages/roadmap-detail/roadmap-detail?id=${id}` });
    },

    onVoteTap(e: WechatMiniprogram.TouchEvent) {
      const id = Number(e.currentTarget.dataset.id as string);
      if (!id || this._voting.has(id)) return;
      const row = this.data.poolRows.find((r) => r.id === id);
      if (!row) return;

      const adding = !row.voted;
      const prevRows = this.data.poolRows;
      // 乐观更新 + 本地重排（不重拉列表；myVotes 聚合已随 hero 卡移除，第二返回值弃用）
      const [nextRows] = togglePoolVote(prevRows, id, 0);
      this.setData({ poolRows: nextRows });
      wx.showToast({ title: adding ? '已投票 · 再点一次可撤销' : '已撤销这一票', icon: 'none' });

      this._voting.add(id);
      const req = adding ? voteRoadmapFeature(id) : unvoteRoadmapFeature(id);
      void req
        .catch((err: unknown) => {
          // 回滚乐观更新；静默重拉对齐服务端（弱网下请求可能已生效）
          this.setData({ poolRows: prevRows });
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
  },
});
