import assert from "node:assert/strict";
import test from "node:test";
import { FlashRuntime } from "./agentRuntime.js";
import { ProfileAgentSession, SubmissionSchema } from "./agentSession.js";
import { ProfileAssembly, ReviewSchema } from "./assembly.js";
import { buildDeterministic } from "./deterministic.js";
import { dimensions } from "./dimensions.js";
import { Explorations } from "./exploration.js";
import { dimensionView } from "./files.js";
import { loadHistory } from "./history.js";
import { type Evidence, type Profile, ProfileSchema, type Snapshot } from "./types.js";

const row = (id: string, kind: string, content: Record<string, unknown>): Evidence => ({
  id,
  kind,
  content,
  revision: "r1",
  active: true,
  eventTime: null,
  reportedAt: null,
});
const snapshot = (): Snapshot => ({
  userId: "athlete",
  startDay: "2026-09-01",
  endDay: "2026-11-15",
  capturedAt: "2026-11-15T10:00:00Z",
  coverage: {},
  evidence: [
    row("run", "activity", {
      sport: "run_outdoor",
      shanghaiDay: "2026-11-15",
      date: "2026-11-15T10:00:00Z",
      distanceM: 10000,
      durationS: 3000,
      feelsLike: 22,
      feelNote: "我喜欢早晨跑步。",
    }),
    row("coach-text", "user_report", { markdown: "我喜欢早晨跑步。" }),
  ],
});
function oldProfile(s: Snapshot): Profile {
  return {
    prototype: true,
    userId: s.userId,
    inputHash: "original",
    evaluatedAt: s.capturedAt,
    window: { startDay: s.startDay, endDay: s.endDay },
    method: "legacy-reviewed",
    conclusions: [
      {
        id: "temperature",
        kind: "insight",
        title: "热天心率反应",
        text: "探索性配对显示较热侧心率偏高。",
        dimension: "旧环境维度",
        lifecycle: "rolling",
        conditions: "原有匹配条件",
        limitations: ["初步关联"],
        support: "preliminary_association",
        evidence: [{ id: "run", revision: "r1" }],
        sourceDates: ["2026-11-15"],
      },
    ],
    unknowns: [],
    change: { previousInputHash: null, removedConclusionIds: [], reason: "first" },
  };
}
async function assemblyFixture() {
  const s = snapshot(),
    original = oldProfile(s),
    history = loadHistory([original], s),
    code = buildDeterministic(s).entries;
  const config = {
    name: "flash",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
    api_key_env: "UNUSED_NO_MODEL_CALL",
    api_kind: "responses" as const,
    max_tokens: 1024,
    timeout_s: 1,
  };
  const runtime = new FlashRuntime(config, async () => {}, AbortSignal.timeout(10000));
  const workers = new Explorations(s, code, history, runtime);
  for (const worker of workers.planned)
    workers.reports.set(worker, { worker, attempt: 1, status: "complete", entries: [], session: new ProfileAgentSession(s, async () => {}) });
  const validation = new ProfileAgentSession(s, async () => {}, "master");
  const assembly = new ProfileAssembly(s, code, history, workers, validation);
  const id = history[0]?.id;
  assert.ok(id);
  const review = ReviewSchema.parse({
    prior: [
      {
        id,
        action: "pending_review",
        dimensionId: "response",
        nature: "association",
        replacementId: null,
        reason: "本轮未出现足以撤销原有关联的新证据，保留原有范围等待复核",
        validationReceiptId: null,
      },
    ],
    candidates: [],
    highlights: [id],
    summary: "保留温度线索，固定统计独立汇总",
  });
  await validation.calculate({
    hypothesisId: null,
    purpose: "validation",
    question: "独立复算当前有效活动数量",
    code: "return sources.filter(e=>e.kind==='activity').length;",
  });
  return { s, original, history, code, workers, validation, assembly, review, id };
}

