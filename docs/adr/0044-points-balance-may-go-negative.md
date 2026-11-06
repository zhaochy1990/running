# Points balance may go negative

The admin operations adjustment (devops#914) is the one write path in the points domain allowed to push a user's balance below zero. Every other deduction is guarded (the redemption UPDATE requires `balance >= cost`), so a negative balance can only ever come from an operations deduction. This ADR records why the guard is deliberately absent, because the asymmetry invites a future "fix" that would break production.

## Decision

- `AdminAdjustPointBalance` applies the signed delta with the check-in earn path's atomic upsert and **no balance floor**: `INSERT … ON DUPLICATE KEY UPDATE balance = balance + delta`. A deduction may take the balance negative — 欠账 (owed-debt) semantics.
- The API layer validates shape only: non-zero, within ±1,000,000, mandatory non-blank reason that lands verbatim in the adjust ledger row's `remark`. It must not re-introduce a floor.
- The redemption guard is untouched: a negative balance still cannot redeem (`balance >= cost` fails), so negativity never buys goods.

## Rationale

- The operator asked for explicit deductions that may exceed the current balance (penalties, clawbacks where the user has already spent the points). Clamping at zero would silently under-apply the penalty.
- A guard here is effectively irreversible once negative rows exist in production: tightening it later needs a data migration decision for every negative balance, not just a code change.

## Consequences

- Balances render negative in the mini-program points page and the admin console; both must display them as-is (the admin console colors them red).
- Anyone adding a `balance >= ?` guard to the adjustment path will surface a wave of 422s against existing negative balances — don't. If the product ever wants a floor, that is a new decision with a migration plan for existing negative rows.
- Ledger arithmetic stays exact: the balance equals the signed sum of `point_transactions`, including negatives; the reconciliation story is unchanged.
