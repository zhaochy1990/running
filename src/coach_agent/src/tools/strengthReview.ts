import { isAIMessage, isHumanMessage, isToolMessage } from "@langchain/core/messages";
import { addDays, shanghaiIso } from "@stride/contract";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider, StrengthRecordSummary } from "../data/dataProvider.js";
import { defineCoachTool } from "./common.js";

const reviewSchema = z.object({
  startDay: z.iso.date().optional().describe("问题范围的上海开始日（含），单日复盘传该日。明确问最近一次但没指定日期时省略。"),
  endDay: z.iso.date().optional().describe("问题范围的上海结束日（含），单日时省略"),
  recordId: z.string().trim().min(1).max(191).optional().describe("用户选中记录后传候选返回的 ID，保持原问题的日期范围"),
  latest: z.boolean().optional().describe("仅用户明确要求最近一次时传 true"),
  watchReference: z
    .string()
    .trim()
    .min(1)
    .max(191)
    .optional()
    .describe("用户本轮明确指定的手表记录 ID、完整名称或精确上海开始时间，必须照抄原话，不得自己选择候选"),
});

function candidate(record: StrengthRecordSummary) {
  return { id: record.id, name: record.name, startedAt: shanghaiIso(record.startedAt) };
}

const TOOL_NAME = "get_strength_training_review";
const LATEST_REQUEST = /(?:最近|最后|最新)(?:的|做的)?(?:一|这|那)次|上一次|most recent|latest|last (?:session|workout)/i;
const ORDINAL = /第\s*([一二三四五六七八九十]|\d{1,2})\s*条/g;
const CHANGE_RECORD = /另(?:外)?(?:一|那)(?:条|次|场)|换(?:一|另)?(?:条|次|场)|别的(?:一)?(?:条|次|场)|(?:other|another) (?:record|workout|session)/i;
const NEGATED_SELECTION =
  /不要|不用|无需|不需要|不想|别(?:看|查|用|选|复盘|补|加|提|参考)|忽略|不看|不查|不参考|不是|以外|之外|不复盘|don['’]t|do not|without|ignore|skip|except/i;
const priorEvidenceSchema = z.object({
  status: z.enum(["found", "ambiguous"]),
  source: z.enum(["manual", "watch"]),
  scope: z.object({ startDay: z.iso.date(), endDay: z.iso.date() }),
  record: z.object({ id: z.string() }).optional(),
  candidates: z.array(z.object({ id: z.string() })).optional(),
});
type PriorEvidence = z.infer<typeof priorEvidenceSchema>;
type ReviewScope = PriorEvidence["scope"];

function choose<Record extends StrengthRecordSummary>(
  records: Record[],
  source: PriorEvidence["source"],
  input: z.infer<typeof reviewSchema>,
  userText: string,
  priorEvidence: PriorEvidence | undefined,
) {
  const recordId = input.recordId;
  if (recordId) {
    const selected = records.find((record) => record.id === recordId);
    if (!selected) return undefined;
    // A candidate ID copied out of a tool result is not an athlete's choice.
    const sourceClauses = reviewClauses(userText).filter((clause) => (source === "manual" ? !WATCH_WORD.test(clause) : !/手录|手动记录|手工录入/.test(clause)));
    const affirmative = sourceClauses.filter((clause) => !NEGATED_SELECTION.test(clause));
    const names = records.filter((record) => affirmative.some((clause) => explicitlyMentions(record, clause)));
    if (names.length > 0) return names.length === 1 && names[0] === selected ? selected : undefined;
    if (sourceClauses.some((clause) => NEGATED_SELECTION.test(clause) && explicitlyMentions(selected, clause))) return undefined;
    if (priorEvidence?.record?.id === recordId && CHANGE_RECORD.test(userText)) return undefined;
    if (records.length === 1) return selected;
    if (priorEvidence?.source !== source) return undefined;

    const choices = new Set(affirmative.flatMap((clause) => [...clause.matchAll(ORDINAL)].map((match) => match[1] ?? "")));
    if (choices.size === 1 && priorEvidence.status === "ambiguous") {
      const ordinal = [...choices][0] ?? "";
      const index = /^\d+$/.test(ordinal) ? Number(ordinal) - 1 : "一二三四五六七八九十".indexOf(ordinal);
      if (priorEvidence.candidates?.[index]?.id === recordId) return selected;
    }
    if (sourceClauses.some((clause) => clause.search(ORDINAL) >= 0)) return undefined;
    return priorEvidence.status === "found" && priorEvidence.record?.id === recordId ? selected : undefined;
  }
  if (records.length === 1) return records[0];
  const last = records.at(-1);
  if (input.latest && last?.startedAt.getTime() !== records.at(-2)?.startedAt.getTime()) return last;
  return undefined;
}

function unresolved(records: StrengthRecordSummary[], source: PriorEvidence["source"], scope: ReviewScope, recordId?: string) {
  if (records.length === 0 || (recordId && !records.some((record) => record.id === recordId))) return { status: "missing", source };
  const limit = 10;
  return { status: "ambiguous", source, scope, candidates: records.slice(-limit).map(candidate), truncated: records.length > limit };
}

function readEvidence(content: unknown): PriorEvidence | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const result = priorEvidenceSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function readConversation(state: unknown): { userText: string; priorEvidence?: PriorEvidence; activeStrengthReview?: boolean } {
  if (typeof state !== "object" || state === null || !("messages" in state) || !Array.isArray(state.messages)) return { userText: "" };
  const messages = state.messages;
  const userIndex = messages.findLastIndex(isHumanMessage);
  if (userIndex < 0) return { userText: "" };
  const previousTurn = messages.slice(0, userIndex);
  const previousUserIndex = previousTurn.findLastIndex(isHumanMessage);
  const isStrengthReview = (message: unknown) => isToolMessage(message) && message.name === TOOL_NAME;
  const previousReview = previousTurn.slice(previousUserIndex + 1).findLast(isStrengthReview);
  const currentTurn = messages.slice(userIndex + 1);
  const currentToolCalls = currentTurn.findLast(isAIMessage)?.tool_calls;
  const activeStrengthReview =
    currentToolCalls?.some((call: { name: string }) => call.name === TOOL_NAME) ||
    currentTurn.some((message) => isStrengthReview(message) && readEvidence(message.content)?.source === "manual");
  let userText = messages[userIndex].text;
  try {
    // The chat API wraps the message with a timestamp. The envelope itself
    // must not count as an athlete's reference to a date or watch record.
    const envelope = JSON.parse(userText) as { message?: unknown } | null;
    if (typeof envelope?.message === "string") userText = envelope.message;
  } catch {
    // Graph callers can also supply plain user messages.
  }
  const priorEvidence = readEvidence(previousReview?.content);
  return { userText, ...(priorEvidence ? { priorEvidence } : {}), activeStrengthReview };
}

/** Normal watch-only activity summaries can still answer general multi-sport questions. */
export function useDedicatedStrengthReview(state: unknown): boolean {
  const { userText, activeStrengthReview } = readConversation(state);
  return activeStrengthReview === true || /手录|自由力量|力量.*复盘|复盘.*力量|manual strength|review.*strength/i.test(userText);
}

function clearDay(userText: string, asof: string): string | undefined {
  if (
    /(?:从|自).{1,24}(?:到|至)|到.{1,12}为止|截至|截止|(?:过去|最近|近)[零一二三四五六七八九十两\d]+天|(?:本|这|上)周(?![一二三四五六日天])|\bbetween\b|\bthrough\b|\bthis week\b|\blast week\b/i.test(
      userText,
    )
  )
    return undefined;
  const days = new Set<string>();
  for (const match of userText.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g)) {
    if (z.iso.date().safeParse(match[0]).success) days.add(match[0]);
  }
  for (const match of userText.matchAll(/(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})(?:日|号)/g)) {
    const date = `${match[1] ?? asof.slice(0, 4)}-${match[2]?.padStart(2, "0")}-${match[3]?.padStart(2, "0")}`;
    if (z.iso.date().safeParse(date).success) days.add(match[1] === undefined && date > asof ? `${Number(date.slice(0, 4)) - 1}${date.slice(4)}` : date);
  }
  if (/今天|今日|今早|今晚|\btoday\b/i.test(userText)) days.add(asof);
  if (/明天|明日|明早|明晚|\btomorrow\b/i.test(userText)) days.add(addDays(asof, 1));
  if (/昨天|昨日|昨早|昨晚|\byesterday\b/i.test(userText)) days.add(addDays(asof, -1));
  if (/前天|前日|day before yesterday/i.test(userText)) {
    // The English phrase includes "yesterday" but refers to the earlier day.
    if (/day before yesterday/i.test(userText)) days.delete(addDays(asof, -1));
    days.add(addDays(asof, -2));
  }
  if (days.size === 1) return [...days][0];
  return undefined;
}

