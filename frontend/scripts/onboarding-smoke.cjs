/**
 * Fully-real end-to-end onboarding smoke.
 *
 * Registers a throwaway user against the REAL auth + STRIDE backends, walks the
 * real onboarding wizard in a browser (real COROS watch login + real health
 * sync), asserts it reaches the dashboard, then deletes the user so the run
 * leaves no residue.
 *
 * Pipeline:
 *   1. (admin) login -> mint a single-use invite code      [Node fetch -> AUTH_BASE]
 *   2. register a unique throwaway user with that code      [Node fetch -> AUTH_BASE]
 *   3. inject the throwaway tokens into sessionStorage and
 *      drive /onboarding: COROS login -> profile -> sync    [browser -> /api proxy]
 *   4. assert dashboard renders (onboarding.completed_at set)
 *   5. DELETE /api/users/me (cascades auth user + data dir) [Node fetch -> API_BASE]
 *
 * Secrets come from <repoRoot>/.credentials.local and frontend/.env.local; the
 * script never prints email / password / token / invite values.
 *
 * Required keys in .credentials.local:
 *   email, password         STRIDE account used to mint invite codes (must be role=admin)
 *   coros_email, coros_password   real COROS account for the watch-login step
 * Optional:
 *   invite_code             skip admin minting and use this single-use code instead
 *   smoke_email_domain      domain for the generated throwaway email (default example.com)
 *
 * Run: cd frontend && npm run smoke:onboarding
 * Targets the PROD site (https://stride-running.cn) by default — it serves both
 * the SPA and same-origin /api, so no local dev server is needed. Override the
 * target with STRIDE_SMOKE_URL (e.g. a local dev server) if desired.
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const frontendRoot = path.resolve(__dirname, '..')

// Where to run the smoke. Pick a named target with STRIDE_SMOKE_TARGET
// (prod|local, default prod) or override the URL outright with STRIDE_SMOKE_URL.
const TARGET_URLS = { prod: 'https://stride-running.cn', local: 'http://127.0.0.1:5173' }
function resolveAppUrl() {
  if (process.env.STRIDE_SMOKE_URL) return process.env.STRIDE_SMOKE_URL
  const target = (process.env.STRIDE_SMOKE_TARGET || 'prod').toLowerCase()
  const url = TARGET_URLS[target]
  if (!url) {
    throw new Error(`unknown STRIDE_SMOKE_TARGET "${target}" (expected prod|local), or set STRIDE_SMOKE_URL`)
  }
  return url
}
const appUrl = resolveAppUrl().replace(/\/$/, '')

/** Parse a flat KEY=VALUE file (.env.local), preserving key case. */
function parseEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
    if (match) out[match[1]] = match[2]
  }
  return out
}

/**
 * Parse .credentials.local, which groups repeated email/password pairs under
 * `# <name> account` comment headers, e.g.
 *   # STRIDE account
 *   email = ...
 *   password = ...
 *   # Coros account
 *   email = ...
 *   password = ...
 * Returns { sections: { stride, coros, admin: {email,password} }, flat: {...} }.
 * `flat` keeps standalone keys (invite_code, smoke_email_domain).
 */
function parseCredentials(file) {
  const sections = {}
  const flat = {}
  let current = null
  if (!fs.existsSync(file)) return { sections, flat }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      const lower = trimmed.toLowerCase()
      // Switch section only on a header that names a known identity.
      if (lower.includes('coros')) current = 'coros'
      else if (lower.includes('admin')) current = 'admin'
      else if (lower.includes('stride')) current = 'stride'
      continue
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2]
    if ((key === 'email' || key === 'password') && current) {
      sections[current] = { ...sections[current], [key]: value }
    } else {
      flat[key] = value
    }
  }
  return { sections, flat }
}

function loadConfig() {
  const { sections, flat } = parseCredentials(path.join(repoRoot, '.credentials.local'))
  const env = parseEnvFile(path.join(frontendRoot, '.env.local'))

  // Admin identity mints invite codes. Prefer a dedicated admin account
  // (flat auth_email/auth_password or an "Auth admin" section), else fall back
  // to the STRIDE account.
  const adminEmail = flat.auth_email || (sections.admin || {}).email || (sections.stride || {}).email || ''
  const adminPassword = flat.auth_password || (sections.admin || {}).password || (sections.stride || {}).password || ''
  // Coros identity drives the watch-login step. Accept flat coros_* keys or a
  // "Coros account" section with bare email/password.
  const corosEmail = flat.coros_email || (sections.coros || {}).email || ''
  const corosPassword = flat.coros_password || (sections.coros || {}).password || ''

  // In .env.local the absolute auth URL is usually blank (the dev server proxies
  // /api/auth), so the real host lives in VITE_DEV_AUTH_PROXY — fall back to it.
  const authBase = (
    env.VITE_AUTH_BASE_URL || env.VITE_DEV_AUTH_PROXY ||
    process.env.VITE_AUTH_BASE_URL || ''
  ).replace(/\/$/, '')
  const clientId = env.VITE_AUTH_CLIENT_ID || process.env.VITE_AUTH_CLIENT_ID || ''

  const missing = []
  if (!adminEmail || !adminPassword) missing.push('an admin (auth_email/auth_password) or STRIDE account (in .credentials.local)')
  if (!corosEmail || !corosPassword) missing.push('a Coros account (in .credentials.local)')
  if (!authBase) missing.push('VITE_AUTH_BASE_URL (in frontend/.env.local)')
  if (!clientId) missing.push('VITE_AUTH_CLIENT_ID (in frontend/.env.local)')
  if (missing.length) {
    throw new Error(`onboarding smoke config missing:\n  - ${missing.join('\n  - ')}`)
  }

  return {
    adminEmail,
    adminPassword,
    corosEmail,
    corosPassword,
    inviteCode: flat.invite_code || '',
    emailDomain: flat.smoke_email_domain || 'example.com',
    authBase,
    clientId,
  }
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, data }
}

