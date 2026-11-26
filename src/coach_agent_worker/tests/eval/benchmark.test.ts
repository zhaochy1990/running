import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { RunnerSnapshot } from "@stride/coach-agent";
import { addDays, weekFolder } from "@stride/contract";
import { FIRST_BATCH, importFirstBatch, loadFirstBatch, validateFirstBatch } from "../../src/eval/benchmark.js";
import { createSnapshot, rollingSnapshot } from "./fixtures.js";

function batch(): Record<string, RunnerSnapshot> {
  const snapshots: Record<string, RunnerSnapshot> = {};
  const base = createSnapshot();
  for (const spec of FIRST_BATCH) {
    const snapshot = structuredClone(base);
    Object.assign(snapshot, { event: spec.event, target_time: spec.target, generation_kind: spec.kind, as_of_day: spec.day ?? "2026-11-25" });
    if (["pan", "fm-extra", "hm-extra"].includes(spec.key)) {
      assert.ok(snapshot.records.profile);
      snapshot.records.profile.userId = spec.key;
      snapshot.records.activities.forEach((a) => {
        a.userId = spec.key;
      });
    }
    if (spec.kind !== "new_season") {
      const rolling = rollingSnapshot(spec.key === "rolling-hm" ? 5 : spec.key === "rolling-d" ? 2 : 4, spec.event);
      Object.assign(snapshot.records, {
        active_master_plan: rolling.records.active_master_plan,
        weekly_plan_weeks: rolling.records.weekly_plan_weeks,
        weekly_plans: rolling.records.weekly_plans,
      });
      assert.ok(rolling.as_of);
      snapshot.as_of = rolling.as_of;
      snapshot.expected_start_week = spec.key === "rolling-d" ? 4 : 5;
      assert.ok(snapshot.records.active_master_plan);
      snapshot.records.active_master_plan.content.weekly_docs = snapshot.records.weekly_plans?.map((d) => d.content);
    }
    if (spec.key === "rolling-hm") {
      // Synthetic test-only HM dates: Oct26 start, actual W5 on Nov25 and next W6.
      assert.ok(snapshot.records.active_master_plan);
      const shifted = JSON.stringify(snapshot.records.active_master_plan.content).replace(/2026-\d{2}-\d{2}/g, (day) => addDays(day, 21));
      snapshot.records.active_master_plan.content = JSON.parse(shifted);
      snapshot.records.weekly_plans = snapshot.records.weekly_plans?.map((row) => ({
        week_start: addDays(row.week_start, 21),
        content: {
          ...JSON.parse(JSON.stringify(row.content).replace(/2026-\d{2}-\d{2}/g, (day) => addDays(day, 21))),
          week_name: weekFolder(addDays(row.week_start, 21)),
        },
      }));
      snapshot.records.weekly_plan_weeks = snapshot.records.weekly_plan_weeks?.map((row) => ({ ...row, week_start: addDays(row.week_start, 21) }));
      snapshot.records.active_master_plan.content.weekly_docs = snapshot.records.weekly_plans?.map((row) => row.content);
      snapshot.as_of = "2026-11-25T08:00:00+08:00";
      snapshot.expected_start_week = 6;
      const activity = snapshot.records.activities[0];
      assert.ok(activity);
      snapshot.records.activities.push({ ...activity, labelId: "later-hm-history", date: "2026-11-24T00:00:00Z", shanghaiDay: "2026-11-24" });
    }
    snapshots[spec.key] = snapshot;
  }
  return snapshots;
}

