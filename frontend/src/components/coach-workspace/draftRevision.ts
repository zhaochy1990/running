/**
 * Pure helpers for the "continue revising the draft" flow.
 *
 * A weekly-create proposal is stashed before same-route navigation. Its stable
 * content fingerprint rides in router state, causing the Review page to re-read
 * sessionStorage only when the selected draft actually changes.
 */

/**
 * Deterministic fingerprint of a create proposal body. Stable across object key
 * order so two structurally-equal revisions produce the same navigation token.
 */
export function fingerprintProposal(raw: Readonly<Record<string, unknown>>): string {
  return stableStringify(raw)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}