/** Admin-login then mint one single-use invite code. */
async function mintInviteCode(cfg) {
  const login = await postJson(`${cfg.authBase}/api/auth/login`, {
    email: cfg.adminEmail,
    password: cfg.adminPassword,
  }, { 'X-Client-Id': cfg.clientId })
  if (!login.ok || !login.data.access_token) {
    throw new Error(`admin login failed: HTTP ${login.status}`)
  }
  const mint = await postJson(`${cfg.authBase}/admin/invite-codes`, undefined, {
    Authorization: `Bearer ${login.data.access_token}`,
    'X-Client-Id': cfg.clientId,
  })
  if (mint.status === 401 || mint.status === 403) {
    throw new Error(
      `mint invite code rejected (HTTP ${mint.status}). The .credentials.local ` +
      `account is not an admin. Either grant it role=admin, or put a single-use ` +
      `invite_code=... line in .credentials.local.`,
    )
  }
  if (!mint.ok || !mint.data.code) {
    throw new Error(`mint invite code failed: HTTP ${mint.status}`)
  }
  return mint.data.code
}

/** Register a unique throwaway user; returns { userId, accessToken, refreshToken, email }. */
async function registerThrowaway(cfg, inviteCode) {
  const stamp = `${Date.now()}-${process.pid}`
  const email = `stride-onboarding-smoke+${stamp}@${cfg.emailDomain}`
  // Meets the register password policy: >=8, upper, lower, digit, special.
  const password = `Smoke-${stamp}-Aa1!`
  const res = await postJson(`${cfg.authBase}/api/auth/register`, {
    email,
    password,
    invite_code: inviteCode,
    name: 'onboarding-smoke',
  }, { 'X-Client-Id': cfg.clientId })
  if (res.status !== 201 || !res.data.access_token) {
    throw new Error(`register failed: HTTP ${res.status} (${res.data.error || res.data.detail || 'unknown'})`)
  }
  return {
    userId: res.data.user_id,
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    email,
  }
}

async function deleteThrowaway(accessToken) {
  // Hit /api/users/me on the target origin (same path the browser uses). Retry
  // a few times: right after a real sync the user's coros.db can be briefly
  // locked, which surfaces as a 500 from the local-dir cleanup. The auth user is
  // removed on the first call; the token still authenticates to STRIDE locally,
  // so retries just re-attempt the data-dir delete until it succeeds.
  let lastStatus = 0
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${appUrl}/api/users/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    lastStatus = res.status
    if (res.status === 204 || res.status === 404) return res.status
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
  }
  return lastStatus
}

async function runWizard(page, cfg, issues) {
  // Drive the real wizard. Steps advance via local state (OnboardingWizard.tsx),
  // so each onSuccess just needs its own API call to succeed against the backend.

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
    throw new Error(`COROS watch login failed: HTTP ${coros.status()} — check coros_email/coros_password`)
  }

  // Step 2 — profile.
  await page.getByText('完善个人资料').waitFor({ timeout: 20_000 })
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

async function main() {
  const cfg = loadConfig()
  const issues = []
  let throwaway = null
  let browser = null

  try {
    const inviteCode = cfg.inviteCode || (await mintInviteCode(cfg))
    throwaway = await registerThrowaway(cfg, inviteCode)
    console.log('Registered throwaway user; running onboarding wizard...')

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    // Seed auth before any app code runs so ProtectedRoute sees an authed user.
    await context.addInitScript(
      ([access, refresh]) => {
        sessionStorage.setItem('access_token', access)
        sessionStorage.setItem('refresh_token', refresh)
      },
      [throwaway.accessToken, throwaway.refreshToken],
    )
    const page = await context.newPage()
    page.on('console', (msg) => {
      if (msg.type() === 'error') issues.push(`console error: ${msg.text().slice(0, 300)}`)
    })
    page.on('pageerror', (err) => issues.push(`page error: ${err.message.slice(0, 300)}`))

    await page.goto(`${appUrl}/onboarding`, { waitUntil: 'domcontentloaded' })
    await page.getByText('选择你的手表').waitFor({ timeout: 30_000 })
    await runWizard(page, cfg, issues)

    const screenshotPath = path.join(process.env.TEMP || repoRoot, 'stride-onboarding-smoke.png')
    await page.screenshot({ path: screenshotPath, fullPage: false })
    console.log(`Screenshot: ${screenshotPath}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (throwaway) {
      const status = await deleteThrowaway(throwaway.accessToken).catch(() => 'error')
      if (status === 204) {
        console.log('Cleanup: throwaway user deleted (204).')
      } else {
        issues.push(`cleanup: DELETE /api/users/me returned ${status} — user ${throwaway.userId} may need manual removal`)
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`onboarding smoke found issues:\n${issues.join('\n')}`)
  }
  console.log(`Onboarding smoke OK: ${appUrl}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