function references(record: StrengthRecordSummary): string[] {
  const started = shanghaiIso(record.startedAt);
  const hhmm = started.slice(11, 16);
  const hour = String(Number(hhmm.slice(0, 2)));
  const minute = hhmm.slice(3);
  const name = record.name?.trim();
  return [
    record.id,
    ...(name ? [name] : []),
    started.slice(0, 16).replace("T", " "),
    started.slice(11, 19),
    started,
    hhmm,
    `${hour}:${minute}`,
    `${hour}点${minute}`,
    `${hour}点${minute}分`,
    ...(minute === "30" ? [`${hour}点半`] : []),
  ];
}

function includesReference(text: string, reference: string): boolean {
  const startsWithDigit = /^\d/.test(reference);
  const endsWithDigit = /\d$/.test(reference);
  let position = text.indexOf(reference);
  while (position >= 0) {
    if ((!startsWithDigit || !/\d/.test(text.charAt(position - 1))) && (!endsWithDigit || !/\d/.test(text.charAt(position + reference.length)))) return true;
    position = text.indexOf(reference, position + reference.length);
  }
  return false;
}

function explicitlyMentions(record: StrengthRecordSummary, text: string): boolean {
  return references(record).some((reference) => {
    if (reference === record.name?.trim() && /^(?:\d{4}-\d{2}-\d{2}\s*)?(?:自由)?力量训练$/.test(reference)) {
      return [`「${reference}」`, `“${reference}”`, `"${reference}"`].some((quoted) => text.includes(quoted));
    }
    return includesReference(text, reference);
  });
}