async function privateManifest(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "stride1062-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots = batch();
  const references: Record<string, { file: string; sha256: string }> = {};
  async function save(file: string, doc: unknown) {
    const raw = JSON.stringify(doc);
    await writeFile(join(root, file), raw, { mode: 0o600 });
    return { file, sha256: createHash("sha256").update(raw).digest("hex") };
  }
  for (const [key, snapshot] of Object.entries(snapshots)) references[key] = await save(`${key}.json`, snapshot);
  const rolling_sources = {
    "rolling-c": await save("source-fm.json", { weekly_docs: snapshots["rolling-c"]?.records.weekly_plans?.map((d) => d.content) }),
    "rolling-hm": await save("source-hm.json", { weekly_docs: snapshots["rolling-hm"]?.records.weekly_plans?.map((d) => d.content) }),
  };
  const manifest = { schema: "plan-eval-first-batch/v1", snapshots: references, rolling_sources };
  const path = join(root, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  return { root, path, manifest };
}

test("first batch retains four runners, five new / three rolling, C/D shared history and all three weekly surfaces", () => {
  validateFirstBatch(batch());
  for (const [label, key, mutate] of [
    [
      "goal",
      "pan",
      (s) => {
        s.target_time = "3:10:00";
      },
    ],
    [
      "cutoff",
      "fm-extra",
      (s) => {
        s.as_of_day = "2026-10-26";
      },
    ],
    [
      "missing document",
      "rolling-c",
      (s) => {
        s.records.weekly_plans?.pop();
      },
    ],
    [
      "different season",
      "rolling-d",
      (s) => {
        assert.ok(s.records.active_master_plan);
        s.records.active_master_plan.content.anchor = {};
      },
    ],
    [
      "different history",
      "rolling-d",
      (s) => {
        s.records.activities = [];
      },
    ],
    [
      "wrong boundary",
      "rolling-c",
      (s) => {
        const row = s.records.weekly_plan_weeks?.[3];
        assert.ok(row);
        row.week_start = "2026-11-02";
      },
    ],
  ] as Array<[string, string, (s: RunnerSnapshot) => void]>) {
    const snapshots = batch();
    const snapshot = snapshots[key];
    assert.ok(snapshot);
    mutate(snapshot);
    assert.throws(() => validateFirstBatch(snapshots), /./, label);
  }
});

test("HM continuation uses its own season, real last week and cutoff, without requiring the Oct26 new-season history", () => {
  validateFirstBatch(batch());
  for (const mutate of [
    (s: RunnerSnapshot) => {
      s.as_of_day = "2026-11-30";
      s.as_of = "2026-11-30T23:59:59+08:00";
    },
    (s: RunnerSnapshot) => {
      s.expected_start_week = 5;
    },
    (s: RunnerSnapshot) => {
      s.records.activities = [];
    },
    (s: RunnerSnapshot) => {
      assert.ok(s.records.profile);
      s.records.profile.userId = "other-runner";
    },
    (s: RunnerSnapshot) => {
      const a = s.records.activities[0];
      assert.ok(a);
      s.records.activities.push({ ...a, date: "2026-11-25T10:00:00+08:00", shanghaiDay: "2026-11-25" });
    },
    (s: RunnerSnapshot) => {
      assert.ok(s.records.active_master_plan);
      delete s.records.active_master_plan.content.policy;
    },
  ]) {
    const snapshots = batch();
    const hm = snapshots["rolling-hm"];
    assert.ok(hm);
    mutate(hm);
    assert.throws(() => validateFirstBatch(snapshots));
  }
});

test("private input hashes and actual original week-four boundary are checked before any import", async (t) => {
  const { path, root, manifest } = await privateManifest(t);
  await loadFirstBatch(path);
  const source = JSON.parse(await readFile(join(root, "source-fm.json"), "utf8"));
  source.weekly_docs.pop();
  const raw = JSON.stringify(source);
  await writeFile(join(root, "source-fm.json"), raw);
  await assert.rejects(loadFirstBatch(path), /source SHA-256 mismatch/);
  manifest.rolling_sources["rolling-c"].sha256 = createHash("sha256").update(raw).digest("hex");
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(loadFirstBatch(path), /2026-10-26 must match its original real weekly document/);
});

test("separate hash-pinned Candidate W1-3 and real W4 Artifact are accepted; missing or altered source fails", async (t) => {
  const { path, root, manifest } = await privateManifest(t);
  const full = JSON.parse(await readFile(join(root, "source-fm.json"), "utf8"));
  const candidate = JSON.stringify({ content: { weekly_docs: full.weekly_docs.slice(0, 3) } });
  const fourth = JSON.stringify({ type: "weekly_plan_batch", weekly_docs: full.weekly_docs.slice(3) });
  await writeFile(join(root, "candidate.json"), candidate);
  await writeFile(join(root, "fourth.json"), fourth);
  const refs = [
    { file: "candidate.json", sha256: createHash("sha256").update(candidate).digest("hex") },
    { file: "fourth.json", sha256: createHash("sha256").update(fourth).digest("hex") },
  ];
  const multiple = { ...manifest, rolling_sources: { ...manifest.rolling_sources, "rolling-c": refs } };
  await writeFile(path, JSON.stringify(multiple));
  await loadFirstBatch(path);
  multiple.rolling_sources["rolling-c"] = refs.slice(0, 1);
  await writeFile(path, JSON.stringify(multiple));
  await assert.rejects(loadFirstBatch(path), /2026-10-26 must match/);
  multiple.rolling_sources["rolling-c"] = refs;
  await writeFile(path, JSON.stringify(multiple));
  await writeFile(join(root, "fourth.json"), "{}");
  await assert.rejects(loadFirstBatch(path), /source SHA-256 mismatch/);
});

test("CLI malformed private JSON never prints source text", async (t) => {
  const { root } = await privateManifest(t);
  const path = join(root, "invalid.json");
  await writeFile(path, '{"synthetic-sensitive-history":oops}');
  const cli = new URL("../../../scripts/import-first-batch.mjs", import.meta.url);
  await assert.rejects(promisify(execFile)(process.execPath, [cli.pathname, "--check", path]), (error: unknown) => {
    const stderr = (error as { stderr: string }).stderr;
    assert.match(stderr, /invalid JSON/);
    assert.doesNotMatch(stderr, /synthetic-sensitive-history/);
    return true;
  });
});

test("repeat import reuses eight assigned IDs and two scenarios; changed catalog and ambiguous POST fail closed", async (t) => {
  const { path, root } = await privateManifest(t);
  const rows = new Map<string, string>();
  let posts = 0;
  let failPost = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-admin-test");
    const path = req.url?.replace("/api/admin/plan-eval", "") ?? "";
    if (req.method === "GET") {
      res.end(rows.get(path) ?? "{}");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (path === "/request-preview") {
      res.end("{}");
      return;
    }
    posts++;
    if (failPost) {
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    const doc = JSON.parse(raw);
    const id = randomUUID();
    if (path === "/snapshots") doc.snapshot_id = id;
    else doc.id = id;
    const body = JSON.stringify(doc);
    rows.set(`${path}/${id}`, body);
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const statePath = join(root, "state.json");
  const first = await importFirstBatch(path, origin, "local-admin-test", statePath);
  const second = await importFirstBatch(path, origin, "local-admin-test", statePath);
  assert.equal(posts, 10);
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first.snapshots).length, 8);
  assert.equal(Object.keys(first.scenarios).length, 2);
  const changed = first.snapshots.chaoyi;
  assert.ok(changed);
  rows.set(`/snapshots/${changed.id}`, "{}");
  await assert.rejects(importFirstBatch(path, origin, "local-admin-test", statePath), /catalog entry was edited/);
  failPost = true;
  const failedState = join(root, "failed-state.json");
  await assert.rejects(importFirstBatch(path, origin, "local-admin-test", failedState), /HTTP 500/);
  const beforeRetry = posts;
  await assert.rejects(importFirstBatch(path, origin, "local-admin-test", failedState), /previous POST outcome is unknown/);
  assert.equal(posts, beforeRetry);
  await assert.rejects(importFirstBatch(path, "https://admin.stride-running.cn", "local-admin-test", statePath), /loopback isolated/);
});

test("C/D reject changed constraints and provider race target", () => {
  for (const field of ["constraints", "race_target"] as const) {
    const snapshots = batch();
    const d = snapshots["rolling-d"];
    assert.ok(d);
    if (field === "constraints") d.constraints.max_run_days_per_week = 3;
    else {
      assert.ok(d.records.race_target);
      d.records.race_target.race_name = "another race";
    }
    assert.throws(() => validateFirstBatch(snapshots), field === "constraints" ? /C\/D constraints/ : /C\/D records.race_target/);
  }
});

test("optional new-season exact as_of must be valid and share the Shanghai day", () => {
  const snapshots = batch();
  const s = snapshots.chaoyi;
  assert.ok(s);
  delete s.as_of;
  validateFirstBatch(snapshots);
  s.as_of = "2026-10-25T16:00:00Z";
  validateFirstBatch(snapshots);
  for (const instant of ["2026-10-27T00:00:00+08:00", "not-an-instant", "2026-10-26"]) {
    s.as_of = instant;
    assert.throws(() => validateFirstBatch(snapshots));
  }
});

test("catalog definitive no-write rejection clears pending; ambiguous status/body/network retains it", async (t) => {
  const { path, root } = await privateManifest(t);
  let status = 422;
  let response = '{"error":"invalid_input","detail":"synthetic validation"}';
  let cut = false;
  let posts = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end("{}");
      return;
    }
    for await (const _ of req) {
      /* consume request before rejecting */
    }
    posts++;
    res.statusCode = status;
    if (cut) {
      res.setHeader("Content-Length", response.length + 100);
      res.write(response);
      res.destroy();
    } else res.end(response);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [code, body, truncated, noWrite] of [
    [422, response, false, true],
    [422, "", false, true],
    [401, '{"error":"unauthorized"}', false, true],
    [401, "", false, true],
    [403, '{"error":"forbidden"}', false, true],
    [400, '{"error":"invalid_json"}', false, true],
    [409, "", false, false],
    [404, '{"error":"not_found"}', false, false],
    [429, "", false, false],
    [500, '{"error":"internal_error"}', false, false],
    [422, '{"error":"unexpected"}', false, false],
    [422, "malformed", false, false],
    [422, '{"error":"invalid_input"}', true, false],
    [200, '{"snapshot_id":', false, false],
    [200, "{}", false, false],
  ] as const) {
    status = code;
    response = body;
    cut = truncated;
    const statePath = join(root, `rejected-${posts}.json`);
    await assert.rejects(importFirstBatch(path, origin, "test-admin", statePath));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(Boolean(state.pending), !noWrite, `status ${code}, cut ${truncated}`);
    const before = posts;
    await assert.rejects(importFirstBatch(path, origin, "test-admin", statePath));
    assert.equal(posts, before + (noWrite ? 1 : 0), "only proven no-write may POST again");
  }
});
