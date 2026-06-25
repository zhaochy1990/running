/**
 * Onboarding negative-path E2E (real browser, no mocks).
 *
 * Registers a throwaway user, opens /onboarding, and asserts two failure-mode
 * behaviors, then deletes the user:
 *   1. Invalid COROS credentials -> real /coros/login 400 -> error shown and the
 *      wizard stays on the watch step (does not advance to profile).
 *   2. Logout escape hatch -> the 登出/切换账号 button clears the session and
 *      returns to /login (so a user can never be stuck in onboarding).
 *
 * No real COROS bind happens here (we use deliberately-wrong creds), so this is
 * fast and stable and needs no COROS account.
 *
 * Run: cd frontend && npm run smoke:onboarding-negatives
 */
const { runOnboardingScenario } = require('./onboarding-e2e-lib.cjs')

async function checkInvalidCorosLogin(page, issues) {
  await page.getByRole('button', { name: /COROS/ }).click()
  await page.locator('input[autocomplete="username"]').fill('stride-e2e-invalid@example.com')
  await page.locator('input[type="password"]').fill('definitely-the-wrong-password-1!')
  const respPromise = page.waitForResponse(
    (r) => r.url().includes('/api/users/me/coros/login'),
    { timeout: 60_000 },
  )
  await page.getByRole('button', { name: '连接账号' }).click()
  const resp = await respPromise
  if (resp.status() < 400) {
    issues.push(`expected COROS login to be rejected, got HTTP ${resp.status()}`)
  }
  // An error box should appear and the wizard must NOT advance to the profile step.
  await page.locator('div[class*="bg-red-500"]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  const errorShown = await page.locator('div[class*="bg-red-500"]').first().isVisible().catch(() => false)
  if (!errorShown) issues.push('no error shown after invalid COROS login')
  const advanced = await page.getByText('完善个人资料').isVisible().catch(() => false)
  if (advanced) issues.push('wizard advanced past watch step despite invalid COROS login')
}

async function checkLogoutEscapeHatch(page, issues) {
  const logout = page.getByTestId('onboarding-logout')
  if (!(await logout.isVisible().catch(() => false))) {
    issues.push('onboarding logout button not visible')
    return
  }
  await logout.click()
  await page.waitForURL((u) => u.pathname === '/login', { timeout: 20_000 }).catch(() => {})
  if (!page.url().includes('/login')) {
    issues.push(`logout did not return to /login (at ${page.url()})`)
  }
  const tokenCleared = await page.evaluate(() => sessionStorage.getItem('access_token') === null)
  if (!tokenCleared) issues.push('session not cleared after logout')
}

async function negatives({ page, issues }) {
  await checkInvalidCorosLogin(page, issues)
  await checkLogoutEscapeHatch(page, issues)
}

runOnboardingScenario(
  {
    name: 'onboarding-negatives',
    screenshot: 'stride-onboarding-negatives.png',
    requireCoros: false,
    // This scenario intentionally triggers 4xx responses (bad COROS login,
    // logout), so don't treat the browser's console resource errors as failures.
    captureConsoleErrors: false,
  },
  negatives,
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