test("every fixed entry has separate nature, source and formation; habits do not become preferences", () => {
  const entries = buildDeterministic(snapshot()).entries;
  assert(entries.length > 0);
  for (const c of entries) {
    assert.ok(c.metadata);
    assert.equal(c.dimension, dimensions[c.metadata.dimensionId]);
  }
  const habit = entries.find((c) => c.id === "code:recorded-timing");
  assert.equal(habit?.metadata?.nature, "observation");
  assert.equal(habit?.metadata?.formation, "fixed_calculation");
  assert.deepEqual(habit?.metadata?.sourceTypes, ["activity_record"]);
});

test("unmentioned historical knowledge cannot disappear and keeps its original support and scope", async () => {
  const f = await assemblyFixture(),
    before = JSON.stringify(f.original);
  assert.throws(() => f.assembly.submit({ ...f.review, prior: [] }), /every valid historical/);
  assert.throws(() => f.assembly.submit(f.review), /Inspect every/);
  f.assembly.inspect(f.id);
  f.assembly.submit(f.review);
  const profile = ProfileSchema.parse(f.assembly.profile),
    kept = profile.conclusions.find((c) => c.id === f.id);
  assert.equal(kept?.support, "preliminary_association");
  assert.equal(kept?.conditions, "原有匹配条件");
  assert.equal(kept?.metadata?.reviewStatus, "pending_review");
  assert.equal(JSON.stringify(f.original), before);
  for (const c of f.code)
    assert.deepEqual(
      profile.conclusions.find((e) => e.id === c.id),
      c,
    );
  const projected = dimensionView(profile);
  assert.equal(projected.length, 10);
  assert.equal(projected.flatMap((d) => d.items).length, profile.conclusions.length);
});

test("old observations cannot be silently relabelled as declared preferences or withdrawn without verification", async () => {
  const f = await assemblyFixture();
  f.assembly.inspect(f.id);
  const first = f.review.prior[0];
  assert.ok(first);
  assert.throws(() => f.assembly.submit({ ...f.review, prior: [{ ...first, action: "withdraw" }] }), /validation receipt/);
  assert.throws(() => f.assembly.submit({ ...f.review, prior: [{ ...first, nature: "preference" }] }), /preliminary historical association/);
});

test("withdrawn source blocks historical text and cannot be retained", async () => {
  const f = await assemblyFixture(),
    s = structuredClone(f.s);
  const activity = s.evidence[0];
  assert.ok(activity);
  activity.active = false;
  const history = loadHistory([f.original], s);
  const a = new ProfileAssembly(s, [], history, f.workers, f.validation);
  assert.deepEqual(a.inspect(f.id), { id: f.id, protected: true, reason: "Underlying source was withdrawn or revised; historical text is not exposed" });
  assert.throws(() => a.submit(f.review), /every valid historical/);
  a.submit({ ...f.review, prior: [], highlights: [] });
  assert(!a.profile?.conclusions.some((c) => c.id === f.id));
  assert.equal(a.profile?.previousDecisions?.[0]?.action, "blocked");
});

test("legacy identifiers from different profiles do not collide", () => {
  const s = snapshot(),
    a = oldProfile(s),
    b = { ...oldProfile(s), method: "another-reviewed-run" };
  const history = loadHistory([a, b], s);
  assert.equal(new Set(history.map((h) => h.id)).size, 2);
  assert.throws(() => loadHistory([{ ...a, userId: "someone-else" }], s), /another user/);
});

