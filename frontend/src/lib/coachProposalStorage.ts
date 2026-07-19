/**
 * sessionStorage-backed stash for a single in-flight plan-adjust proposal.
 *
 * A proposal is selected in the `/coach` chat, stashed here keyed by (user,
 * target), then read back when the three-column adjust workspace opens. Keying
 * by target guarantees a proposal generated for one week/plan can never be
 * applied against a different one.
 *
 * All reads are defensive: corrupt JSON, a tampered embedded target, or a key
 * mismatch return `null` and purge the bad entry. Writes are immutable — the
 * caller's object is never mutated.
 */

import type {
  ProposalTargetKey,
  StashedProposal,
  WorkspaceProposal,
} from '../components/coach-workspace/types'

const KEY_PREFIX = 'coach:proposal'

/** Build the storage key for a target. Master keys on planId, weekly on folder. */
function storageKey(target: ProposalTargetKey): string {
  const surface = target.kind === 'master' ? `master:${target.planId ?? ''}` : `weekly:${target.folder ?? ''}`
  return `${KEY_PREFIX}:${target.userId}:${surface}`
}

/** True when two target keys refer to the exact same plan surface. */
function sameTarget(a: ProposalTargetKey, b: ProposalTargetKey): boolean {
  return (
    a.userId === b.userId &&
    a.kind === b.kind &&
    (a.folder ?? null) === (b.folder ?? null) &&
    (a.planId ?? null) === (b.planId ?? null)
  )
}

function isTargetKey(value: unknown): value is ProposalTargetKey {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return typeof t.userId === 'string' && (t.kind === 'weekly' || t.kind === 'master')
}

function isStashedProposal(value: unknown): value is StashedProposal {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (!isTargetKey(s.target)) return false
  if (typeof s.contextAnchor !== 'string') return false
  if (typeof s.rawProposal !== 'object' || s.rawProposal === null) return false
  const p = s.proposal as { proposalType?: unknown } | undefined
  return (
    typeof p === 'object' &&
    p !== null &&
    (p.proposalType === 'weekly_diff' ||
      p.proposalType === 'weekly_create' ||
      p.proposalType === 'master_diff')
  )
}

/**
 * Stash a proposal for its target, replacing any prior proposal on the same
 * surface. The input is not mutated.
 */
export function stashProposal(entry: Readonly<StashedProposal>): void {
  const key = storageKey(entry.target)
  sessionStorage.setItem(key, JSON.stringify(entry))
}

/**
 * Read the proposal stashed for `target`, or `null` if none is present, the
 * stored JSON is corrupt, or the embedded target does not match. A bad entry is
 * purged so it cannot poison future reads.
 */
export function readStashedProposal<P extends WorkspaceProposal = WorkspaceProposal>(
  target: ProposalTargetKey,
): StashedProposal<P> | null {
  const key = storageKey(target)
  const raw = sessionStorage.getItem(key)
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    sessionStorage.removeItem(key)
    return null
  }

  if (!isStashedProposal(parsed) || !sameTarget(parsed.target, target)) {
    sessionStorage.removeItem(key)
    return null
  }

  return parsed as StashedProposal<P>
}

/** Remove the stashed proposal for `target`. No-op when absent. */
export function clearStashedProposal(target: ProposalTargetKey): void {
  sessionStorage.removeItem(storageKey(target))
}
