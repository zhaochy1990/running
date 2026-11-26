import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fromStoredContent, type RunnerSnapshot, RunnerSnapshotSchema } from "@stride/coach-agent";
import { addDays, mondayOnOrBefore, shanghaiDay } from "@stride/contract";
import { z } from "zod/v4";

export const FIRST_BATCH = [
  { key: "chaoyi", event: "FM", target: "2:55:00", day: "2026-10-26", kind: "new_season" },
  { key: "pan", event: "FM", target: "3:35:00", day: "2026-10-23", kind: "new_season" },
  { key: "fm-extra", event: "FM", target: "3:10:00", day: "2026-10-23", kind: "new_season" },
  { key: "hm-extra", event: "HM", target: "1:59:59", day: "2026-10-23", kind: "new_season" },
  { key: "hm-120", event: "HM", target: "1:20:00", day: "2026-10-26", kind: "new_season" },
  { key: "rolling-c", event: "FM", target: "2:55:00", day: "2026-10-26", kind: "rolling_continue" },
  { key: "rolling-d", event: "FM", target: "2:55:00", day: "2026-10-26", kind: "rolling_catch_up" },
  { key: "rolling-hm", event: "HM", target: "1:20:00", day: null, kind: "rolling_continue" },
] as const;

const fileRef = z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z
  .object({
    schema: z.literal("plan-eval-first-batch/v1"),
    snapshots: z.record(z.string(), fileRef),
    // Original artifacts / stored season content, not a re-labelled adjacent week.
    rolling_sources: z
      .object({ "rolling-c": z.union([fileRef, z.array(fileRef).nonempty()]), "rolling-hm": z.union([fileRef, z.array(fileRef).nonempty()]) })
      .strict(),
  })
  .strict();

type Snapshots = Record<string, RunnerSnapshot>;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

// Compare without printing the operands: an assertion must not dump private history.
function same(a: unknown, b: unknown, message: string): void {
  assert.ok(isDeepStrictEqual(a, b), message);
}

