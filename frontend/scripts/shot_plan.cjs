// One-off: screenshot the local /plan page after migration, to eyeball the
// new SeasonOverview render. Reads creds from repo-root .credentials.local
// (never logged). Logs in via the Vite /api/auth proxy, stashes the token in
// sessionStorage, then navigates to /plan and captures a full-page PNG.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SHOT_BASE || 'http://localhost:5177';
const CLIENT_ID = 'app_62978bf2803346878a2e4805';

function readCreds() {
  const candidates = [
    path.resolve(__dirname, '../../.credentials.local'),
    'C:/Users/zhaochaoyi/workspace/running/.credentials.local',
  ];
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) throw new Error('.credentials.local not found');
  const txt = fs.readFileSync(p, 'utf8');
  let email, password;
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('email')) email = t.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    else if (t.startsWith('password')) password = t.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  }
  if (!email || !password) throw new Error('creds not found');
  return { email, password };
}

(async () => {
  const { email, password } = readCreds();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const loginStatus = await page.evaluate(async ({ email, password, CLIENT_ID }) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) return r.status;
    const d = await r.json();
    sessionStorage.setItem('access_token', d.access_token);
    sessionStorage.setItem('refresh_token', d.refresh_token);
    return 200;
  }, { email, password, CLIENT_ID });
  console.log('login status:', loginStatus);

  await page.goto(BASE + '/plan', { waitUntil: 'domcontentloaded' });
  // Wait for either the SeasonOverview heading or any plan content to settle.
  await page.waitForTimeout(4000);

  const heading = await page.evaluate(() => document.body.innerText.slice(0, 400));
  console.log('--- page text (first 400 chars) ---\n' + heading);

  const out = path.resolve(__dirname, '../../plan_local.png');
  await page.screenshot({ path: out, fullPage: true });
  console.log('screenshot:', out);
  if (errors.length) console.log('console errors:', errors.slice(0, 5));
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
