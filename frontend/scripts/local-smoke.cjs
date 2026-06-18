const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const appUrl = (process.env.STRIDE_LOCAL_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
const screenshotPath = path.join(process.env.TEMP || repoRoot, 'stride-local-smoke.png')

function readCredentials() {
  const file = path.join(repoRoot, '.credentials.local')
  const raw = fs.readFileSync(file, 'utf8')
  const values = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1].toLowerCase()] = match[2]
  }
  if (!values.email || !values.password) {
    throw new Error('.credentials.local must contain email and password')
  }
  return values
}

function sanitizeUrl(url) {
  return url.replace(/[?].*/, '')
}

async function main() {
  const { email, password } = readCredentials()
  const browser = await chromium.launch({ headless: true })
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
  await page.getByRole('heading', { name: '活动列表' }).waitFor({ timeout: 20_000 })
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
  await browser.close()

  if (issues.length > 0) {
    throw new Error(`local smoke found browser issues:\n${issues.join('\n')}`)
  }

  console.log(`Local smoke OK: ${appUrl}`)
  console.log(`Responses checked: ${responses.length}`)
  console.log(`Screenshot: ${screenshotPath}`)
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
