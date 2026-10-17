/**
 * roadmapRows.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/roadmapRows.check.mts`。
 * 覆盖 投票池排序（票数降序 / 同票新想法在前 / 不改入参）与乐观投票 toggle
 * （投票 +1、撤销 -1、票数夹 0、我的票数同步、重排、未知 id no-op、二次 toggle 还原）。
 */
import { sortPoolRows, togglePoolVote, type PoolVoteRow } from './roadmapRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const row = (id: number, votes: number, voted = false): PoolVoteRow => ({ id, votes, voted });

// ── 排序：票数降序，同票 id 大（新）在前 ──
const src = [row(3, 5, true), row(9, 5), row(1, 12), row(4, 1)];
eq(sortPoolRows(src).map((r) => r.id), [1, 9, 3, 4], 'sort votes desc, tie id desc');
// 入参不被改动
eq(src.map((r) => r.id), [3, 9, 1, 4], 'sort does not mutate input');

// ── 乐观投票：+1、重排、我的票数同步 ──
const pool = [row(7, 10), row(2, 4), row(5, 4)];
const [voted, myVotes1] = togglePoolVote(pool, 2, 3);
eq(voted.map((r) => [r.id, r.votes, r.voted]), [[7, 10, false], [2, 5, true], [5, 4, false]], 'vote +1 and resort');
eq(myVotes1, 4, 'myVotes +1');
// 原行集不被改动（回滚要用）
eq(pool.map((r) => r.votes), [10, 4, 4], 'toggle does not mutate input');

// ── 撤销：-1、同票回到 id 降序 ──
const [unvoted, myVotes2] = togglePoolVote(voted, 2, myVotes1);
eq(unvoted.map((r) => [r.id, r.votes, r.voted]), [[7, 10, false], [5, 4, false], [2, 4, false]], 'unvote -1 and resort');
eq(myVotes2, 3, 'myVotes -1');

// ── 票数/我的票数夹 0（防御负数）──
const [clamped, myVotes3] = togglePoolVote([row(1, 0, true)], 1, 0);
eq(clamped[0].votes, 0, 'votes clamp at 0');
eq(myVotes3, 0, 'myVotes clamp at 0');

// ── 未知 id：原样返回 ──
const same = [row(1, 2)];
const [sameRows, sameMy] = togglePoolVote(same, 99, 1);
eq(sameRows, same, 'unknown id returns rows as-is');
eq(sameMy, 1, 'unknown id keeps myVotes');

// ── 二次 toggle 完整还原（重排后同票按 id 降序，5 在 2 前）──
const [a, ma] = togglePoolVote(pool, 7, 0);
const [b, mb] = togglePoolVote(a, 7, ma);
eq(b.map((r) => [r.id, r.votes, r.voted]), [[7, 10, false], [5, 4, false], [2, 4, false]], 'double toggle restores pool');
eq(mb, 0, 'double toggle restores myVotes');

console.log('roadmapRows.check: all assertions passed');
