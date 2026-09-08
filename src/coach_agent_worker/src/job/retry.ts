/** Retry/poison decision (mirrors `src/go/internal/job/retry.go::DecideFailure`). */

export type RetryDecision = { outcome: "retry"; delayMs: number } | { outcome: "poison" };

/**
 * Decide what a non-permanent failure does. `attempts` is the number of
 * attempts made so far including the one that just failed; once it reaches
 * `maxAttempts` the job is poisoned. Backoff = base × 2^(attempts−1), capped.
 */
export function decideFailure(attempts: number, maxAttempts: number, baseBackoffMs: number, maxBackoffMs: number): RetryDecision {
  if (attempts >= maxAttempts) {
    return { outcome: "poison" };
  }
  let delay = baseBackoffMs;
  for (let i = 1; i < attempts; i++) {
    delay *= 2;
    if (delay >= maxBackoffMs) {
      delay = maxBackoffMs;
      break;
    }
  }
  if (delay > maxBackoffMs) delay = maxBackoffMs;
  return { outcome: "retry", delayMs: delay };
}