export function validateFirstBatch(snapshots: Snapshots): void {
  same(Object.keys(snapshots).sort(), FIRST_BATCH.map((s) => s.key).sort(), "expected exactly the eight #1048 samples");
  for (const spec of FIRST_BATCH) {
    const s = snapshots[spec.key];
    assert.ok(s, `${spec.key}: missing snapshot`);
    const parsed = RunnerSnapshotSchema.safeParse(s);
    assert.ok(parsed.success, `${spec.key}: invalid RunnerSnapshot contract`);
    assert.ok(
      s.event === spec.event && s.target_time === spec.target && (spec.day === null || s.as_of_day === spec.day) && s.generation_kind === spec.kind,
      `${spec.key}: goal, kind or fixed cutoff differs from #1048`,
    );
    assert.ok(s.records.profile && s.records.activities.length > 0, `${spec.key}: required genuine runner history is missing`);
    if (spec.kind === "new_season") {
      assert.ok(s.records.race_target && s.records.race_target.race_date > s.as_of_day, `${spec.key}: required future race target is missing`);
    }
    const cutoff = Date.parse(s.as_of ?? `${s.as_of_day}T23:59:59+08:00`);
    assert.ok(
      s.records.activities.every(
        (a) =>
          a.userId === s.records.profile?.userId &&
          a.shanghaiDay <= s.as_of_day &&
          shanghaiDay(a.date) === a.shanghaiDay &&
          Date.parse(a.date) + (a.durationS ?? 0) * 1000 <= cutoff,
      ),
      `${spec.key}: activity identity or frozen cutoff mismatch`,
    );
    assert.ok(
      [...s.records.daily_training_load, ...s.records.daily_recovery, ...s.records.race_history].every((row) => row.date <= s.as_of_day) &&
        s.records.personal_bests.every((row) => row.achievedAt === null || row.achievedAt <= s.as_of_day) &&
        (s.records.running_calibration === null || s.records.running_calibration.asOfDate <= s.as_of_day),
      `${spec.key}: historical record after frozen cutoff`,
    );
  }
  const base = snapshots.chaoyi;
  assert.ok(base);
  assert.equal(
    new Set(["chaoyi", "pan", "fm-extra", "hm-extra"].map((key) => snapshots[key]?.records.profile?.userId)).size,
    4,
    "expected four distinct runners",
  );
  for (const key of ["hm-120", "rolling-c", "rolling-d", "rolling-hm"]) {
    assert.ok(snapshots[key]?.records.profile?.userId === base.records.profile?.userId, `${key}: authorized runner identity differs`);
  }
  for (const [key, reference] of [
    ["hm-120", base],
    ["rolling-d", snapshots["rolling-c"]],
  ] as const) {
    const s = snapshots[key];
    assert.ok(s && reference);
    for (const field of [
      "profile",
      "injuries",
      "activities",
      "race_history",
      "personal_bests",
      "running_calibration",
      "daily_training_load",
      "daily_recovery",
      "sync_coverage",
    ] as const) {
      same(s.records[field], reference.records[field], `${key}: records.${field} differs from the shared frozen history`);
    }
  }
  for (const key of ["rolling-c", "rolling-d", "rolling-hm"] as const) {
    const s = snapshots[key];
    assert.ok(s);
    const active = s.records.active_master_plan;
    assert.ok(active?.status === "active", `${key}: active season required`);
    const p = active.content;
    const docs = s.records.weekly_plans;
    const rows = s.records.weekly_plan_weeks;
    assert.ok(docs && docs.length > 0 && rows?.length === docs.length, `${key}: real scheduled rows and complete documents required`);
    const last = docs.length;
    if (key !== "rolling-hm") {
      assert.ok(p.start_date === "2026-10-05" && last === (key === "rolling-d" ? 2 : 4), `${key}: fixed C/D season or last week differs from #1048`);
    }
    let master: ReturnType<typeof fromStoredContent>;
    try {
      master = fromStoredContent({ content: p, masterPlanId: active.planId, lastGeneratedWeek: last });
    } catch {
      assert.fail(`${key}: invalid stored season policy bundle`);
    }
    const start = master.planStartMonday;
    assert.ok(
      z.iso.date().safeParse(start).success && mondayOnOrBefore(start) === start && master.totalWeeks > last,
      `${key}: invalid season start or no following week`,
    );
    assert.ok(
      master.race.distance === s.event && master.race.targetTime === s.target_time && master.race.date > s.as_of_day,
      `${key}: season goal differs or is expired`,
    );
    assert.ok(s.as_of && shanghaiDay(s.as_of) === s.as_of_day, `${key}: precise frozen clock required`);
    if (key === "rolling-hm") {
      const lastStart = addDays(start, (last - 1) * 7);
      assert.ok(lastStart <= s.as_of_day && s.as_of_day <= addDays(lastStart, 6), `${key}: cutoff must cover the actual last scheduled week`);
    }
    assert.ok(s.expected_start_week === (key === "rolling-d" ? 4 : last + 1), `${key}: expected start must follow the actual last week (C/D 5/4)`);
    const planID = p.master_plan_id ?? active.planId;
    for (let i = 0; i < last; i++) {
      const day = addDays(start, i * 7);
      const doc: NonNullable<RunnerSnapshot["records"]["weekly_plans"]>[number] | undefined = docs[i];
      const row: NonNullable<RunnerSnapshot["records"]["weekly_plan_weeks"]>[number] | undefined = rows[i];
      assert.ok(
        doc?.week_start === day && doc.content.week_index === i + 1 && row?.week_start === day && row.master_plan_id === planID,
        `${key}: week ${i + 1} boundary or season identity mismatch`,
      );
    }
    same(
      p.weekly_docs,
      docs.map((d) => d.content),
      `${key}: embedded weeks differ from complete weekly documents`,
    );
  }
  const c = snapshots["rolling-c"];
  const d = snapshots["rolling-d"];
  assert.ok(c?.records.active_master_plan && d?.records.active_master_plan);
  const { weekly_docs: _c, ...cp } = c.records.active_master_plan.content;
  const { weekly_docs: _d, ...dp } = d.records.active_master_plan.content;
  same(cp, dp, "C/D must share the same fixed full-marathon season, except scheduled weeks");
  assert.ok(
    c.as_of === d.as_of &&
      c.records.active_master_plan.planId === d.records.active_master_plan.planId &&
      c.records.active_master_plan.revision === d.records.active_master_plan.revision,
    "C/D clock or active season identity differs",
  );
  same(c.records.weekly_plans?.slice(0, 2), d.records.weekly_plans, "D weeks must be the first two real C documents");
  same(c.records.weekly_plan_weeks?.slice(0, 2), d.records.weekly_plan_weeks, "D scheduled rows must be the first two C rows");
}

export async function loadFirstBatch(path: string) {
  const parsed = manifestSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  assert.ok(parsed.success, "invalid private first-batch manifest");
  const manifest = parsed.data;
  const snapshots: Snapshots = {};
  async function load(ref: z.infer<typeof fileRef>, label: string) {
    const raw = await readFile(resolve(dirname(path), ref.file));
    assert.ok(hash(raw) === ref.sha256, `${label}: source SHA-256 mismatch`);
    return JSON.parse(raw.toString("utf8"));
  }
  for (const [key, ref] of Object.entries(manifest.snapshots)) snapshots[key] = await load(ref, key);
  validateFirstBatch(snapshots);
  for (const key of ["rolling-c", "rolling-hm"] as const) {
    const refs = manifest.rolling_sources[key];
    const originals: unknown[] = [];
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      const source = await load(ref, `${key} original source`);
      const docs = source?.weekly_docs ?? source?.content?.weekly_docs;
      assert.ok(Array.isArray(docs), `${key}: original Candidate content or Artifact must contain weekly_docs`);
      originals.push(...docs);
    }
    for (const row of snapshots[key]?.records.weekly_plans ?? []) {
      assert.ok(
        originals.some((doc) => isDeepStrictEqual(doc, row.content)),
        `${key}: ${row.week_start} must match its original real weekly document; never shift an adjacent week`,
      );
    }
  }
  return { manifest, snapshots };
}

