/**
 * Fully-real end-to-end onboarding smoke (happy path).
 *
 * Registers a throwaway user, walks the real onboarding wizard in a browser
 * (real COROS watch login + real health sync), asserts the dashboard renders,
 * verifies the async onboarding pipeline through the notification center, then
 * confirms the synced data appears in activities and training status before
 * deleting the user. Shared register/cleanup/browser plumbing lives in
 * onboarding-e2e-lib.cjs. No mocks.
 *
 * Run: cd frontend && npm run smoke:onboarding
 * Targets prod by default; STRIDE_SMOKE_TARGET=prod|local or STRIDE_SMOKE_URL.
 * Credentials: .credentials.local / frontend/.env.local, or env vars (CI).
 */
const { appUrl, runOnboardingScenario } = require('./onboarding-e2e-lib.cjs')

const ONBOARDING_NOTIFICATION_ID = 'onboarding-progress'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fatal(message) {
  const error = new Error(message)
  error.fatal = true
  return error
}

async function apiGet(page, path) {
  const result = await page.evaluate(async (apiPath) => {
    const res = await fetch(`/api${apiPath}`, {
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem('access_token') || ''}`,
      },
    })
    const text = await res.text()
    let data = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    return { ok: res.ok, status: res.status, data }
  }, path)
  if (!result.ok) {
    throw new Error(`GET /api${path} failed: HTTP ${result.status}`)
  }
  return result.data
}

async function waitForCondition(label, fn, { timeoutMs = 240_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      if (error?.fatal) throw error
      lastError = error
    }
    await sleep(intervalMs)
  }
  const suffix = lastError ? ` Last error: ${lastError.message || lastError}` : ''
  throw new Error(`Timed out waiting for ${label}.${suffix}`)
}

function onboardingNotification(inbox) {
  return (inbox.notifications || []).find((n) => n.id === ONBOARDING_NOTIFICATION_ID)
}

async function currentUserId(page) {
  const profile = await apiGet(page, '/users/me/profile')
  if (!profile.id) throw new Error('/users/me/profile did not return id')
  return encodeURIComponent(profile.id)
}

async function refreshNotificationsThroughUi(page) {
  const trigger = page.getByTestId('message-center-trigger')
  const panel = page.getByTestId('message-center-panel')
  if (await panel.isVisible().catch(() => false)) {
    await trigger.click()
    await panel.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  }
  await trigger.click()
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  return panel
}

async function expectSyncingNotification(page) {
  await waitForCondition(
    'onboarding syncing notification',
    async () => {
      const inbox = await apiGet(page, '/users/me/notifications')
      const notification = onboardingNotification(inbox)
      const state = notification?.metadata?.state
      const body = notification?.body || ''
      if (state === 'failed') throw fatal(`onboarding notification failed: ${body}`)
      return notification && state === 'running' && /正在同步你的数据|正在分析你的数据|已完成数据同步/.test(body)
        ? notification
        : null
    },
    { timeoutMs: 180_000, intervalMs: 3_000 },
  )

  const panel = await refreshNotificationsThroughUi(page)
  await panel.getByText('STRIDE 初始化').waitFor({ timeout: 10_000 })
  await panel.getByText(/正在同步你的数据|正在分析你的数据|已完成数据同步/).waitFor({ timeout: 10_000 })
}

async function waitForPipelineDone(page) {
  return waitForCondition(
    'onboarding async pipeline completion',
    async () => {
      const status = await apiGet(page, '/users/me/onboarding/pipeline-status')
      if (status.state === 'failed') {
        throw fatal(`onboarding pipeline failed: ${status.error || 'unknown error'}`)
      }
      return status.state === 'done' ? status : null
    },
    { timeoutMs: 15 * 60_000, intervalMs: 10_000 },
  )
}

async function expectCompletedNotification(page) {
  await waitForCondition(
    'onboarding completion notification',
    async () => {
      const inbox = await apiGet(page, '/users/me/notifications')
      const notification = onboardingNotification(inbox)
      const state = notification?.metadata?.state
      const progress = notification?.progress_pct
      if (state === 'failed') throw fatal(`onboarding notification failed: ${notification.body}`)
      return notification && state === 'done' && progress === 100 && /已完成数据同步/.test(notification.body || '')
        ? notification
        : null
    },
    { timeoutMs: 120_000, intervalMs: 3_000 },
  )

  const panel = await refreshNotificationsThroughUi(page)
  await panel.getByText('STRIDE 初始化').waitFor({ timeout: 10_000 })
  await panel.getByText(/已完成数据同步/).waitFor({ timeout: 10_000 })
}

async function expectActivitiesData(page, issues) {
  const userId = await currentUserId(page)
  await page.goto(`${appUrl}/activities`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '活动列表' }).waitFor({ timeout: 30_000 })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})

  const activityPage = await apiGet(page, `/${userId}/activities?limit=1`)
  if (!activityPage.total || !Array.isArray(activityPage.activities) || activityPage.activities.length === 0) {
    issues.push('activities page/API did not expose synced activities after onboarding pipeline completion')
  }
  const rowCount = await page.locator('a[href^="/activity/"]').count()
  if (rowCount === 0) issues.push('activities page rendered without any activity rows after sync')
}

async function expectTrainingStatusData(page, issues) {
  const userId = await currentUserId(page)
  await page.goto(`${appUrl}/training-status`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '训练状态' }).waitFor({ timeout: 40_000 })
  await page.getByText('训练负荷（STRIDE）').waitFor({ timeout: 40_000 })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})

  const load = await apiGet(page, `/${userId}/stride/training-load?days=112`)
  if (!load.current || !Array.isArray(load.series) || load.series.length === 0) {
    issues.push('training status API returned no STRIDE training-load rows after onboarding pipeline completion')
  }
  if (await page.getByText('暂无训练负荷数据').isVisible().catch(() => false)) {
    issues.push('training status page still shows empty training-load state after onboarding pipeline completion')
  }
  await page.getByText('Training load latest:').waitFor({ timeout: 10_000 })
}

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
  // then navigates to '/'. The full historical sync continues in the async
  // onboarding pipeline started by watch login.
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

  await expectSyncingNotification(page)
  await waitForPipelineDone(page)
  await expectCompletedNotification(page)
  await expectActivitiesData(page, issues)
  await expectTrainingStatusData(page, issues)
}

runOnboardingScenario(
  { name: 'onboarding-smoke', screenshot: 'stride-onboarding-smoke.png', requireCoros: true },
  runWizard,
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
