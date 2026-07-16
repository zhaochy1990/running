const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const appUrl = (process.env.STRIDE_LOCAL_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
const screenshotPath = path.join(process.env.TEMP || repoRoot, 'stride-local-smoke.png')
const weeklyScreenshotPath = path.join(process.env.TEMP || repoRoot, 'stride-weekly-plan-smoke.png')
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function readCredentials() {
  const candidates = [
    path.join(repoRoot, '.credentials.local'),
    process.env.STRIDE_CREDENTIALS_FILE,
    process.env.HOME
      ? path.join(process.env.HOME, 'workspace', 'running', '.credentials.local')
      : null,
  ].filter(Boolean)
  const file = candidates.find((candidate) => fs.existsSync(candidate))
  if (!file) {
    throw new Error('.credentials.local not found')
  }
  const raw = fs.readFileSync(file, 'utf8')
  const values = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1].toLowerCase()] = match[2]
  }
  const email = values.email || values.user_email
  const password = values.password || values.user_password
  if (!email || !password) {
    throw new Error('.credentials.local must contain email/password or user_email/user_password')
  }
  return { email, password }
}

function sanitizeUrl(url) {
  return url.replace(/[?].*/, '')
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function assertCurrentWeekUrl(url) {
  const folder = decodeURIComponent(new URL(url).pathname.replace(/^\/week\//, ''))
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/.exec(folder)
  if (!match) throw new Error(`weekly plan did not redirect to a dated week: ${folder}`)
  const startYear = Number(match[1].slice(0, 4))
  const startMonthDay = match[1].slice(5)
  const endMonthDay = `${match[2]}-${match[3]}`
  const endYear = endMonthDay < startMonthDay ? startYear + 1 : startYear
  const end = `${endYear}-${endMonthDay}`
  const today = shanghaiToday()
  if (today < match[1] || today > end) {
    throw new Error(`weekly plan opened ${match[1]}..${end} instead of current Shanghai week (${today})`)
  }
}

async function main() {
  const { email, password } = readCredentials()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist") || !fs.existsSync(systemChrome)) {
      throw error
    }
    browser = await chromium.launch({ headless: true, executablePath: systemChrome })
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const issues = []
  const responses = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      issues.push(`console error: ${msg.text().slice(0, 300)}`)
    }
  })
  page.on('pageerror', (error) => {
    issues.push(`page error: ${error.message.slice(0, 300)}`)
  })
  page.on('requestfailed', (request) => {
    const url = request.url()
    if (request.failure()?.errorText === 'net::ERR_ABORTED') {
      return
    }
    if (url.includes('/api/') || url.includes('/auth/')) {
      issues.push(`request failed: ${sanitizeUrl(url)} ${request.failure()?.errorText || ''}`)
    }
  })
  page.on('response', (response) => {
    const url = response.url()
    if (url.includes('/api/auth/login') || url.includes('/api/users') || url.includes('/activities')) {
      responses.push(`${response.status()} ${sanitizeUrl(url)}`)
      if (response.status() >= 400) {
        issues.push(`HTTP ${response.status()}: ${sanitizeUrl(url)}`)
      }
    }
  })

  await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' })
  // Login is now a modal overlay on the landing page; scope to the dialog so the
  // nav/footer "登录" buttons on the landing page don't collide with the submit button.
  const loginDialog = page.getByRole('dialog', { name: '登录 STRIDE' })
  await loginDialog.locator('input[type="email"]').fill(email)
  await loginDialog.locator('input[type="password"]').fill(password)
  await loginDialog.getByRole('button', { name: /^登录$/ }).click()
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

  const hasToken = await page.evaluate(() => Boolean(sessionStorage.getItem('access_token')))
  if (!hasToken) throw new Error('login completed without access_token')

  await page.goto(`${appUrl}/activities`, { waitUntil: 'domcontentloaded' })
  try {
    await page.getByRole('heading', { name: '活动列表' }).waitFor({ timeout: 20_000 })
  } catch {
    await page.screenshot({ path: screenshotPath, fullPage: false })
    const state = await page.evaluate(() => ({
      path: window.location.pathname,
      loadingError: document.body.innerText.includes('加载失败，请检查网络后重试'),
      onboarding: window.location.pathname.startsWith('/onboarding'),
    }))
    throw new Error(
      `activity page did not load: path=${state.path}, loading_error=${state.loadingError}, onboarding=${state.onboarding}; ` +
      `responses=${responses.join(', ') || 'none'}; issues=${issues.join(' | ') || 'none'}; screenshot=${screenshotPath}`,
    )
  }
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

  const notificationClose = page.getByRole('button', { name: '关闭' })
  if (await notificationClose.isVisible().catch(() => false)) {
    await notificationClose.click()
    await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  }

  const rows = page.locator('a[href^="/activity/"]')
  const rowCount = await rows.count()
  if (rowCount === 0) throw new Error('activity list loaded but no activity rows were found')

  await rows.first().click()
  await page.waitForURL((url) => url.pathname.startsWith('/activity/'), { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await page.locator('text=距离').first().waitFor({ timeout: 20_000 })

  await page.screenshot({ path: screenshotPath, fullPage: false })

  await page.goto(`${appUrl}/`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '本周课表' }).waitFor({ timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  assertCurrentWeekUrl(page.url())

  const weeklyTabs = page.getByRole('tab')
  if (await weeklyTabs.count() !== 4) {
    throw new Error('weekly plan did not render exactly four tabs')
  }
  const tabChecks = [
    ['weekly-plan-tab-schedule', null],
    ['weekly-plan-tab-strength', null],
    ['weekly-plan-tab-records', '本周训练记录'],
    ['weekly-plan-tab-feedback', '围绕本周关键课记录体感'],
  ]
  for (const [id, expectedHeading] of tabChecks) {
    const tab = page.locator(`#${id}`)
    if (await tab.count() !== 1) throw new Error(`weekly plan tab missing: ${id}`)
    await tab.click()
    if (await tab.getAttribute('aria-selected') !== 'true') {
      throw new Error(`weekly plan tab did not activate: ${id}`)
    }
    const panel = page.getByRole('tabpanel')
    await panel.waitFor({ timeout: 10_000 })
    if (!(await panel.innerText()).trim()) {
      throw new Error(`weekly plan tab rendered no content: ${id}`)
    }
    if (expectedHeading) {
      await page.getByRole('heading', { name: expectedHeading }).waitFor({ timeout: 10_000 })
    }
  }
  await page.screenshot({ path: weeklyScreenshotPath, fullPage: false })
  await browser.close()

  if (issues.length > 0) {
    throw new Error(`local smoke found browser issues:\n${issues.join('\n')}`)
  }

  console.log(`Local smoke OK: ${appUrl}`)
  console.log(`Responses checked: ${responses.length}`)
  console.log(`Screenshot: ${screenshotPath}`)
  console.log(`Weekly screenshot: ${weeklyScreenshotPath}`)
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
