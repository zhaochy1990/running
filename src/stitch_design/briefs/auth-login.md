# Screen

Name: `Authentication Login`
Route: `/v2/auth/login`
State: `signed_out, email_password selected, ready to submit`

## User Goal

The runner signs in securely with either email and password or a mainland China mobile number and SMS verification code, without leaving the page or having to understand two separate flows.

## Required Content

- A focused, edge-to-edge authentication screen with no bottom navigation. Respect the top status safe area and bottom gesture safe area.
- A restrained STRIDE identity near the top: compact route-mark icon, `STRIDE`, and the concise welcome copy `欢迎回来` / `继续你的训练计划`.
- A two-option segmented control directly above the form: `邮箱登录` and `手机号登录`. The selected option must be indicated by label, surface, and position, not color alone. Default to `邮箱登录`.
- Email mode contains exactly:
  - label `邮箱` and input example `runner@example.com` with email keyboard semantics;
  - label `密码`, masked input placeholder `输入密码`, a 48 px eye visibility action, and text action `忘记密码？`;
  - primary CTA `登录`.
- Mobile mode is available through the same segmented control and replaces the two email fields with:
  - label `手机号`; fixed country code prefix `+86`; input placeholder `请输入手机号`;
  - label `验证码`; numeric input placeholder `6 位验证码`; inline secondary action `获取验证码` with a distinct 48 px touch target;
  - after sending, the secondary action becomes a disabled textual countdown such as `52 秒后重发`; this state must not rely on color alone;
  - primary CTA remains `登录`.
- A quiet account action below the primary CTA: `还没有账号？创建账号`.
- A compact legal line anchored near the bottom: `登录即表示你同意《服务条款》和《隐私政策》`.
- Preserve enough vertical room for an inline form error without causing the primary CTA to jump off the first 390 x 844 viewport. Example errors are `邮箱或密码错误` and `验证码错误或已过期`.

## Actions

- Primary: validate the currently selected credential method and sign in.
- Secondary: switch credential method, show or hide password, recover password, request or resend an SMS code, create an account, and open legal documents.

## Navigation

- Entry comes from `/v2/auth/start`, an expired session, or a protected deep link.
- A 48 px back action returns to `/v2/auth/start`. It must not resemble a bottom-tab navigation control.
- Successful sign-in continues to `/v2/onboarding/brand` when the account is incomplete; otherwise it enters `跑者` at `/v2/home`.
- Account creation opens `/v2/auth/register`; password recovery opens `/v2/auth/forgot-password`; legal documents open `https://stride-running.cn/terms` and `https://stride-running.cn/privacy`.
- No bottom navigation, side menu, or authenticated app chrome appears on this screen.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation without page-specific color or font overrides.
- Keep one visually dominant action: the near-white pill `登录` button. Coral is limited to the compact STRIDE route mark or a tiny active punctuation mark, never a full coral form or decorative background.
- Inputs use canvas-dark fill, subtle translucent borders, 8 px radius, and a visible blue focus ring. Do not place the entire form inside a large floating card.
- Use Simplified Chinese for all user-facing copy. Do not show OAuth, social login, QR-code login, watch-provider login, guest mode, promotional claims, running illustrations, gradients, glass blur, or decorative metric cards.
- Do not expose whether an unregistered phone number exists before SMS verification. SMS request feedback remains generic.
- Loading replaces the CTA label with `登录中…` and disables form submission. Invalid and offline states use an icon plus concise text, never color alone.
- Every segmented option, field action, link, and button has an actual non-overlapping semantic touch target of at least 48 x 48 logical px. This explicitly includes `忘记密码？`, password visibility, `获取验证码`, `52 秒后重发`, `创建账号`, `《服务条款》`, and `《隐私政策》`; compact text may remain visually small inside the larger hit box.

## Acceptance Checks

- Within five seconds, the user can identify both supported login methods and the currently selected method.
- Default email mode shows email, password, password visibility, password recovery, and one `登录` CTA above the fold at 390 x 844.
- Switching to mobile mode preserves the screen hierarchy and exposes `+86`, phone number, six-digit code, and `获取验证码` without horizontal crowding at 360 px.
- The CTA, fields, mode switch, create-account action, and legal text remain reachable with keyboard and larger system text.
- The page has no horizontal overflow at 360 px or 390 px, and safe-area spacing remains correct.
- Browser geometry reports at least 48 px width and height for each compact text action and icon button, with no overlapping adjacent hit areas.
- Inter is used for interface copy. Any countdown digits use Geist Mono with tabular numerals.
- Focus, disabled, loading, error, offline, and SMS countdown states remain understandable without color.
