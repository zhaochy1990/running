# Screen

Name: `App Shell Side Drawer Sync Complete`
Route: `global shell over /v2/home`
State: `authenticated runner, COROS connected, drawer open, watch sync just completed successfully`

## User Goal

Confirm that the explicit watch-data synchronization finished successfully, understand what was refreshed, and continue to another destination or dismiss the drawer without an extra acknowledgement step.

## Required Content

- Derive this state from the validated `App Shell Side Drawer Syncing` candidate. Preserve the complete underlying `跑者` page, scrim, drawer dimensions, identity, device row, grouped navigation, logout, product footer, and four bottom tabs.
- Keep all ten drawer destinations/actions in the exact same order. Do not add a success modal, toast overlay, or acknowledgement button.
- Change only the synchronization affordances:
  - Device row remains `COROS PACE 3` and `已连接`; replace its live sync text with `刚刚同步`.
  - Replace the running synchronization control with a non-interactive success status row.
  - The success row uses a static check-circle icon, label `同步完成`, and trailing value `45 / 45`.
  - Directly below the main row, keep one compact informational line: `近期活动与健康数据已更新 · 刚刚`.
  - Remove the determinate progress rail and every spinner or pulse animation. Success is communicated with icon, text, and count in addition to its semantic color.
- The success status is transient: after a short readable interval it returns to the ordinary `同步手表数据` idle action. This screen represents the post-completion interval and must not expose another immediate sync CTA.
- Do not hide or disable other navigation destinations. The runner may dismiss the drawer or navigate immediately.

## Actions

- Primary: dismiss the drawer or select another destination.
- Secondary: read the successful completion summary. No acknowledgement is required.

## Navigation

- Enter automatically when the active synchronization reaches its successful terminal state while the drawer remains open.
- Dismissing returns to the exact prior primary tab and scroll position.
- Selecting a route closes the drawer before navigation.
- After the short success interval, this same drawer returns to the idle sync state without changing route or scroll position.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation and preserve the validated edge-to-edge `100dvh` shell mechanics.
- Use the same opaque surfaces, solid scrim, modal semantics, safe-area environment variables, and 48 px touch targets as the prior states. No blur, glass, gradients, generic shadows, or phone-frame presentation.
- The completion row is a native disabled button or a semantic `role="status"` region with `aria-live="polite"`; it cannot receive focus or respond to taps.
- Use success green only on the static check icon and the concise completion signal. Keep Raycast coral as the brand accent elsewhere.
- Numeric count uses Geist Mono with tabular numerals; interface copy uses Inter.
- At `390×844`, all ten destinations, `退出登录`, and `STRIDE · 跑得更聪明` remain fully visible without drawer scrolling. At `360×800`, no horizontal overflow occurs and all content remains reachable.
- Keep the drawer `role="dialog"`, background inert, close control focused initially, and the scrim as a semantic dismissal button.

## Acceptance Checks

- Within two seconds the runner can tell that synchronization succeeded and that all 45 expected activities were processed.
- There is no progress animation, retry action, duplicate sync action, or acknowledgement button.
- The drawer remains usable for navigation and dismissal.
- All ten labels remain in their original order, with only the synchronization row changed to the transient success state.
- Browser inspection at `360×800` and `390×844` reports no document overflow, zero blur/filter elements, no controls below 48 × 48 px, correct safe-area declarations, and complete visibility of the footer.
