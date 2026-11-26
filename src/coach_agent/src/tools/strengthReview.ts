import { isHumanMessage, isToolMessage } from "@langchain/core/messages";
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
const LATEST_REQUEST = /最近.+次|最后.+次|上一次|最新.+次|most recent|latest|last (?:session|workout)/i;
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
    if (!selected || records.length === 1) return selected;
    // A candidate ID copied out of a tool result is not an athlete's choice.
    const sourceClauses = reviewClauses(userText).filter((clause) => (source === "manual" ? !WATCH_WORD.test(clause) : !/手录|手动记录|手工录入/.test(clause)));
    const matches = records.filter((record) => sourceClauses.some((clause) => explicitlyMentions(record, clause)));
    if (matches.length > 0) return matches.length === 1 && matches[0] === selected ? selected : undefined;
    if (priorEvidence?.source !== source) return undefined;
    if (priorEvidence.status === "found" && priorEvidence.record?.id === recordId) return selected;
    const ordinal = /第\s*([一二三四五六七八九十]|\d{1,2})\s*条/.exec(userText)?.[1];
    if (ordinal && priorEvidence.status === "ambiguous") {
      const index = /^\d+$/.test(ordinal) ? Number(ordinal) - 1 : "一二三四五六七八九十".indexOf(ordinal);
      if (priorEvidence.candidates?.[index]?.id === recordId) return selected;
    }
    return undefined;
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

function readConversation(state: unknown): { userText: string; priorEvidence?: PriorEvidence } {
  if (typeof state !== "object" || state === null || !("messages" in state) || !Array.isArray(state.messages)) return { userText: "" };
  const messages = state.messages;
  const userIndex = messages.findLastIndex(isHumanMessage);
  if (userIndex < 0) return { userText: "" };
  const previousTurn = messages.slice(0, userIndex);
  const previousUserIndex = previousTurn.findLastIndex(isHumanMessage);
  const previousReview = previousTurn.slice(previousUserIndex + 1).findLast((message) => isToolMessage(message) && message.name === TOOL_NAME);
  let userText = messages[userIndex].text;
  try {
    // The chat API wraps the message with a timestamp. The envelope itself
    // must not count as an athlete's reference to a date or watch record.
    const envelope = JSON.parse(userText) as { message?: unknown } | null;
    if (typeof envelope?.message === "string") userText = envelope.message;
  } catch {
    // Graph callers can also supply plain user messages.
  }
  if (typeof previousReview?.content !== "string") return { userText };
  try {
    const result = priorEvidenceSchema.safeParse(JSON.parse(previousReview.content));
    if (result.success) return { userText, priorEvidence: result.data };
  } catch {
    // Earlier failed tool calls carry plain error text.
  }
  return { userText };
}

function clearDay(userText: string, asof: string): string | undefined {
  if (/(?:从|自).{1,24}(?:到|至)|到.{1,12}为止|\bbetween\b|\bthrough\b/i.test(userText)) return undefined;
  const days = new Set<string>();
  for (const match of userText.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g)) {
    if (z.iso.date().safeParse(match[0]).success) days.add(match[0]);
  }
  for (const match of userText.matchAll(/(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})(?:日|号)/g)) {
    const date = `${match[1] ?? asof.slice(0, 4)}-${match[2]?.padStart(2, "0")}-${match[3]?.padStart(2, "0")}`;
    if (z.iso.date().safeParse(date).success) days.add(match[1] === undefined && date > asof ? `${Number(date.slice(0, 4)) - 1}${date.slice(4)}` : date);
  }
  if (/今天|今日|今早|今晚|\btoday\b/i.test(userText)) days.add(asof);
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
const DECLINES_WATCH = /不要|不用|无需|不需要|不想|别|忽略|不看|不查|不参考|don['’]t|do not|without|ignore|skip/i;
const WATCH_REQUEST = /补|看|查|给|标|带|附|用|参考|结合|加上|提供|include|show|add|check|compare|using|with/i;

function reviewClauses(text: string): string[] {
  return text.split(/[，,。；;！!？?\n]|以及|或者|但是?|和|与|另外|同时|\band\b|\bbut\b/i);
}

function confirmsWatchReference(text: string, reference: string): boolean {
  const clauses = reviewClauses(text);
  const watchReferenceClauses = clauses.filter((clause) => WATCH_WORD.test(clause) && includesReference(clause, reference));
  return (
    watchReferenceClauses.length > 0 &&
    !watchReferenceClauses.some((clause) => DECLINES_WATCH.test(clause)) &&
    clauses.some((clause) => WATCH_WORD.test(clause) && WATCH_REQUEST.test(clause) && !DECLINES_WATCH.test(clause))
  );
}

async function watchSupplement(store: DataProvider, userId: string, startDay: string, endDay: string, reference: string | undefined, userText: string) {
  if (reference === undefined) return {};
  // The model may choose its next tool call, but it cannot grant itself the
  // right to pick an overlapping watch record on the athlete's behalf.
  if (!confirmsWatchReference(userText, reference)) {
    return { watchSupplementStatus: "needs_explicit_reference" };
  }
  const watches = await store.getWatchStrengthSummaries(userId, startDay, endDay);
  const matches = watches.filter((record) => references(record).includes(reference));
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (!selected) return { watchSupplementStatus: matches.length === 0 ? "missing" : "ambiguous" };
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
