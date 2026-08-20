const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const frontendRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(frontendRoot, '..')
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const host = '127.0.0.1'
const fixturePort = 18083
const bffPort = 18082
const bffBase = `http://${host}:${bffPort}`

const structuredPlan = {
  content_version: 2,
  status: 'active',
  plan_id: 'fixture-structured',
  goal_id: 'fixture-goal',
  revision: 7,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
  plan: {
    goal: {
      goal_id: 'fixture-goal',
      race_name: 'BFF 结构化测试马拉松',
      distance: 'FM',
      race_date: '2026-10-11',
      target_time: '03:15:00',
      timezone: 'Asia/Shanghai',
      location: null,
    },
    start_date: '2026-05-04',
    end_date: '2026-10-11',
    total_weeks: 23,
    phases: [{
      id: 'fixture-phase',
      name: '专项期',
      start_date: '2026-05-04',
      end_date: '2026-10-11',
      focus: '马拉松专项耐力',
      weekly_distance_km_low: 45,
      weekly_distance_km_high: 55,
      key_session_types: ['阈值跑'],
      milestone_ids: ['fixture-milestone'],
    }],
    milestones: [{
      id: 'fixture-milestone',
      type: 'race',
      date: '2026-10-11',
      phase_id: 'fixture-phase',
      target: '完成目标马拉松',
      completed_actual: null,
    }],
    weeks: [],
    training_principles: ['循序渐进'],
    generated_by: 'fixture',
    current_phase_id: 'fixture-phase',
    current_week_number: 15,
    next_milestone: {
      id: 'fixture-milestone',
      date: '2026-10-11',
      target: '完成目标马拉松',
      days_until: 62,
    },
  },
}

const markdownPlan = {
  content_version: 1,
  status: 'active',
  plan_id: 'fixture-markdown',
  goal_id: 'fixture-goal',
  revision: null,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
  plan: '# BFF Markdown 赛季计划\n\n- 保持有氧基础\n- 每周安排一次长跑',
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function requestMode(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).fixture_mode || ''
  } catch {
    return ''
  }
}

function createFixtureServer() {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/users/me/profile') {
      return json(res, 200, {
        id: 'fixture-user',
        display_name: 'Fixture Runner',
        profile: {},
        onboarding: { watch_ready: true, profile_ready: true, completed_at: '2026-05-01T00:00:00Z' },
        features: { coach_agent_weekly_plan: false, coach_chat: false },
      })
    }
    if (req.method === 'GET' && req.url === '/api/users/fixture-user/master-plan/current') {
      const mode = requestMode(req)
      if (mode === 'structured') return json(res, 200, structuredPlan)
      if (mode === 'markdown') return json(res, 200, markdownPlan)
      if (mode === 'none') return json(res, 404, { detail: 'not found' })
      if (mode === 'error') return json(res, 500, { error: 'fixture error' })
      return json(res, 400, { error: 'unknown fixture mode' })
    }
    return json(res, 404, { detail: 'fixture route not found' })
  })
}

function fixtureJwt(mode) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'fixture-user', fixture_mode: mode, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist") || !fs.existsSync(systemChrome)) throw error
    return chromium.launch({ headless: true, executablePath: systemChrome })
  }
}

async function waitForBff(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`fixture BFF exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${bffBase}/healthz`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('fixture BFF did not become ready')
}

async function assertScenario(browser, mode, assertion) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const currentRequests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/users/fixture-user/master-plan/current') currentRequests.push(request.url())
  })
  await page.addInitScript(({ jwt }) => {
    sessionStorage.setItem('access_token', jwt)
    sessionStorage.setItem('refresh_token', 'fixture-refresh')
  }, { jwt: fixtureJwt(mode) })
  await page.goto(`${bffBase}/plan`, { waitUntil: 'domcontentloaded' })
  await assertion(page)
  if (currentRequests.length !== 1) {
    throw new Error(`${mode}: expected one current-plan request, got ${currentRequests.length}`)
  }
  await page.close()
}

async function main() {
  const fixture = createFixtureServer()
  fixture.listen(fixturePort, host)
  await once(fixture, 'listening')

  const bff = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: frontendRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(bffPort),
      STATIC_DIR: path.join(frontendRoot, 'dist'),
      STRENGTH_DIR: path.join(repoRoot, 'strength_illustrations', 'output'),
      PYTHON_API_URL: `http://${host}:${fixturePort}`,
      GO_API_URL: `http://${host}:${fixturePort}`,
      AUTH_UPSTREAM_URL: `http://${host}:${fixturePort}`,
      STRIDE_ROUTE_GET_USERS_USER_ID_MASTER_PLAN_CURRENT: 'go',
    },
  })
  let bffOutput = ''
  bff.stdout.on('data', (chunk) => { bffOutput += chunk.toString() })
  bff.stderr.on('data', (chunk) => { bffOutput += chunk.toString() })

  let browser
  try {
    await waitForBff(bff)
    browser = await launchBrowser()
    await assertScenario(browser, 'structured', async (page) => {
      await page.getByRole('heading', { name: 'BFF 结构化测试马拉松' }).waitFor()
      if (await page.getByText(/revision|修订号|v7/i).count()) throw new Error('structured: revision is visible')
    })
    await assertScenario(browser, 'markdown', async (page) => {
      await page.getByRole('heading', { name: 'BFF Markdown 赛季计划' }).waitFor()
      await page.getByText('保持有氧基础').waitFor()
    })
    await assertScenario(browser, 'none', async (page) => {
      await page.getByRole('heading', { name: '创建你的赛季计划', exact: true }).first().waitFor()
    })
    await assertScenario(browser, 'error', async (page) => {
      await page.getByRole('heading', { name: '无法读取赛季训练计划' }).waitFor()
      if (await page.getByRole('heading', { name: '创建你的赛季计划', exact: true }).count()) {
        throw new Error('error: rendered creation state')
      }
    })
    console.log('Current plan fixture smoke OK: structured, Markdown, no-plan, read-error')
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nBFF output:\n${bffOutput}`)
  } finally {
    if (browser) await browser.close()
    bff.kill('SIGTERM')
    fixture.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
