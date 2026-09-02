const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { readFile } = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

// Self-contained fixture smoke for the season-plan current endpoint. The frontend
// is a static container (no BFF-ish proxy). We build the SPA with a relative API
// base (VITE_API_BASE_URL unset), serve the built dist, and run a tiny API server
// on the SAME origin that fakes /api/users/me/profile + the master-plan current
// endpoint. This exercises the four client states (structured / Markdown / none /
// read-error) without any BFF or real upstream.

const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const host = "127.0.0.1";
const port = 18083;
const base = `http://${host}:${port}`;
const distDir = path.join(frontendRoot, "dist");
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const structuredPlan = {
  content_version: 2,
  status: "active",
  plan_id: "fixture-structured",
  goal_id: "fixture-goal",
  revision: 7,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
  plan: {
    goal: {
      goal_id: "fixture-goal",
      race_name: "Fixture 结构化测试马拉松",
      distance: "FM",
      race_date: "2026-10-11",
      target_time: "03:15:00",
      timezone: "Asia/Shanghai",
      location: null,
    },
    start_date: "2026-05-04",
    end_date: "2026-10-11",
    total_weeks: 23,
    phases: [
      {
        id: "fixture-phase",
        name: "专项期",
        start_date: "2026-05-04",
        end_date: "2026-10-11",
        focus: "马拉松专项耐力",
        weekly_distance_km_low: 45,
        weekly_distance_km_high: 55,
        key_session_types: ["阈值跑"],
        milestone_ids: ["fixture-milestone"],
      },
    ],
    milestones: [
      {
        id: "fixture-milestone",
        type: "race",
        date: "2026-10-11",
        phase_id: "fixture-phase",
        target: "完成目标马拉松",
        completed_actual: null,
      },
    ],
    weeks: [],
    training_principles: ["循序渐进"],
    generated_by: "fixture",
    current_phase_id: "fixture-phase",
    current_week_number: 15,
    next_milestone: {
      id: "fixture-milestone",
      date: "2026-10-11",
      target: "完成目标马拉松",
      days_until: 62,
    },
  },
};

const markdownPlan = {
  content_version: 1,
  status: "active",
  plan_id: "fixture-markdown",
  goal_id: "fixture-goal",
  revision: null,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
  plan: "# Fixture Markdown 赛季计划\n\n- 保持有氧基础\n- 每周安排一次长跑",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function requestMode(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).fixture_mode || "";
  } catch {
    return "";
  }
}

async function serveStatic(req, res) {
  let pathname = new URL(req.url, base).pathname;
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(distDir, pathname));
  if (!filePath.startsWith(distDir)) {
    json(res, 403, { detail: "forbidden" });
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback for client-side routes (/plan, /week/..., etc.).
    const html = await readFile(path.join(distDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

function createAppServer() {
  return createServer((req, res) => {
    const pathname = new URL(req.url, base).pathname;
    if (pathname.startsWith("/api/")) {
      if (req.method === "GET" && pathname === "/api/users/me/profile") {
        return json(res, 200, {
          id: "fixture-user",
          display_name: "Fixture Runner",
          profile: {},
          onboarding: { watch_ready: true, profile_ready: true, completed_at: "2026-05-01T00:00:00Z" },
          features: { coach_agent_weekly_plan: false, coach_chat: false },
        });
      }
      if (req.method === "GET" && pathname === "/api/users/fixture-user/master-plan/current") {
        const mode = requestMode(req);
        if (mode === "structured") return json(res, 200, structuredPlan);
        if (mode === "markdown") return json(res, 200, markdownPlan);
        if (mode === "none") return json(res, 404, { detail: "not found" });
        if (mode === "error") return json(res, 500, { error: "fixture error" });
        return json(res, 400, { error: "unknown fixture mode" });
      }
      return json(res, 404, { detail: "fixture route not found" });
    }
    return serveStatic(req, res);
  });
}

function fixtureJwt(mode) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "fixture-user", fixture_mode: mode, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist") || !fs.existsSync(systemChrome)) throw error;
    return chromium.launch({ headless: true, executablePath: systemChrome });
  }
}

async function assertScenario(browser, mode, assertion) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const currentRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/users/fixture-user/master-plan/current") currentRequests.push(request.url());
  });
  await page.addInitScript(
    ({ jwt }) => {
      sessionStorage.setItem("access_token", jwt);
      sessionStorage.setItem("refresh_token", "fixture-refresh");
    },
    { jwt: fixtureJwt(mode) },
  );
  await page.goto(`${base}/plan`, { waitUntil: "domcontentloaded" });
  await assertion(page);
  if (currentRequests.length !== 1) {
    throw new Error(`${mode}: expected one current-plan request, got ${currentRequests.length}`);
  }
  await page.close();
}

function runViteBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      cwd: frontendRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VITE_API_BASE_URL: "" },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vite build failed (${code}):\n${output}`));
    });
  });
}

async function main() {
  await runViteBuild();

  const app = createAppServer();
  app.listen(port, host);
  await once(app, "listening");

  let browser;
  try {
    browser = await launchBrowser();
    await assertScenario(browser, "structured", async (page) => {
      await page.getByRole("heading", { name: "Fixture 结构化测试马拉松" }).waitFor();
      if (await page.getByText(/revision|修订号|v7/i).count()) throw new Error("structured: revision is visible");
    });
    await assertScenario(browser, "markdown", async (page) => {
      await page.getByRole("heading", { name: "Fixture Markdown 赛季计划" }).waitFor();
      await page.getByText("保持有氧基础").waitFor();
    });
    await assertScenario(browser, "none", async (page) => {
      await page.getByRole("heading", { name: "创建你的赛季计划", exact: true }).first().waitFor();
    });
    await assertScenario(browser, "error", async (page) => {
      await page.getByRole("heading", { name: "无法读取赛季训练计划" }).waitFor();
      if (await page.getByRole("heading", { name: "创建你的赛季计划", exact: true }).count()) {
        throw new Error("error: rendered creation state");
      }
    });
    console.log("Current plan fixture smoke OK: structured, Markdown, no-plan, read-error");
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    if (browser) await browser.close();
    app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