const rules = {
  new_season: [
    { id: "weekly_run_days", version: 2 },
    { id: "no_run_days", version: 1 },
    { id: "race_goal", version: 1 },
    { id: "initial_weeks", version: 1 },
  ],
  rolling: [
    { id: "weekly_run_days", version: 2 },
    { id: "no_run_days", version: 1 },
    { id: "rolling_window", version: 1 },
    { id: "catch_up_dates", version: 1 },
  ],
};
type ImportedRef = { id: string; stored_sha256: string; source_sha256: string };
type ImportState = { schema: string; origin: string; snapshots: Record<string, ImportedRef>; scenarios: Record<string, ImportedRef>; pending?: string };

/** Catalog import only: task creation and real model runs remain normal Dashboard actions. */
export async function importFirstBatch(manifestPath: string, origin: string, token: string, statePath: string) {
  const url = new URL(origin);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol) && origin === url.origin,
    "import is limited to a loopback isolated Admin Dashboard origin",
  );
  assert.ok(token, "PLAN_EVAL_ADMIN_TOKEN required");
  const { manifest, snapshots } = await loadFirstBatch(manifestPath);
  await mkdir(dirname(statePath), { recursive: true });
  const lock = await open(`${statePath}.lock`, "wx", 0o600);
  try {
    let state: ImportState;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { schema: "plan-eval-first-batch-import/v1", origin, snapshots: {}, scenarios: {} };
    }
    assert.ok(state.schema === "plan-eval-first-batch-import/v1" && state.origin === origin, "private import state belongs to another origin or format");
    assert.ok(!state.pending, "previous POST outcome is unknown; reconcile its ID in private state before retrying, do not create duplicates");
    async function save() {
      await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    }
    async function request(method: string, path: string, body?: unknown) {
      const response = await fetch(`${origin}/api/admin/plan-eval${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
      assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
      const text = await response.text();
      return { text, doc: JSON.parse(text) };
    }
    // Validate rule references before the first catalog write.
    for (const ref of [...rules.new_season, ...rules.rolling]) await request("GET", `/rules/${ref.id}/${ref.version}`);
    async function put(kind: "snapshots" | "scenarios", key: string, body: unknown, sourceSHA: string) {
      const prior = state[kind][key];
      if (prior) {
        assert.ok(prior.source_sha256 === sourceSHA, `${key}: input changed; use a new private import state`);
        const current = await request("GET", `/${kind}/${encodeURIComponent(prior.id)}`);
        assert.ok(hash(current.text) === prior.stored_sha256, `${key}: referenced catalog entry was edited; review before reusing`);
        return prior.id;
      }
      state.pending = `${kind}/${key}`;
      await save();
      const created = await request("POST", `/${kind}`, body);
      const id = kind === "snapshots" ? created.doc.snapshot_id : created.doc.id;
      assert.ok(typeof id === "string" && id.length > 0, `${key}: server did not return an ID`);
      state[kind][key] = { id, source_sha256: sourceSHA, stored_sha256: hash(created.text) };
      delete state.pending;
      await save();
      return id;
    }
    for (const spec of FIRST_BATCH) {
      const ref = manifest.snapshots[spec.key];
      assert.ok(ref);
      await put("snapshots", spec.key, snapshots[spec.key], ref.sha256);
    }
    for (const [key, artifactType, selected] of [
      ["new_season", "master_plan", FIRST_BATCH.slice(0, 5)],
      ["rolling", "weekly_plan_batch", FIRST_BATCH.slice(5)],
    ] as const) {
      const body = {
        name: `首批 · ${key}`,
        artifact_type: artifactType,
        snapshot_ids: selected.map((s) => state.snapshots[s.key]?.id),
        as_of: "",
        request: {},
        rules: rules[key],
      };
      await put("scenarios", key, body, hash(JSON.stringify(body)));
      for (const s of selected)
        await request("POST", "/request-preview", { artifact_type: artifactType, snapshot_id: state.snapshots[s.key]?.id, request: {} });
    }
    return state;
  } finally {
    await lock.close();
    await unlink(`${statePath}.lock`);
  }
}
