const { chromium } = require("playwright");
const { loadLocalCredentials } = require("./onboarding-e2e-lib.cjs");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const appUrl = (process.env.STRIDE_LOCAL_URL || "http://127.0.0.1:5173").replace(/\/$/, "");
const screenshotPath = path.join(process.env.TEMP || repoRoot, "stride-local-smoke.png");
const weeklyScreenshotPath = path.join(process.env.TEMP || repoRoot, "stride-weekly-plan-smoke.png");
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function sanitizeUrl(url) {
  return url.replace(/[?].*/, "");
}

// Collect the signals that mean "the browser hit a real problem" for a page:
// console errors, uncaught page errors, failed API requests and >=400 API
// responses. Each page (email session + phone session) gets its own wiring.
function watchPage(target, issues, responses) {
  target.on("console", (msg) => {
    if (msg.type() === "error") {
      issues.push(`console error: ${msg.text().slice(0, 300)}`);
    }
  });
  target.on("pageerror", (error) => {
    issues.push(`page error: ${error.message.slice(0, 300)}`);
  });
  target.on("requestfailed", (request) => {
    const url = request.url();
    if (request.failure()?.errorText === "net::ERR_ABORTED") {
      return;
    }
    if (url.includes("/api/") || url.includes("/auth/")) {
      issues.push(`request failed: ${sanitizeUrl(url)} ${request.failure()?.errorText || ""}`);
    }
  });
  target.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/auth/") || url.includes("/api/users") || url.includes("/activities")) {
      responses.push(`${response.status()} ${sanitizeUrl(url)}`);
      if (response.status() >= 400) {
        issues.push(`HTTP ${response.status()}: ${sanitizeUrl(url)}`);
      }
    }
  });
}

// Auth-scoped diagnostics for the phone pass. In SMS test mode the local auth
// backend sits at a different origin than the (unproxied) data plane, so only
// auth traffic and uncaught JS count as failures here — the post-login dashboard
// 404s are expected and must not fail the SMS smoke.
function watchAuthPage(target, issues, responses) {
  target.on("pageerror", (error) => {
    issues.push(`page error: ${error.message.slice(0, 300)}`);
  });
  target.on("requestfailed", (request) => {
    if (request.url().includes("/api/auth/")) {
      issues.push(`request failed: ${sanitizeUrl(request.url())} ${request.failure()?.errorText || ""}`);
    }
  });
  target.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/auth/")) {
      responses.push(`${response.status()} ${sanitizeUrl(url)}`);
      if (response.status() >= 400) {
        // The web login form's unregistered-phone guard (login_only) returns
        // 404 on sms/send by design; the smoke asserts the UI handles it, so it
        // is not a browser issue.
        const expectedGuard = response.status() === 404 && url.includes("/api/auth/sms/send");
        if (!expectedGuard) {
          issues.push(`HTTP ${response.status()}: ${sanitizeUrl(url)}`);
        }
      }
    }
  });
}

// Phone + SMS verification-code login. Requires a backend running in SMS test
// mode (fixed code 123456, no Tencent call) — see STRIDE_SMS_TEST_MODE and
// stride-devops/local/docker-compose.yml. A fresh page means a fresh
// sessionStorage, so this exercises phone login independently of the email
// session above.
//
// The web login form refuses unbound phones at send time (login_only), so the
// smoke first binds a phone through the API's login-or-register flow, then logs
// in with it, and separately asserts the unbound-phone guard guides to register.
const AUTH_CLIENT_ID = process.env.STRIDE_AUTH_CLIENT_ID || "app_62978bf2803346878a2e4805";

async function registerPhoneViaApi(request, appUrl, phone) {
  const headers = { "Content-Type": "application/json", "X-Client-Id": AUTH_CLIENT_ID };
  const send = await request.post(`${appUrl}/api/auth/sms/send`, { headers, data: { phone } });
  if (!send.ok()) throw new Error(`phone registration sms/send failed: ${send.status()}`);
  const verify = await request.post(`${appUrl}/api/auth/sms/verify`, { headers, data: { phone, code: "123456" } });
  if (!verify.ok()) throw new Error(`phone registration sms/verify failed: ${verify.status()}`);
}

