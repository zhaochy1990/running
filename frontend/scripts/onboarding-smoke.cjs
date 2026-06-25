/**
 * Fully-real end-to-end onboarding smoke (happy path).
 *
 * Registers a throwaway user, walks the real onboarding wizard in a browser
 * (real COROS watch login + real health sync), asserts the dashboard renders,
 * then deletes the user. Shared register/cleanup/browser plumbing lives in
 * onboarding-e2e-lib.cjs. No mocks.
 *
 * Run: cd frontend && npm run smoke:onboarding
 * Targets prod by default; STRIDE_SMOKE_TARGET=prod|local or STRIDE_SMOKE_URL.
 * Credentials: .credentials.local / frontend/.env.local, or env vars (CI).
 */
const { runOnboardingScenario } = require('./onboarding-e2e-lib.cjs')

async function runWizard({ page, cfg, issues }) {
  // Steps advance via local state (OnboardingWizard.tsx), so each onSuccess just
  // needs its own API call to succeed against the backend.

  // Step 1 — watch: pick COROS, enter real credentials, connect.
  await page.getByRole('button', { name: /COROS/ }).click()
  await page.locator('input[autocomplete="username"]').fill(cfg.corosEmail)
  await page.locator('input[type="password"]').fill(cfg.corosPassword)
  const corosResp = page.waitForResponse(
    (r) => r.url().includes('/api/users/me/coros/login'),
    { timeout: 60_000 },
  )
  await page.getByRole('button', { name: '连接账号' }).click()
  const coros = await corosResp
  if (coros.status() >= 400) {
    throw new Error(`COROS watch login failed: HTTP ${coros.status()} — check coros credentials`)
  }

  // Step 2 — profile. First confirm an empty submit can't bypass the form (the
  // required-field gate), then fill valid values and continue.
  await page.getByText('完善个人资料').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '保存并继续' }).click()
  if (!(await page.getByText('完善个人资料').isVisible().catch(() => false))) {
    issues.push('empty profile submit advanced past the form (required-field gate missing)')
  }
  await page.locator('input[type="text"]').first().fill('Onboarding Smoke')
  await page.locator('input[type="date"]').fill('1990-01-01')
  await page.locator('select').selectOption('male')
  await page.locator('input[type="number"]').nth(0).fill('175')
  await page.locator('input[type="number"]').nth(1).fill('68')
  await page.getByRole('button', { name: '保存并继续' }).click()

  // Step 3 — confirm + real health sync; the page polls sync-status to 'done'
  // then navigates to '/'. health-only sync is fast but allow generous time.
  await page.getByRole('button', { name: '开始使用 STRIDE' }).click()
  await page.waitForURL((url) => url.pathname === '/', { timeout: 180_000 })

  // OnboardingGate re-fetches the profile and either renders the dashboard
  // (completed_at set) or redirects back to /onboarding. The dashboard nav only
  // mounts on success, so waiting for it avoids racing the gate's redirect.
  await page.locator('nav').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  if (page.url().includes('/onboarding')) {
    issues.push('bounced back to /onboarding — completed_at was not set')
  } else if (!(await page.locator('nav').first().isVisible().catch(() => false))) {
    issues.push('dashboard nav did not render after onboarding')
  }
}

runOnboardingScenario(
  { name: 'onboarding-smoke', screenshot: 'stride-onboarding-smoke.png', requireCoros: true },
  runWizard,
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
