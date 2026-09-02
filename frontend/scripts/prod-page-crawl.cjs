/**
 * Prod page-crawl smoke. Logs into https://stride-running.cn with the real
 * account in repo `.credentials.local` (user_email / user_password), then visits
 * every authenticated page, recording:
 *   - whether each page rendered (no page crash / no "加载失败" profile-gate)
 *   - every `/api/*` response >= 400 (the still-Python routes that now 404 on
 *     the Go-only gateway), so the migration gap is explicit.
 *
 * Secrets are never printed. Run from frontend/ (playwright is a dev dep):
 *   node scripts/prod-page-crawl.cjs
 * Add an npm script if useful.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..", "..");
const base = "https://stride-running.cn";
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function loadCreds() {
  const raw = fs.readFileSync(path.join(repoRoot, ".credentials.local"), "utf-8");
  const get = (k) => {
    const m = raw.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const email = get("user_email");
  const password = get("user_password");
  if (!email || !password) throw new Error("user_email/user_password not found in .credentials.local");
  return { email, password };
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist") || !fs.existsSync(systemChrome)) throw error;
    return chromium.launch({ headless: true, executablePath: systemChrome });
  }
}

const globalApiFailures = new Map(); // "METHOD path" -> Set(statuses)
const perPage = [];

/** Visit a route, classify its outcome, and collect /api failures. */
async function visit(page, name, url) {
  const failures = new Map(); // "METHOD path" -> biggest status
  const errors = [];
  const onResponse = (res) => {
    const u = res.url();
    if (u.includes("/api/") && res.status() >= 400) {
      const key = `${res.request().method()} ${new URL(u).pathname}`;
      if (!failures.has(key) || res.status() > failures.get(key)) failures.set(key, res.status());
    }
  };
  const onPageError = (e) => errors.push(e.message.slice(0, 160));
  page.on("response", onResponse);
  page.on("pageerror", onPageError);

  let result;
  try {
    const start = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Let async data settle (profile gate + page fetches).
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    // Gate error / crash signal.
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400));
    const gateError = body.includes("加载失败，请检查网络后重试");
    // React Router does client-side navigation, so an HTTP redirect check is
    // unreliable. Detect redirects by comparing the final URL to the request.
    const finalUrl = page.url();
    const redirected = finalUrl !== url && new URL(finalUrl).pathname !== new URL(url).pathname;
    const crashed = errors.length > 0;
    const ms = Date.now() - start;
    result = { name, url, ms, gateError, crashed, redirected, finalUrl };
  } catch (e) {
    result = { name, url, ms: -1, gateError: false, crashed: true, redirected: false, finalUrl: page.url(), error: e.message.slice(0, 160) };
  } finally {
    page.off("response", onResponse);
    page.off("pageerror", onPageError);
  }

  for (const [k, st] of failures) globalApiFailures.set(k, st);
  perPage.push({ ...result, failures: [...failures.entries()].map(([k, st]) => `${st} ${k}`) });
  return result;
}

async function main() {
  const { email, password } = loadCreds();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  // ---- login ----
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog", { name: "登录 STRIDE" });
  await dialog.locator('input[type="email"]').fill(email);
  await dialog.locator('input[type="password"]').fill(password);
  await dialog.getByRole("button", { name: /^登录$/ }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 25000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const hasToken = await page.evaluate(() => Boolean(sessionStorage.getItem("access_token")));
  if (!hasToken) throw new Error("login failed: no access_token");

  // ---- discover params ----
  await page.goto(`${base}/activities`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "活动列表" }).waitFor({ timeout: 20000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const firstActivity = await page.locator('a[href^="/activity/"]').first().getAttribute("href").catch(() => null);

  // Home redirects to /week/<current>.
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const weekPath = new URL(page.url()).pathname.startsWith("/week/") ? new URL(page.url()).pathname : null;

  await page.goto(`${base}/teams`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const teamId = await page
    .locator('a[href^="/teams/"]')
    .filter({ hasNot: page.locator('a[href="/teams/new"]') })
    .first()
    .getAttribute("href")
    .catch(() => null);

  // ---- crawl ----
  const routes = [
    ["home (weekly)", `${base}/`],
    ["activities", `${base}/activities`],
    firstActivity ? ["activity detail", `${base}${firstActivity}`] : ["activity detail", "(no activity to open)"],
    weekPath ? ["week detail", `${base}${weekPath}`] : ["week detail", "(no current week)"],
    ["health", `${base}/health`],
    ["plan (season)", `${base}/plan`],
    ["plan/adjust", `${base}/plan/adjust`],
    ["ability", `${base}/ability`],
    ["training-status", `${base}/training-status`],
    ["body-composition", `${base}/body-composition`],
    ["teams", `${base}/teams`],
    teamId ? ["team detail", `${base}${teamId}`] : ["team detail", "(no team to open)"],
    ["settings", `${base}/settings`],
    ["coach", `${base}/coach`],
    ["coach weekly adjust", `${base}/coach/week/2026-01-01_01-01/adjust`],
    ["coach master adjust", `${base}/coach/master/00000000-0000-0000-0000-000000000000/adjust`],
  ];

  for (const [name, url] of routes) {
    if (!url.startsWith("http")) {
      perPage.push({ name, url, ms: 0, skipped: true, note: url, failures: [] });
      continue;
    }
    await visit(page, name, url);
    // Small pause so a shared spinner/overlay doesn't bleed into the next page.
    await page.waitForTimeout(300);
  }

  await browser.close();

  // ---- report ----
  console.log("=== PAGE OUTCOMES ===");
  for (const p of perPage) {
    if (p.skipped) { console.log(`  - ${p.name}: SKIPPED (${p.note})`); continue; }
    const ok = !p.gateError && !p.crashed;
    const status = ok ? "OK" : "FAIL";
    const why = [];
    if (p.gateError) why.push("profile-gate error");
    if (p.crashed) why.push(`crashed: ${p.error || p.failures.join(",")}`);
    if (p.redirected) why.push(`redirected -> ${p.finalUrl}`);
    console.log(`  ${status.padEnd(5)} ${p.name.padEnd(22)} ${p.ms}ms${why.length ? "  [" + why.join("; ") + "]" : ""}`);
    if (p.failures.length) console.log(`        /api failures: ${p.failures.join(", ")}`);
  }

  console.log("\n=== DISTINCT /api >=400 (still-Python routes on the Go-only gateway) ===");
  if (globalApiFailures.size === 0) console.log("  none");
  for (const [k, st] of [...globalApiFailures.entries()].sort()) console.log(`  ${st}  ${k}`);

  const failed = perPage.filter((p) => !p.skipped && (p.gateError || p.crashed));
  console.log(`\nSUMMARY: pages=${perPage.length} failed=${failed.length} distinctApi4xx/5xx=${globalApiFailures.size}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("CRAWL FAILED:", e.message || e);
  process.exit(1);
});
