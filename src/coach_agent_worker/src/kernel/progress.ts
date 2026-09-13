/**
 * Shared per-node kernel progress machinery. The plan-job poll contract reuses
 * the legacy five-value stage enum (`reading_history` → `outputting`) so the
 * frontend card copy keeps working; each node maps to a monotonically
 * increasing anchor so stage + progress never regress (issue #437 user story).
 *
 * Node maps live with their kernel (`kernel/master/kernel.ts` exports
 * `MASTER_PLAN_NODES`, `kernel/weekly/kernel.ts` exports `WEEKLY_PLAN_NODES`);
 * this module only provides the machinery so a node map never couples the
 * shared code to a specific domain.
 */

export interface StageProgress {
  stage: string;
  progressPct: number;
}

/**
 * Merge one node's update into the running progress. Node keys in a langgraph
 * streamed update may carry a Send index (`phase_base:abc`); the node name is
 * the part before `:`. Progress only ever moves forward (monotonic contract).
 */
export class MonotonicProgress {
  private state: StageProgress = { stage: "", progressPct: 0 };

  constructor(private readonly nodes: Record<string, StageProgress>) {}

  observe(nodeKey: string): StageProgress | null {
    const name = nodeKey.split(":")[0] as string;
    const anchor = this.nodes[name];
    if (anchor === undefined) return null;
    if (anchor.progressPct < this.state.progressPct) return null;
    this.state = { stage: anchor.stage, progressPct: anchor.progressPct };
    return this.state;
  }
}
