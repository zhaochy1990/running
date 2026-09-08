/**
 * Per-node kernel progress mapping. The plan-job poll contract reuses the
 * legacy five-value stage enum (`reading_history` → `outputting`) so the
 * frontend card copy keeps working; each node maps to a monotonically
 * increasing anchor so stage + progress never regress (issue #437 user story).
 */

export interface StageProgress {
  stage: string;
  progressPct: number;
}

/** Master-plan kernel nodes → stage/progress anchors (in graph execution order). */
const MASTER_PLAN_NODES: Record<string, StageProgress> = {
  initialize: { stage: "reading_history", progressPct: 10 },
  assess_athlete: { stage: "evaluating", progressPct: 20 },
  assess_goal: { stage: "evaluating", progressPct: 28 },
  strategy_worker: { stage: "planning_phases", progressPct: 40 },
  dispatch_judges: { stage: "planning_phases", progressPct: 42 },
  judge_worker: { stage: "planning_phases", progressPct: 55 },
  select_strategy: { stage: "planning_phases", progressPct: 60 },
  expand_skeleton: { stage: "planning_phases", progressPct: 68 },
  simulate_load: { stage: "rule_filter", progressPct: 72 },
  filter_rules: { stage: "rule_filter", progressPct: 76 },
  validate_selected: { stage: "rule_filter", progressPct: 80 },
  review_worker: { stage: "outputting", progressPct: 88 },
  adjudicate_reviews: { stage: "outputting", progressPct: 92 },
  finalize: { stage: "outputting", progressPct: 99 },
};

/**
 * Merge one node's update into the running progress. Node keys in a langgraph
 * streamed update may carry a Send index (`judge_worker:abc`); the node name is
 * the part before `:`. Progress only ever moves forward (monotonic contract).
 */
export class MonotonicProgress {
  private state: StageProgress = { stage: "", progressPct: 0 };

  observe(nodeKey: string): StageProgress | null {
    const name = nodeKey.split(":")[0] as string;
    const anchor = MASTER_PLAN_NODES[name];
    if (anchor === undefined) return null;
    if (anchor.progressPct < this.state.progressPct) return null;
    this.state = { stage: anchor.stage, progressPct: anchor.progressPct };
    return this.state;
  }
}
