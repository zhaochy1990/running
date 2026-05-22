#!/usr/bin/env node
// Prod smoke test for the Health page.
//
// Logs into the deployed stride-app, navigates to /health, and verifies that
// the WatchExtrasSection renders correctly for the configured user — i.e.
// the HRV trend chart shows up, the cards that the user *should* see are
// present, and the ones they shouldn't (e.g. Sleep / Body Battery / Stress
// for a COROS user) are absent. Full-page + section screenshots are written
// for human review.
//
// Why standalone instead of vitest/playwright-test? Vitest already covers
// component-level rendering inside `frontend/src/pages/__tests__/`; this is
// a *prod-only* check that hits the real backend + the deployed bundle.
// Keeping it as a plain Node script means it can be invoked from any host
// with chromium + playwright installed, without needing a vite dev server.
//
// Usage:
//
//   STRIDE_PROD_URL=https://stride-app.<region>.azurecontainerapps.io \
//   PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome \
//   node tests/e2e/prod-health-check.mjs [--no-screenshots] [--profile <name>]
//
// Credentials are read from `.credentials.local` in the repo root (the
// default) or `.credentials.<name>.local` when `--profile <name>` is set.
// Both formats match the convention documented in `docs/auth-wiring.md`
// and are git-ignored. Format:
//
//   email=you@example.com
//   password=...
//
// `--profile zhaochaoyi` exercises the COROS code path; `--profile
// dingchentao` exercises Garmin. Maintain one named file per provider
// for ongoing regression coverage.
//
// Exit codes: 0 = all checks pass, 1 = at least one failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_BASE = 'https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io';
const BASE = process.env.STRIDE_PROD_URL || DEFAULT_BASE;
const HEADLESS = process.env.HEADFUL !== '1';
const TAKE_SHOTS = !process.argv.includes('--no-screenshots');
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '.shots');

function profileFlag() {
  const idx = process.argv.indexOf('--profile');
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

function loadCredentials() {
  const profile = profileFlag();
  const candidates = profile
    ? [`.credentials.${profile}.local`, '.credentials.local']
    : ['.credentials.local'];
  for (const name of candidates) {
    const credPath = path.join(REPO_ROOT, name);
    if (!fs.existsSync(credPath)) continue;
    const out = {};
    for (const line of fs.readFileSync(credPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    if (out.email && out.password) {
      out._file = name;
      return out;
    }
  }
  const need = candidates.join(' or ');
  throw new Error(
    `No usable credentials file found (tried ${need}). ` +
    `Create one with two lines: email=... and password=... ` +
    `(see docs/auth-wiring.md).`
  );
}

function resolveChromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  // Auto-discover under the standard Playwright cache.
  const cache = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache).filter(d => d.startsWith('chromium-')).sort();
    for (const d of dirs.reverse()) {
      const candidate = path.join(cache, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;  // Let playwright use its default lookup.
}

async function loadPlaywright() {
  // Prefer the repo's frontend node_modules; fall back to a system-wide install.
  const candidates = [
    path.join(REPO_ROOT, 'frontend', 'node_modules', 'playwright'),
    path.join(REPO_ROOT, 'node_modules', 'playwright'),
    '/tmp/node_modules/playwright',
    'playwright',
  ];
  for (const c of candidates) {
    try {
      return await import(c.startsWith('/') ? path.join(c, 'index.mjs') : c);
    } catch {}
  }
  throw new Error(
    'playwright not installed. Run `cd /tmp && npm install playwright` ' +
    '(quick) or `cd frontend && npm install --save-dev playwright`.'
  );
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const creds = loadCredentials();
  console.log(`using credentials from ${creds._file}`);
  const { chromium } = await loadPlaywright();

  if (TAKE_SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: resolveChromiumPath(),
    headless: HEADLESS,
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });

  try {
    console.log(`→ ${BASE}`);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Login (the auth-service flow lands at /login if the session is empty).
    if (/\/login/.test(page.url()) || await page.locator('input[type="password"]').count()) {
      await page.locator('input[type="email"], input[name="email"]').first().fill(creds.email);
      await page.locator('input[type="password"]').first().fill(creds.password);
      const submit = page.locator(
        'button[type="submit"], button:has-text("登录"), button:has-text("Login"), button:has-text("Sign in")'
      ).first();
      await Promise.all([
        page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30_000 }).catch(() => null),
        submit.click(),
      ]);
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    }
    check('post-login', !/\/login/.test(page.url()), `landed on ${page.url()}`);

    // Discover the user's provider so card-visibility expectations match.
    // Garmin populates sleep / body battery / stress in `daily_health` and the
    // corresponding cards SHOULD render; COROS leaves those fields null so
    // the adaptive WatchExtrasSection hides them.
    const provider = await page.evaluate(async () => {
      const token = sessionStorage.getItem('access_token');
      const r = await fetch('/api/users/me/watch', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      return j.provider || null;
    });
    console.log(`detected provider: ${provider}`);

    // Navigate to Health.
    await page.goto(BASE + '/health', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_000);  // allow async chart hydration
    if (TAKE_SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, '01-health-fullpage.png'), fullPage: true });

    // Probe DOM. The HRV pieces are required for both providers (since #39
    // wired COROS into the same `daily_hrv` table Garmin already used).
    // Sleep / BodyBattery / Stress cards are Garmin-only signals and the
    // adaptive grid hides them for COROS users — the inverse for Garmin.
    const counts = {
      watchExtrasTitle: await page.locator('text=手表扩展数据').count(),
      watchExtrasSubLabel: await page.locator('text=Watch Extras').count(),
      garminLeftover: await page.locator('text=Watch Extras · Garmin').count(),
      hrvTitle: await page.locator('text=HRV 趋势').count(),
      hrvStatusCard: await page.locator('text=HRV 状态').count(),
      sleepCard: await page.locator('text=昨夜睡眠').count(),
      bbCard: await page.locator('text=Body Battery').count(),
      stressCard: await page.locator('text=日均压力').count(),
    };
    console.log(JSON.stringify(counts, null, 2));

    check('WatchExtrasSection header rendered', counts.watchExtrasTitle === 1);
    check('section renamed (no `Watch Extras · Garmin` leftover)', counts.garminLeftover === 0);
    check('HRV trend chart rendered',          counts.hrvTitle === 1);
    check('HRV status card rendered',          counts.hrvStatusCard === 1);

    if (provider === 'garmin') {
      check('Sleep card visible for Garmin user',       counts.sleepCard === 1);
      check('BodyBattery card visible for Garmin user', counts.bbCard === 1);
      check('Stress card visible for Garmin user',      counts.stressCard === 1);
    } else {
      check('Sleep card hidden for non-Garmin user',       counts.sleepCard === 0);
      check('BodyBattery card hidden for non-Garmin user', counts.bbCard === 0);
      check('Stress card hidden for non-Garmin user',      counts.stressCard === 0);
    }

    // Section-focused screenshot.
    if (TAKE_SHOTS && counts.watchExtrasTitle) {
      const header = page.getByText('手表扩展数据').first();
      const section = header.locator('xpath=ancestor::div[contains(@class,"mb-6")][1]');
      try {
        await section.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await section.screenshot({ path: path.join(SHOT_DIR, '02-watch-extras.png') });
      } catch (e) {
        console.log(`(section screenshot skipped: ${e.message})`);
      }
    }

    if (consoleErrors.length) {
      console.log('Page console errors:');
      for (const e of consoleErrors) console.log('  ' + e);
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed`);
}

main().catch(err => { console.error(err); process.exit(1); });
