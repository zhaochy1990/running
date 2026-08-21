# Screen

Name: `App Shell Side Drawer Logout Confirmation`
Route: `global shell over /v2/home`
State: `authenticated runner, drawer open, logout confirmation dialog open`

## User Goal

Confirm whether to end the current signed-in session without confusing logout with permanent account deletion.

## Required Content

- Derive this state from the validated `App Shell Side Drawer Open` candidate. Preserve the complete underlying `跑者` page, four bottom tabs, scrim, drawer dimensions, identity, device status, grouped destinations, logout row, and product footer.
- Keep the drawer visible behind the confirmation so the runner retains context, but make the drawer and the underlying page inert while the dialog is open.
- Add one centered modal alert dialog on an opaque raised Foundation surface. Do not replace the full screen or navigate to a standalone confirmation page.
- Dialog title: `退出登录`.
- Primary question: `确认退出当前账号？`.
- Supporting consequence text: `退出后将返回登录页，训练数据不会被删除。` This must clearly distinguish logout from permanent account deletion.
- Two actions in safe order:
  - `取消` is the default focused secondary action.
  - `退出` is the destructive confirmation action.
- Use a small logout icon or destructive punctuation only if it improves recognition. Do not add an illustration, warning banner, password field, checkbox, or account-deletion language.

## Actions

- Primary safe action: `取消` closes only the dialog and returns to the same open drawer state.
- Destructive action: `退出` ends the current session, unregisters the current push device as defined by the product flow, clears local authentication state, and returns to the authentication start screen.
- Android back and tapping outside the dialog behave like `取消`.

## Navigation

- Enter by tapping `退出登录` in the open side drawer.
- Cancelling preserves the same primary tab, drawer state, and scroll position.
- Confirming exits the authenticated navigation shell and returns to the authentication start screen.
- This is logout only. Permanent account deletion remains a separate personal-center flow with stronger confirmation.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation and preserve the validated edge-to-edge `100dvh` shell mechanics.
- Keep every visible button at least 48 logical px high and provide sufficient separation between safe and destructive actions.
- Use an opaque dialog surface and solid modal scrim. No blur, glass, gradients, generic shadows, or phone-frame presentation.
- Destructive intent must be encoded with the `退出` label and logout icon or position in addition to semantic color. Do not rely on coral or red alone.
- Use Inter for all interface copy. No athletic data is introduced by this state.
- Keep dialog content within the 360 px and 390 px viewport with safe-area clearance and no horizontal overflow.
- Use native alert-dialog semantics: `role="alertdialog"`, `aria-modal="true"`, title and description associations, focus trapped inside the dialog, and initial focus on `取消`.
- Background page and drawer controls are inert and cannot receive pointer or keyboard input.

## Acceptance Checks

- Within two seconds the runner understands that `退出` ends the session but does not delete training data.
- The only dialog actions are `取消` and `退出`; there is no account deletion, duplicate logout action, or unrelated CTA.
- Cancelling, Android back, or tapping the modal scrim restores the exact open-drawer state.
- Confirming has one unambiguous outcome: exit the authenticated shell and return to authentication.
- Browser inspection at `360×800` and `390×844` reports no document overflow, zero blur/filter elements, no controls below 48 × 48 px, correct safe-area declarations, and an inert background.
