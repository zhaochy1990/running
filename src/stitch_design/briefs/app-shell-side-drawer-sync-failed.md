# Screen

Name: `App Shell Side Drawer Sync Failed`
Route: `global shell over /v2/home`
State: `authenticated runner, COROS connected, drawer open, watch sync interrupted by a recoverable network failure`

## User Goal

Understand that synchronization did not finish, confirm that completed progress was preserved, and resume from the interruption without starting a duplicate task or losing access to the rest of the app.

## Required Content

- Derive this state from the validated drawer family. Preserve the complete underlying `跑者` page, scrim, drawer dimensions, identity, device row, grouped navigation, logout, product footer, and four bottom tabs.
- Keep all ten drawer destinations/actions in the exact same order.
- Change only the synchronization affordances:
  - Device row remains `COROS PACE 3` and `已连接`; its secondary live state becomes `同步未完成`.
  - Replace the synchronization status with one full-width retry control.
  - The retry control uses a static warning/error icon, primary label `继续同步`, and trailing action label `重试`. Do not use a chevron.
  - Directly below the main row, show one compact explanation inside the same control: `网络连接中断 · 已保留 28 / 45 条`.
  - Do not expose a second retry CTA, cancel action, raw exception, progress rail, spinner, or percentage.
- Tapping anywhere on the retry control resumes the same synchronization task from preserved progress and transitions to the running state. Repeated taps are suppressed immediately while the request starts.
- Do not disable other navigation destinations. The failure remains visible when the user returns until retry succeeds or a later explicit sync replaces it.

## Actions

- Primary: tap `继续同步` to resume the interrupted task.
- Secondary: dismiss the drawer or navigate elsewhere without discarding the preserved progress.

## Navigation

- Enter automatically when a running synchronization terminates with a recoverable network failure.
- Retrying transitions to `App Shell Side Drawer Syncing` and retains the preserved item count.
- Dismissing returns to the exact prior primary tab and scroll position.
- Selecting a route closes the drawer before navigation.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation and preserve the validated edge-to-edge `100dvh` shell mechanics.
- Use the same opaque surfaces, solid scrim, modal semantics, safe-area environment variables, and 48 px minimum touch targets. No blur, glass, gradients, generic shadows, or phone-frame presentation.
- Encode failure with icon, `同步未完成`, explanation, and retry label in addition to semantic color. Never rely on red alone.
- Use semantic error color only for the failure icon and concise failure signal. Keep the retry label highly legible.
- The retry control is one native button of at least 68 px height with a single accessible name that includes the failure reason and preserved count.
- Numeric item counts use Geist Mono with tabular numerals; interface copy uses Inter.
- At `390×844`, all ten destinations, `退出登录`, and `STRIDE · 跑得更聪明` remain fully visible without drawer scrolling. At `360×800`, no horizontal overflow occurs and all content remains reachable.
- Keep the drawer `role="dialog"`, background inert, close control focused initially, and the scrim as a semantic dismissal button.

## Acceptance Checks

- Within two seconds the runner knows that synchronization stopped because of connectivity, that 28 of 45 completed items are preserved, and exactly where to resume.
- There is exactly one retry control and no destructive or cancel action.
- Tapping the retry control has one unambiguous outcome: resume the same task from preserved progress.
- The drawer remains usable for navigation and dismissal.
- Browser inspection at `360×800` and `390×844` reports no document overflow, zero blur/filter elements, no controls below 48 × 48 px, correct safe-area declarations, and complete visibility of the footer.
