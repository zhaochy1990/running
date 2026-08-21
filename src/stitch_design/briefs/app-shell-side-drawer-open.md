# Screen

Name: `App Shell Side Drawer Open`
Route: `global shell over /v2/home`
State: `authenticated runner, COROS connected, drawer open, sync idle`

## User Goal

Let the runner verify which account and watch are active, then reach profile, discovery, device, notification, support, and app-management destinations without losing the current primary-tab context.

## Required Content

- Show a complete 390 px edge-to-edge mobile app state, not an isolated menu component. The underlying `跑者` home remains visible as a dimmed, non-interactive context strip on the right, with its stable bottom navigation still recognizable as `跑者 / 训练 / 数据 / 教练`.
- A modal navigation drawer slides from the left and occupies about 88% of the width, no more than 344 px. It extends through the status and bottom safe areas. A scrim covers the remaining app surface.
- The drawer header shows identity first: circular initial avatar `赵`, display name `赵朝义`, and compact account hint `zhao***@gmail.com`.
- Immediately below identity, show device status as a compact connected row: `COROS PACE 3`, status `已连接`, and `上次同步 08:42`. The entire status row opens watch management. Do not show CTL, training phase, readiness, or race metrics in the drawer.
- Organize destinations into three calm sections with restrained labels and full-width rows:
  1. `账户` — `个人中心`, `发现`.
  2. `设备与提醒` — `手表管理` with trailing `COROS`, `同步手表数据` with trailing `08:42`, `通知设置`.
  3. `支持与应用` — `意见反馈`, `常见问题`, `检查更新` with trailing `v1.0.0`, `关于 STRIDE`.
- Pin `退出登录` as a clearly separated destructive row near the bottom, followed by compact product text `STRIDE · 跑得更聪明`.
- Each destination has a simple leading icon, a concise Chinese label, and a directional chevron when it navigates. `同步手表数据` is the only row that performs an action in place and therefore has no chevron.
- The first 390 x 844 viewport must show every destination and the logout row without requiring scroll at normal text size. Use compact section spacing while preserving touch targets.

## Actions

- Primary: choose a destination row and close the drawer as the destination opens.
- Secondary: trigger `同步手表数据`, tap the scrim, use the close button, or use the Android back gesture to dismiss and return to the exact prior tab and scroll position.

## Navigation

- Enter by tapping the 48 px menu button in the top-left of any primary page: `跑者`, `训练`, `数据`, or `教练`.
- The drawer is global secondary navigation. It must not repeat primary destinations as drawer rows.
- `发现` and `个人中心` live in the drawer, not the bottom navigation.
- Dismissing does not change route. Selecting a route closes the drawer before navigation.
- Do not render a separate back arrow inside the drawer. Provide a 48 px close button in the header and a tappable scrim outside.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation and current project design system. Do not preserve the legacy light/green theme, five-tab navigation, floating record action, glass effects, or oversized fitness-dashboard cards.
- Do not copy the Web sidebar literally. Web functions map to mobile as follows: `本周训练` and activities feed `跑者`; `训练计划` feeds `训练`; training ability, health, body composition, and training status feed `数据`; Coach feeds `教练`; team becomes `发现`; sync, message settings, account, and logout become drawer responsibilities.
- Do not expose Web or internal labels such as `STRIDE Coach`, `团队`, `设置`, `本周训练`, `训练能力`, `体测记录`, `训练状态（STRIDE）`, `Master Plan`, or implementation route names in this drawer.
- Use one continuous drawer surface. Avoid placing every row in a separate card. Dividers and section labels establish hierarchy.
- Every row, close control, and scrim-dismiss region has a semantic touch target of at least 48 px.
- Status is understandable without color: device connection and destructive logout include text and icons.
- Use safe-area environment variables at top and bottom. No horizontal overflow at 360 px or 390 px.
- Use Inter for interface copy and Geist Mono with tabular numerals for time and version values.
- Keep coral to small active or destructive punctuation; green only communicates the connected/success state.
- Keep the DOM state representative of an open drawer: the scrim and drawer are visible, background controls are inert, focus begins inside the drawer, and the close control has an accessible label.

## Acceptance Checks

- Within three seconds the runner can identify the account, watch, connection state, and last synchronization time.
- The drawer contains exactly these navigation/action labels in this order: `个人中心`, `发现`, `手表管理`, `同步手表数据`, `通知设置`, `意见反馈`, `常见问题`, `检查更新`, `关于 STRIDE`, `退出登录`.
- The underlying app clearly communicates that this is an overlay opened from a primary page, not a standalone profile screen.
- Bottom navigation behind the scrim reads exactly `跑者 / 训练 / 数据 / 教练`; no fifth destination appears.
- All ten rows and the close control fit in the 390 x 844 viewport, remain usable at 360 px, and have at least 48 px touch height.
- Tapping the scrim or close control returns to the previous app state; triggering sync keeps the drawer open so progress can be observed.
- Browser inspection at 360 px and 390 px reports `documentElement.scrollWidth === innerWidth`, no clipped labels, and zero interactive controls below 48 x 48 px.
