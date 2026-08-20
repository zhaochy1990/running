const { chromium } = require("playwright");
const { loadLocalCredentials } = require("./onboarding-e2e-lib.cjs");

const appUrl = (process.env.STRIDE_LOCAL_URL || "http://127.0.0.1:8082").replace(/\/$/, "");
const weekName = "2030-01-07_01-13";

const hostname = new URL(appUrl).hostname;
const goApiUrl = process.env.STRIDE_SMOKE_GO_API_URL;
const goHostname = goApiUrl ? new URL(goApiUrl).hostname : "";
if (
  !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
  !["127.0.0.1", "localhost", "::1"].includes(goHostname) ||
  process.env.STRIDE_ALLOW_LOCAL_FEEDBACK_WRITE !== "true"
) {
  throw new Error("weekly-feedback smoke requires localhost BFF/Go URLs and STRIDE_ALLOW_LOCAL_FEEDBACK_WRITE=true");
}

function jwtSubject(token) {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sub;
}

async function main() {
  const { email, password } = loadLocalCredentials();
  const health = await fetch(`${goApiUrl.replace(/\/$/, "")}/health`);
  if (!health.ok) throw new Error(`local Go health failed: ${health.status}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${appUrl}/login`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "登录 STRIDE" });
    await dialog.locator('input[type="email"]').fill(email);
    await dialog.locator('input[type="password"]').fill(password);
    await dialog.getByRole("button", { name: /^登录$/ }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20_000 });

    const bootstrap = await page.evaluate(
      async ({ weekName }) => {
        const token = sessionStorage.getItem("access_token");
        if (!token) throw new Error("missing access token");
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const path = `/api/${payload.sub}/weeks/${weekName}`;
        const request = async (url, init) => {
          const response = await fetch(url, init);
          const body = await response.json();
          if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
          return body;
        };
        const created = await request(`${path}/feedback`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ content: "Local browser smoke", generated_by: "legacy-client" }),
        });
        const forbidden = await fetch(`/api/00000000-0000-4000-8000-000000000000/weeks/${weekName}/feedback`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ content: "forbidden" }),
        });
        const detail = await request(path, { headers });
        const list = await request(`/api/${payload.sub}/weeks`, { headers });
        return { sub: payload.sub, created, detail, list, forbiddenStatus: forbidden.status };
      },
      { weekName },
    );

    if (bootstrap.sub !== jwtSubject(await page.evaluate(() => sessionStorage.getItem("access_token")))) {
      throw new Error("JWT subject changed during smoke");
    }
    if (bootstrap.created.feedback !== "Local browser smoke" || !bootstrap.created.has_feedback) {
      throw new Error(`create mismatch: ${JSON.stringify(bootstrap.created)}`);
    }
    if (bootstrap.forbiddenStatus !== 403) throw new Error(`cross-user status=${bootstrap.forbiddenStatus}`);
    if (bootstrap.detail.feedback !== "Local browser smoke" || bootstrap.detail.plan !== null || bootstrap.detail.activities.length !== 0) {
      throw new Error(`detail mismatch: ${JSON.stringify(bootstrap.detail)}`);
    }
    const listed = bootstrap.list.weeks.find((week) => week.folder === weekName);
    if (!listed || !listed.has_feedback || listed.has_plan) {
      throw new Error(`list mismatch: ${JSON.stringify(bootstrap.list)}`);
    }

    const cleared = await page.evaluate(
      async ({ weekName }) => {
        const token = sessionStorage.getItem("access_token");
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const path = `/api/${payload.sub}/weeks/${weekName}`;
        const response = await fetch(`${path}/feedback`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ content: "  \n " }),
        });
        const saved = await response.json();
        const afterClear = await fetch(path, { headers }).then((result) => result.json());
        return { saved, afterClear };
      },
      { weekName },
    );
    if (cleared.saved.feedback !== "" || cleared.saved.has_feedback || cleared.afterClear.feedback !== "") {
      throw new Error(`clear mismatch: ${JSON.stringify(cleared)}`);
    }
    console.log(`weekly feedback browser smoke passed (${weekName})`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