const WATCH_WORD = /手表|高驰|佳明|garmin|coros|\bwatch\b/i;
const WATCH_REQUEST =
  /补充|补上|参考|结合|加上|附上|提供|带上|也看|查看|查询|看看|查一下|给我|(?:看|查|用).{0,36}(?:心率|heart rate|\bHR\b)|include|show|\badd\b|check|compare|using|\bwith\b/i;

function reviewClauses(text: string): string[] {
  return text.split(
    /[，,。；;！!？?\n]|(?:以及|或者|但是?|和|与|另外|同时)\s*(?=手录|手动|手工|手表|高驰|佳明|COROS|GARMIN|不要|不用|请|先看|再看)|\b(?:and|but)\s+(?=watch|garmin|coros|manual|don't|include|show)/i,
  );
}

function affirmedWatchClauses(text: string, reference: string): string[] {
  const referenceClauses = reviewClauses(text).filter((clause) => WATCH_WORD.test(clause) && includesReference(clause, reference));
  if (referenceClauses.some((clause) => NEGATED_SELECTION.test(clause))) return [];
  return referenceClauses.filter((clause) => WATCH_REQUEST.test(clause));
}

async function watchSupplement(store: DataProvider, userId: string, startDay: string, endDay: string, reference: string | undefined, userText: string) {
  if (reference === undefined) return {};
  // The model may choose its next tool call, but it cannot grant itself the
  // right to pick an overlapping watch record on the athlete's behalf.
  const clauses = affirmedWatchClauses(userText, reference);
  if (clauses.length === 0) return { watchSupplementStatus: "needs_explicit_reference" };
  const watches = await store.getWatchStrengthSummaries(userId, startDay, endDay);
  const matches = watches.filter((record) => references(record).includes(reference));
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (!selected) return { watchSupplementStatus: matches.length === 0 ? "missing" : "ambiguous" };
  // Requiring a single reference in the affirmative clause prevents a model
  // from substituting another activity mentioned parenthetically in that clause.
  const competingReference = watches.some(
    (record) => record !== selected && references(record).some((value) => clauses.some((clause) => includesReference(clause, value))),
  );
  if (competingReference) return { watchSupplementStatus: "ambiguous" };
  const detail = await store.getActivityDetail(userId, selected.id, { includeKilometerSplits: false });
  if (!detail) return { watchSupplementStatus: "missing" };
  return {
    watchHeartRate: {
      ...candidate(selected),
      source: "watch",
      provider: selected.provider,
      avgHr: detail.avgHr,
      maxHr: detail.maxHr,
    },
  };
}

export function createStrengthReviewTool(store: DataProvider) {
  return defineCoachTool({
    name: TOOL_NAME,
    description:
      "复盘已完成的力量训练。按用户提到的上海日期范围查找本人记录，优先手动记录。返回 ambiguous 时请用户选一条，不能猜；只有手录缺失才使用手表数据。缺失的次数、负重、心率保留未知。",
    schema: reviewSchema,
    handler: async (input, runtime: CoachToolRuntime) => {
      const userId = runtime.context?.userId;
      if (!userId) throw new Error("get_strength_training_review: missing userId in runtime context");

      const asof = runtime.context.asof;
      if (!asof) throw new Error("get_strength_training_review: missing asof in runtime context");
      const { userText, priorEvidence } = readConversation(runtime.state);
      const namedDay = clearDay(userText, asof);
      if (input.latest && !LATEST_REQUEST.test(userText)) return { status: "scope_mismatch", ...(namedDay ? { expectedDay: namedDay } : {}) };
      const inheritedScope = !namedDay && input.recordId && priorEvidence?.record?.id === input.recordId ? priorEvidence.scope : undefined;
      const endDay = input.endDay ?? namedDay ?? (input.latest ? asof : (inheritedScope?.endDay ?? input.startDay ?? asof));
      const startDay = input.startDay ?? namedDay ?? (input.latest ? "1000-01-01" : (inheritedScope?.startDay ?? endDay));
      if (namedDay && (startDay !== namedDay || endDay !== namedDay)) return { status: "scope_mismatch", expectedDay: namedDay };
      if (startDay > endDay || endDay > asof) return { status: "invalid_range" };
      const scope = { startDay, endDay };
      const inScopePrior = priorEvidence?.scope.startDay === startDay && priorEvidence.scope.endDay === endDay ? priorEvidence : undefined;
      const manual = await store.getManualStrengthSummaries(userId, startDay, endDay);
      if (manual.length > 0) {
        const selected = choose(manual, "manual", input, userText, inScopePrior);
        if (!selected) return unresolved(manual, "manual", scope, input.recordId);
        const detail = await store.getManualStrengthDetail(userId, selected.id);
        if (!detail) return { status: "missing", source: "manual" };
        return {
          status: "found",
          source: "manual",
          scope,
          record: { ...candidate(detail), endedAt: shanghaiIso(detail.endedAt), note: detail.note, actions: detail.actions },
          ...(await watchSupplement(store, userId, startDay, endDay, input.watchReference, userText)),
        };
      }

      const watches = await store.getWatchStrengthSummaries(userId, startDay, endDay);
      const selected = choose(watches, "watch", input, userText, inScopePrior);
      if (!selected) return watches.length === 0 ? { status: "missing" } : unresolved(watches, "watch", scope, input.recordId);
      const detail = await store.getActivityDetail(userId, selected.id, { includeKilometerSplits: false });
      if (!detail) return { status: "missing", source: "watch" };
      return {
        status: "found",
        source: "watch",
        scope,
        record: {
          ...candidate(selected),
          provider: selected.provider,
          durationS: detail.durationS,
          avgHr: detail.avgHr,
          maxHr: detail.maxHr,
          sets: detail.laps
            .filter(
              (lap) =>
                lap.lapType === "type2" &&
                lap.mode !== 15 &&
                lap.mode !== 16 &&
                lap.mode !== 17 &&
                lap.exerciseNameKey !== "T1123" &&
                lap.exerciseNameKey !== "S3618",
            )
            .map((lap) => ({
              lapIndex: lap.lapIndex,
              exerciseNameKey: lap.exerciseNameKey,
              durationS: lap.durationS,
              avgHr: lap.avgHr,
              maxHr: lap.maxHr,
              reps: null,
              load: null,
            })),
        },
      };
    },
  });
}
