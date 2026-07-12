/**
 * Shared helpers for the prod onboarding E2E scripts (onboarding-smoke.cjs and
 * onboarding-negatives.cjs). Registers/deletes a real throwaway user against the
 * real auth + STRIDE backends and runs a scenario in a real browser — no mocks.
 *
 * Credentials come from <repoRoot>/.credentials.local and frontend/.env.local,
 * the main workspace fallback, or env vars (so CI can inject GitHub secrets).
 * Email/password/token/invite values are never printed.
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const frontendRoot = path.resolve(__dirname, '..')
const workspaceRoot = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'workspace', 'running')
  : null

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

function parseFirstEnvFile(files) {
  const file = files.filter(Boolean).find((candidate) => fs.existsSync(candidate))
  return file ? parseEnvFile(file) : {}
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

function parseFirstCredentials(files) {
  const file = files.filter(Boolean).find((candidate) => fs.existsSync(candidate))
  return parseCredentials(file || '')
}

/**
 * Resolve config. `requireCoros` defaults true (the happy-path smoke binds a
 * real watch); negative-path scenarios that never reach a successful watch
 * login pass false so absent COROS creds aren't a hard error.
 */
function loadConfig({ requireCoros = true } = {}) {
  const { sections, flat } = parseFirstCredentials([
    path.join(repoRoot, '.credentials.local'),
    process.env.STRIDE_CREDENTIALS_FILE,
    workspaceRoot ? path.join(workspaceRoot, '.credentials.local') : null,
  ])
  const env = parseFirstEnvFile([
    path.join(frontendRoot, '.env.local'),
    process.env.STRIDE_FRONTEND_ENV_FILE,
    workspaceRoot ? path.join(workspaceRoot, 'frontend', '.env.local') : null,
  ])

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

function isLocalAppUrl() {
  try {
    const url = new URL(appUrl)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function safeRemoveInside(baseDir, targetPath) {
  const base = path.resolve(baseDir)
  const target = path.resolve(targetPath)
  const rel = path.relative(base, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to remove outside ${base}: ${target}`)
  }
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 })
  }
}

async function retryLocalRemove(baseDir, targetPath) {
  let lastError = null
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      safeRemoveInside(baseDir, targetPath)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw lastError
}

function pruneLocalNotificationRows(userId) {
  const file = path.join(repoRoot, 'data', '.notifications.json')
  if (!fs.existsSync(file)) return
  let data = null
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  }
  for (const section of ['devices', 'prefs', 'read_state', 'notifications']) {
    if (data[section] && typeof data[section] === 'object') delete data[section][userId]
  }
  const hasRows = ['devices', 'prefs', 'read_state', 'notifications'].some(
    (section) => data[section] && typeof data[section] === 'object' && Object.keys(data[section]).length > 0,
  )
  if (hasRows) fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  else fs.rmSync(file, { force: true })
}

function removeIfEmpty(dir) {
  if (!fs.existsSync(dir)) return
  try {
    if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    // Best-effort cleanup only; active local workers may recreate these dirs.
  }
}

function pruneLocalQueueMessages(userId) {
  const queuesDir = path.join(repoRoot, 'data', '_jobs_dev', 'queues')
  if (!fs.existsSync(queuesDir)) return
  for (const queueName of fs.readdirSync(queuesDir)) {
    const queueDir = path.join(queuesDir, queueName)
    if (!fs.statSync(queueDir).isDirectory()) continue
    for (const name of fs.readdirSync(queueDir)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(queueDir, name)
      try {
        const message = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (message.partition_key === userId) safeRemoveInside(queueDir, file)
      } catch {
        // Ignore malformed dev queue files; the worker will skip them too.
      }
    }
  }
}

async function cleanupLocalThrowawayData(userId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId)) {
    throw new Error(`refusing local cleanup for invalid user id: ${userId}`)
  }
  const dataDir = path.join(repoRoot, 'data')
  await retryLocalRemove(dataDir, path.join(dataDir, userId))
  await retryLocalRemove(dataDir, path.join(dataDir, '_jobs_dev', 'state', userId))
  await retryLocalRemove(dataDir, path.join(dataDir, '_jobs_dev', 'pipeline_runs', userId))
  pruneLocalQueueMessages(userId)
  pruneLocalNotificationRows(userId)
  const jobsDir = path.join(dataDir, '_jobs_dev')
  removeIfEmpty(path.join(jobsDir, 'state'))
  removeIfEmpty(path.join(jobsDir, 'pipeline_runs'))
  for (const queueName of ['stridejobs', 'stridejobs-poison']) removeIfEmpty(path.join(jobsDir, 'queues', queueName))
  removeIfEmpty(path.join(jobsDir, 'queues'))
  removeIfEmpty(jobsDir)
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

async function deleteThrowawayViaAuthService(accessToken, cfg) {
  try {
    const res = await fetch(`${cfg.authBase}/api/users/me`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Client-Id': cfg.clientId,
      },
    })
    return res.status
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    return `auth-service error: ${message}`
  }
}

async function deleteThrowaway(accessToken, cfg, userId) {
  // Retry: right after a real sync the user's coros.db can be briefly locked,
  // surfacing as a 500 from the local-dir cleanup. The auth user is removed on
  // the first call; the token still authenticates to STRIDE locally, so retries
  // just re-attempt the data-dir delete until it succeeds.
  let lastStatus = 0
  const local = isLocalAppUrl()
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${appUrl}/api/users/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    lastStatus = res.status
    if (res.status === 204 || res.status === 404) return res.status
    if (local && res.status === 503) break
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
  }
  if (!local) return lastStatus

  // Local STRIDE often runs without auth_service.base_url, so its account
  // delete endpoint cannot forward to auth-service. The E2E harness already
  // knows that auth URL, so finish cleanup directly and remove only this
  // throwaway user's local files.
  const authStatus = await deleteThrowawayViaAuthService(accessToken, cfg)
  if (![204, 401, 404].includes(authStatus)) return `auth-service ${authStatus}`
  await cleanupLocalThrowawayData(userId)
  return 'local-fallback'
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
      const status = await deleteThrowaway(throwaway.accessToken, cfg, throwaway.userId).catch((error) => {
        const message = error && error.message ? error.message : String(error)
        return `error: ${message}`
      })
      if (status === 204 || status === 404 || status === 'local-fallback') {
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
