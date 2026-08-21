# Screen

Name: `App Shell Side Drawer Syncing`
Route: `global shell over /v2/home`
State: `authenticated runner, COROS connected, drawer open, watch sync running`

## User Goal

Confirm that the explicit watch-data synchronization has started, understand what STRIDE is doing, and continue using the app without accidentally starting a duplicate synchronization task.

## Required Content

- Derive this state from the approved-direction `App Shell Side Drawer Open` candidate. Preserve the complete drawer, identity, device row, grouped navigation, logout, product footer, scrim, and underlying `跑者` page context.
- Keep all ten drawer destinations/actions in the exact same order and keep the bottom navigation behind the scrim as `跑者 / 训练 / 数据 / 教练`.
- Change only the synchronization affordances:
  - Device row remains `COROS PACE 3` and `已连接`.
  - Replace `上次同步 08:42` with a concise live state `正在同步`.
  - The `同步手表数据` action row becomes a disabled running row with a small deterministic progress indicator, label `正在同步手表数据`, and trailing progress `62%`.
  - Directly below that row, add one compact status line inside the `设备与提醒` section: `正在获取近期活动 · 已同步 28 / 45 条`.
  - The status line is informational, not a second button or card. Use text and progress in addition to animation so reduced-motion users receive the same information.
- Do not hide or disable navigation destinations. Synchronization is owned by the server and continues if the drawer is dismissed or the runner visits another page.
- Do not show a cancel action. Do not claim that synchronization is complete.

## Actions

- Primary: dismiss the drawer or select another destination while synchronization continues.
- Secondary: observe live synchronization progress. Repeated tapping on the disabled running row does nothing and does not create a second task.

## Navigation

- Enter from the idle drawer state by tapping `同步手表数据`.
- Dismissing returns to the exact prior primary tab and scroll position; the global app shell may surface the same running sync status in its top action.
- Selecting a route closes the drawer before navigation without cancelling the task.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation and preserve the validated edge-to-edge `100dvh` shell mechanics.
- Use the same opaque surfaces, solid scrim, modal semantics, safe-area environment variables, and 48 px touch targets as the idle state. No blur, glass, gradients, generic shadows, or phone-frame presentation.
- The synchronization state is understandable without relying on motion or color: it includes `正在同步`, stage text, item count, and `62%`.
- The running row uses `aria-disabled="true"` or a native disabled semantic while remaining readable. It has no chevron.
- Numeric progress and item counts use Geist Mono with tabular numerals; interface copy uses Inter.
- At `390×844`, all ten destinations, `退出登录`, and `STRIDE · 跑得更聪明` remain fully visible without drawer scrolling. At `360×800`, no horizontal overflow occurs and all content remains reachable.
- Keep the drawer `role="dialog"`, background inert, close control focused initially, and the scrim as a semantic dismissal button.

## Acceptance Checks

- Within two seconds the runner can tell that synchronization started, which stage is running, and that 28 of 45 activities are complete.
- No second synchronization CTA appears; the running row is visibly and semantically disabled.
- The drawer remains usable for navigation and can be dismissed while the task continues.
- All ten labels remain in the original order, with the sync label changed only to `正在同步手表数据` for this state.
- Browser inspection at `360×800` and `390×844` reports no document overflow, zero blur/filter elements, no controls below 48 × 48 px, correct safe-area declarations, and complete visibility/reachability of the footer.
