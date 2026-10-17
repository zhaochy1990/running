// 产品路线投票池的纯变换 —— 不依赖小程序运行时，配套 utils/roadmapRows.check.mts
// 自检（`node --import ./utils/ts-resolve-hooks.mjs utils/roadmapRows.check.mts`）。
// 页面（pages/product-roadmap）负责请求与交互；投票/撤销的乐观更新与本地重排
// （devops#553：投票后不重拉列表）在这里做，排序与 Go 端 backlog（票数降序、
// 同票新想法在前）同源不漂移。

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