async function phoneLoginSmoke(browser, appUrl, issues, responses) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const registeredPhone = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const unregisteredPhone = `139${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  await registerPhoneViaApi(page.request, appUrl, registeredPhone);
  watchAuthPage(page, issues, responses);
  await page.goto(`${appUrl}/login`, { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog", { name: "登录 STRIDE" });
  await dialog.getByRole("button", { name: "手机号" }).click();

  // An unbound phone is refused at send time and guided to registration.
  await dialog.getByLabel("手机号").fill(unregisteredPhone);
  await dialog.getByRole("button", { name: "获取验证码" }).click();
  await dialog.getByText("该手机号尚未注册,请先创建账号").waitFor({ timeout: 20_000 });
  await dialog.getByRole("link", { name: /立即注册/ }).waitFor({ timeout: 5_000 });

  // A bound phone sends a code and logs in.
  await dialog.getByLabel("手机号").fill(registeredPhone);
  await dialog.getByRole("button", { name: "获取验证码" }).click();
  await dialog.getByRole("button", { name: /重新获取\(\d+s\)/ }).waitFor({ timeout: 20_000 });
  await dialog.getByLabel("验证码").fill("123456");
  await dialog.getByRole("button", { name: /^登录$/ }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20_000 });
  const hasToken = await page.evaluate(() => Boolean(sessionStorage.getItem("access_token")));
  if (!hasToken) throw new Error("phone login completed without access_token");
  // Let any follow-up auth traffic settle so failures land in `issues`.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.close();
  console.log(`Phone login OK (bound phone ${registeredPhone}); unbound ${unregisteredPhone} guided to register`);
}

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function assertCurrentWeekUrl(url) {
  const folder = decodeURIComponent(new URL(url).pathname.replace(/^\/week\//, ""));
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/.exec(folder);
  if (!match) throw new Error(`weekly plan did not redirect to a dated week: ${folder}`);
  const startYear = Number(match[1].slice(0, 4));
  const startMonthDay = match[1].slice(5);
  const endMonthDay = `${match[2]}-${match[3]}`;
  const endYear = endMonthDay < startMonthDay ? startYear + 1 : startYear;
  const end = `${endYear}-${endMonthDay}`;
  const today = shanghaiToday();
  if (today < match[1] || today > end) {
    throw new Error(`weekly plan opened ${match[1]}..${end} instead of current Shanghai week (${today})`);
  }
}

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist") || !fs.existsSync(systemChrome)) {
      throw error;
    }
    browser = await chromium.launch({ headless: true, executablePath: systemChrome });
  }
  const issues = [];
  const responses = [];

  // SMS test mode: only the phone pass is meaningful. It runs against the local
  // auth backend (`VITE_DEV_API_PROXY=http://localhost:3001`), where there is no
  // local .credentials.local account and no proxied data plane — so the
  // email + data-page pass cannot run and is skipped.
  if (process.env.STRIDE_SMS_TEST_MODE === "1") {
    await phoneLoginSmoke(browser, appUrl, issues, responses);
    await browser.close();
    if (issues.length > 0) {
      throw new Error(`local SMS smoke found browser issues:\n${issues.join("\n")}`);
    }
    console.log(`Local SMS smoke OK: ${appUrl}`);
    console.log(`Responses checked: ${responses.length}`);
    return;
  }

  const { email, password } = loadLocalCredentials();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  watchPage(page, issues, responses);

  await page.goto(`${appUrl}/login`, { waitUntil: "domcontentloaded" });
  // Login is now a modal overlay on the landing page; scope to the dialog so the
  // nav/footer "登录" buttons on the landing page don't collide with the submit button.
  const loginDialog = page.getByRole("dialog", { name: "登录 STRIDE" });
  await loginDialog.locator('input[type="email"]').fill(email);
  await loginDialog.locator('input[type="password"]').fill(password);
  await loginDialog.getByRole("button", { name: /^登录$/ }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  const hasToken = await page.evaluate(() => Boolean(sessionStorage.getItem("access_token")));
  if (!hasToken) throw new Error("login completed without access_token");

  await page.goto(`${appUrl}/activities`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByRole("heading", { name: "活动列表" }).waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const state = await page.evaluate(() => ({
      path: window.location.pathname,
      loadingError: document.body.innerText.includes("加载失败，请检查网络后重试"),
      onboarding: window.location.pathname.startsWith("/onboarding"),
      body: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
    }));
    const headings = (await page.locator("h1, h2, h3").allTextContents())
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 8);
    throw new Error(
      `activity page did not load: path=${state.path}, loading_error=${state.loadingError}, onboarding=${state.onboarding}; ` +
        `headings=${headings.join(" | ") || "none"}; body=${state.body || "empty"}; ` +
        `responses=${responses.slice(-8).join(" | ") || "none"}; ` +
        `issues=${issues.slice(-8).join(" | ") || "none"}; cause=${error.message}; screenshot=${screenshotPath}`,
    );
  }
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  const notificationClose = page.getByRole("button", { name: "关闭" });
  if (await notificationClose.isVisible().catch(() => false)) {
    await notificationClose.click();
    await page
      .getByRole("dialog")
      .waitFor({ state: "detached", timeout: 5_000 })
      .catch(() => {});
  }

  const rows = page.locator('a[href^="/activity/"]');
  const rowCount = await rows.count();
  if (rowCount === 0) {
    const emptyState = await page
      .getByText("该范围暂无活动记录。")
      .isVisible()
      .catch(() => false);
    const loadError = await page
      .locator("text^=加载失败：")
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `activity list loaded but no activity rows were found; empty=${emptyState}; ` +
        `error=${loadError.slice(0, 1).join("") || "none"}; ` +
        `responses=${responses.slice(-8).join(" | ") || "none"}`,
    );
  }

  await rows.first().click();
  await page.waitForURL((url) => url.pathname.startsWith("/activity/"), { timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.locator("text=距离").first().waitFor({ timeout: 20_000 });

  await page.screenshot({ path: screenshotPath, fullPage: false });

  await page.goto(`${appUrl}/`, { waitUntil: "domcontentloaded" });
  const weeklyPlanHeading = page.getByRole("heading", { name: "本周课表" });
  const emptyPlanHeading = page.getByRole("heading", { name: "使用 Coach Agent 生成本周计划" });
  const noWeekMessage = page.getByText("请选择一个训练周", { exact: true });
  await weeklyPlanHeading.or(emptyPlanHeading).or(noWeekMessage).waitFor({ timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  if (await weeklyPlanHeading.isVisible().catch(() => false)) {
    assertCurrentWeekUrl(page.url());
    const weeklyTabs = page.getByRole("tab");
    if ((await weeklyTabs.count()) !== 4) {
      throw new Error("weekly plan did not render exactly four tabs");
    }
    const tabChecks = [
      ["weekly-plan-tab-schedule", null],
      ["weekly-plan-tab-strength", null],
      ["weekly-plan-tab-records", "本周训练记录"],
      ["weekly-plan-tab-feedback", "围绕本周关键课记录体感"],
    ];
    for (const [id, expectedHeading] of tabChecks) {
      const tab = page.locator(`#${id}`);
      if ((await tab.count()) !== 1) throw new Error(`weekly plan tab missing: ${id}`);
      await tab.click();
      if ((await tab.getAttribute("aria-selected")) !== "true") {
        throw new Error(`weekly plan tab did not activate: ${id}`);
      }
      const panel = page.getByRole("tabpanel");
      await panel.waitFor({ timeout: 10_000 });
      if (!(await panel.innerText()).trim()) {
        throw new Error(`weekly plan tab rendered no content: ${id}`);
      }
      if (expectedHeading) {
        await page.getByRole("heading", { name: expectedHeading }).waitFor({ timeout: 10_000 });
      }
    }
  }
  await page.screenshot({ path: weeklyScreenshotPath, fullPage: false });

  await browser.close();

  if (issues.length > 0) {
    throw new Error(`local smoke found browser issues:\n${issues.join("\n")}`);
  }

  console.log(`Local smoke OK: ${appUrl}`);
  console.log(`Responses checked: ${responses.length}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log(`Weekly screenshot: ${weeklyScreenshotPath}`);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