test("literal preference extraction needs no statistical hypothesis and cannot quote coach analysis", () => {
  const s = snapshot();
  const session = new ProfileAgentSession(s, async () => {}, "preference", ["preferences"]);
  const input = SubmissionSchema.parse({
    summary: "提取明确偏好",
    insights: [
      {
        hypothesisId: null,
        title: "本人喜欢晨跑",
        kind: "user_report",
        dimensionId: "preferences",
        nature: "preference",
        sourceIds: ["run"],
        quotes: [{ sourceId: "run", text: "我喜欢早晨跑步。" }],
        text: "本人明确表达喜欢晨跑。",
        dimension: "偏好",
        lifecycle: "long_term",
        planningUse: "确认实际时间安排后可优先考虑本人偏好的晨跑。",
        support: "single_episode",
        conditions: "本人明确表达，不从行为频率猜测",
        limitations: [],
      },
    ],
  });
  const bad = structuredClone(input);
  const badEntry = bad.insights[0];
  assert.ok(badEntry);
  badEntry.sourceIds = ["coach-text"];
  badEntry.quotes = [{ sourceId: "coach-text", text: "我喜欢早晨跑步。" }];
  assert.throws(() => session.submit(bad, null), /literal text/);
  session.submit(input, null);
  const c = session.submitted?.conclusions[0];
  assert.equal(c?.metadata?.formation, "agent_extraction");
  assert.equal(c?.metadata?.computation, "none");
  assert.equal(c?.support, undefined);
  assert.equal(c?.metadata?.nature, "preference");
});

test("an update cannot consume another history entry explicitly retained by the master", async () => {
  const f = await assemblyFixture();
  const other = loadHistory([{ ...f.original, method: "another-source" }], f.s)[0];
  assert.ok(other);
  f.history.push(other);
  f.assembly.inspect(f.id);
  f.assembly.inspect(other.id);
  const first = f.review.prior[0];
  assert.ok(first);
  const receipt = [...f.validation.receipts.keys()][0];
  assert.ok(receipt);
  assert.throws(
    () =>
      f.assembly.submit({
        ...f.review,
        prior: [
          { ...first, id: other.id, action: "retain" },
          { ...first, action: "update", replacementId: other.id, validationReceiptId: receipt },
        ],
      }),
    /included child candidate/,
  );
  assert.equal(f.assembly.profile, null);
});

test("same generator across independent runs is distinct, while carry-forward history deduplicates", async () => {
  const f = await assemblyFixture();
  const next = structuredClone(f.original);
  next.evaluatedAt = "2026-11-16T10:00:00Z";
  const entry = next.conclusions[0];
  assert.ok(entry);
  entry.text = "下一轮不同认识";
  assert.equal(loadHistory([f.original, next], f.s).length, 2);
  f.assembly.inspect(f.id);
  f.assembly.submit(f.review);
  assert.ok(f.assembly.profile);
  const forward = { ...f.assembly.profile, evaluatedAt: "2026-11-17T10:00:00Z" };
  const combined = loadHistory([f.original, forward], f.s).filter((p) => p.conclusion.title === "热天心率反应");
  assert.equal(combined.length, 1);
  assert.equal(combined[0]?.id, f.id);
  assert.ok(combined[0]?.conclusion.metadata);
});

test("merging cannot relabel historical dimensions and cannot promote preliminary associations to facts", async () => {
  const f = await assemblyFixture();
  f.assembly.inspect(f.id);
  f.assembly.submit(f.review);
  const kept = f.assembly.profile?.conclusions.find((c) => c.id === f.id);
  assert.ok(kept);
  const prior = f.history[0];
  assert.ok(prior);
  prior.conclusion = kept;
  const a = new ProfileAssembly(f.s, f.code, f.history, f.workers, f.validation);
  a.inspect(f.id);
  const decision = f.review.prior[0];
  assert.ok(decision);
  const target = f.code.find((c) => c.metadata?.dimensionId === "training" && c.metadata.nature === "observation");
  assert.ok(target);
  const receipt = [...f.validation.receipts.keys()][0];
  assert.ok(receipt);
  assert.throws(
    () =>
      a.submit({
        ...f.review,
        prior: [{ ...decision, action: "merge", dimensionId: "training", nature: "observation", replacementId: target.id, validationReceiptId: receipt }],
      }),
    /dimension\/nature/,
  );
});

test("fixed calculations do not guess the semantic dimension of user prose", () => {
  const s = snapshot();
  const activity = s.evidence[0];
  assert.ok(activity);
  activity.content.feelNote = "右膝疼痛，医生让我停跑两周。我喜欢晨跑。";
  const entries = buildDeterministic(s).entries;
  assert(!entries.some((c) => c.metadata?.quotes.length));
  assert(!entries.some((c) => c.text.includes("右膝")));
});
