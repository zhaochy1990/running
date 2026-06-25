/**
 * Shared helpers for the prod onboarding E2E scripts (onboarding-smoke.cjs and
 * onboarding-negatives.cjs). Registers/deletes a real throwaway user against the
 * real auth + STRIDE backends and runs a scenario in a real browser — no mocks.
 *
 * Credentials come from <repoRoot>/.credentials.local and frontend/.env.local,
 * or env vars (so CI can inject GitHub secrets). Email/password/token/invite
 * values are never printed.
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const frontendRoot = path.resolve(__dirname, '..')

// Where to run. Pick a named target with STRIDE_SMOKE_TARGET (prod|local,
// default prod) or override the URL outright with STRIDE_SMOKE_URL.
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
 * `# <name> account` comment headers (STRIDE / Coros / Auth admin).
 * Returns { sections: { stride, coros, admin: {email,password} }, flat: {...} }.
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
      if (lower.includes('coros')) current = 'coros'
      else if (lower.includes('admin')) current = 'admin'
      else if (lower.includes('stride')) current = 'stride'
      continue
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    if ((key === 'email' || key === 'password') && current) {
      sections[current] = { ...sections[current], [key]: match[2] }
    } else {
      flat[key] = match[2]
    }
  }
  return { sections, flat }
}

/**
 * Resolve config. `requireCoros` defaults true (the happy-path smoke binds a
 * real watch); negative-path scenarios that never reach a successful watch
 * login pass false so absent COROS creds aren't a hard error.
 */
function loadConfig({ requireCoros = true } = {}) {
  const { sections, flat } = parseCredentials(path.join(repoRoot, '.credentials.local'))
  const env = parseEnvFile(path.join(frontendRoot, '.env.local'))

  // Each credential falls back to an env var so CI can inject GitHub secrets
  // without writing a .credentials.local file onto the runner.
  const adminEmail = flat.auth_email || (sections.admin || {}).email || (sections.stride || {}).email || process.env.STRIDE_SMOKE_ADMIN_EMAIL || ''
  const adminPassword = flat.auth_password || (sections.admin || {}).password || (sections.stride || {}).password || process.env.STRIDE_SMOKE_ADMIN_PASSWORD || ''
  const corosEmail = flat.coros_email || (sections.coros || {}).email || process.env.STRIDE_SMOKE_COROS_EMAIL || ''
  const corosPassword = flat.coros_password || (sections.coros || {}).password || process.env.STRIDE_SMOKE_COROS_PASSWORD || ''

  // In .env.local the absolute auth URL is usually blank (the dev server proxies
  // /api/auth), so the real host lives in VITE_DEV_AUTH_PROXY — fall back to it.
  const authBase = (
    env.VITE_AUTH_BASE_URL || env.VITE_DEV_AUTH_PROXY || process.env.VITE_AUTH_BASE_URL || ''
  ).replace(/\/$/, '')
  const clientId = env.VITE_AUTH_CLIENT_ID || process.env.VITE_AUTH_CLIENT_ID || ''

  const missing = []
  if (!adminEmail || !adminPassword) missing.push('an admin (auth_email/auth_password) or STRIDE account')
  if (requireCoros && (!corosEmail || !corosPassword)) missing.push('a Coros account')
  if (!authBase) missing.push('VITE_AUTH_BASE_URL / VITE_DEV_AUTH_PROXY')
  if (!clientId) missing.push('VITE_AUTH_CLIENT_ID')
  if (missing.length) {
    throw new Error(`onboarding e2e config missing:\n  - ${missing.join('\n  - ')}`)
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
      `mint invite code rejected (HTTP ${mint.status}). The admin account lacks ` +
      `role=admin, or set a single-use invite_code in .credentials.local.`,
    )
  }
  if (!mint.ok || !mint.data.code) {
    throw new Error(`mint invite code failed: HTTP ${mint.status}`)
  }
  return mint.data.code
}

/** Register a unique throwaway user; returns { userId, accessToken, refreshToken, email }. */
async function registerThrowaway(cfg) {
  const inviteCode = cfg.inviteCode || (await mintInviteCode(cfg))
  const stamp = `${Date.now()}-${process.pid}`
  const email = `stride-e2e+${stamp}@${cfg.emailDomain}`
  // Meets the register password policy: >=8, upper, lower, digit, special.
  const password = `Smoke-${stamp}-Aa1!`
  const res = await postJson(`${cfg.authBase}/api/auth/register`, {
    email, password, invite_code: inviteCode, name: 'stride-e2e',
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
  // Retry: right after a real sync the user's coros.db can be briefly locked,
  // surfacing as a 500 from the local-dir cleanup. The auth user is removed on
  // the first call; the token still authenticates to STRIDE locally, so retries
  // just re-attempt the data-dir delete until it succeeds.
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

/**
 * Register a throwaway user, open /onboarding in a real browser with the session
 * seeded, run `scenario({ page, cfg, issues, throwaway })`, then always
 * screenshot, close the browser, and delete the user. Throws if the scenario
 * pushed any issues. `requireCoros` is forwarded to loadConfig.
 */
async function runOnboardingScenario(
  { name, screenshot, requireCoros = true, captureConsoleErrors = true },
  scenario,
) {
  const cfg = loadConfig({ requireCoros })
  const issues = []
  let throwaway = null
  let browser = null
  let page = null

  try {
    throwaway = await registerThrowaway(cfg)
    console.log(`[${name}] registered throwaway user; opening /onboarding...`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(
      ([access, refresh]) => {
        sessionStorage.setItem('access_token', access)
        sessionStorage.setItem('refresh_token', refresh)
      },
      [throwaway.accessToken, throwaway.refreshToken],
    )
    page = await context.newPage()
    // Negative-path scenarios deliberately trigger 4xx responses, which the
    // browser logs as console errors — so console capture is opt-out. Uncaught
    // JS exceptions (pageerror) are always treated as failures.
    if (captureConsoleErrors) {
      page.on('console', (msg) => {
        if (msg.type() === 'error') issues.push(`console error: ${msg.text().slice(0, 300)}`)
      })
    }
    page.on('pageerror', (err) => issues.push(`page error: ${err.message.slice(0, 300)}`))

    await page.goto(`${appUrl}/onboarding`, { waitUntil: 'domcontentloaded' })
    await page.getByText('选择你的手表').waitFor({ timeout: 30_000 })
    await scenario({ page, cfg, issues, throwaway })
  } finally {
    if (page) {
      const screenshotPath = path.join(process.env.TEMP || repoRoot, screenshot || `stride-${name}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {})
      console.log(`[${name}] screenshot: ${screenshotPath}`)
    }
    if (browser) await browser.close().catch(() => {})
    if (throwaway) {
      const status = await deleteThrowaway(throwaway.accessToken).catch(() => 'error')
      if (status === 204 || status === 404) {
        console.log(`[${name}] cleanup: throwaway user deleted (${status}).`)
      } else {
        issues.push(`cleanup: DELETE /api/users/me returned ${status} — user ${throwaway.userId} may need manual removal`)
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`[${name}] found issues:\n${issues.join('\n')}`)
  }
  console.log(`[${name}] OK: ${appUrl}`)
}

module.exports = {
  appUrl,
  loadConfig,
  postJson,
  mintInviteCode,
  registerThrowaway,
  deleteThrowaway,
  runOnboardingScenario,
}
