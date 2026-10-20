// 产品路线的纯变换 —— 不依赖小程序运行时，配套 utils/roadmapRows.check.mts
// 自检（`node --import ./utils/ts-resolve-hooks.mjs utils/roadmapRows.check.mts`）。
// 面板（components/roadmap-panel）负责请求与交互；投票/撤销的乐观更新与本地重排
// （devops#553：投票后不重拉列表）在这里做，排序与 Go 端 backlog（票数降序、
// 同票新想法在前）同源不漂移。列表概述（roadmapBlurb）也在这里：概述优先，
// 存量行兜底=描述去 markdown 截断，详情页 markdown 正文不进列表。

/** 投票池行的可变投影（页面行 / RoadmapBacklogItem 都满足）。 */
export interface PoolVoteRow {
  id: number;
  votes: number;
  voted: boolean;
}

/** 票数降序、同票新想法（id 大）在前。返回新数组，不改入参。 */
export function sortPoolRows<T extends PoolVoteRow>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => b.votes - a.votes || b.id - a.id);
}

/**
 * 乐观 toggle 一次投票：voted 取反、票数 ±1（夹在 0 以上）、我的票数同步 ±1，
 * 并整体重排。返回 [新行集（已重排）, 新的我的票数]；未知 id 原样返回。
 */
export function togglePoolVote<T extends PoolVoteRow>(
  rows: T[],
  id: number,
  myVotes: number,
): [T[], number] {
  const hit = rows.find((r) => r.id === id);
  if (!hit) return [rows, myVotes];
  const adding = !hit.voted;
  const next = rows.map((r) =>
    r.id === id ? { ...r, voted: adding, votes: Math.max(0, r.votes + (adding ? 1 : -1)) } : r,
  );
  return [sortPoolRows(next), Math.max(0, myVotes + (adding ? 1 : -1))];
}

// ── 列表概述（blurb）─────────────────────────────────────────────
// 列表行只渲染管理端写的概述；描述（可能含 markdown）只在详情页渲染。
// 存量行没有概述时兜底：描述去 markdown 符号取纯文本，截断到概述上限。

/** 列表概述的最大字符数（与管理端概述输入上限、后端 max=50 同源）。 */
export const ROADMAP_BLURB_MAX = 50;

/** 去掉 markdown 结构符号，取近似纯文本（列表兜底渲染用，尽力而为）。 */
export function stripMarkdownish(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // 围栏代码块
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题记号
    .replace(/^\s{0,3}>\s?/gm, '') // 引用记号
    .replace(/^\s{0,3}[-+*]\s+/gm, '') // 无序列表记号
    .replace(/^\s{0,3}\d+\.\s+/gm, '') // 有序列表记号
    .replace(/`([^`]*)`/g, '$1') // 行内 code
    .replace(/\*([^*\n]*)\*/g, '$1') // 加粗/斜体星号
    .replace(/__/g, '')
    .replace(/\|/g, ' '); // 表格分隔线
}

/**
 * 列表行文案：概述优先；无概述 → 描述去 markdown 后截到上限（超出补省略号）。
 * summary 容忍 undefined（后端未升级到带 summary 字段时的版本差，不炸渲染）。
 */
export function roadmapBlurb(summary: string | undefined, description: string): string {
  const s = (summary || '').trim();
  if (s) return s;
  const plain = stripMarkdownish(description || '').replace(/\s+/g, ' ').trim();
  if (plain.length <= ROADMAP_BLURB_MAX) return plain;
  return `${plain.slice(0, ROADMAP_BLURB_MAX)}…`;
}
