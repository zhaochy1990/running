/**
 * 运行：npm run build:all && STRIDE_COACH_ENV=prod \
 *       node dist/scripts/test_race_strategy.js [username] [race_event_id] [item_type] [target]
 * 默认：zhaochaoyi / 59（天津马拉松，赛道内容已调研）/ Marathon / 255。
 * race_event_id 须是 published=1 且内容调研过的 race_calendar.id，否则教练会按
 * 契约拒答（脚本会先打印预检，缺失项一目了然）。
 */
import { HumanMessage } from "@langchain/core/messages";
import { createCoachAgent, loadConfig } from "@stride/coach-agent";
import { MySqlDataProvider } from "@stride/coach-agent-worker";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";

const USERS: Record<string, string> = {
  zhaochaoyi: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
};

/** 外层图 invoke 返回：messages 全量 + 业务通道（ AgentsState.raceStrategy ）。 */
interface CoachResult {
  messages: Array<{ content: unknown; additional_kwargs?: Record<string, unknown> }>;
  raceStrategy?: unknown;
}

interface StrategyCard {
  $type?: string;
  data?: Record<string, unknown>;
}

// configPaths resolves the overlay from STRIDE_COACH_ENV；本地驱动用 prod 模型注册表。
process.env.STRIDE_COACH_ENV = "prod";

const username = process.argv[2] ?? "zhaochaoyi";
const userId = USERS[username];
if (!userId) {
  console.error(`Unknown username: ${username}. Valid: ${Object.keys(USERS).join(", ")}`);
  process.exit(1);
}
const raceEventId = Number(process.argv[3] ?? 59);
if (!Number.isInteger(raceEventId) || raceEventId <= 0) {
  console.error(`Invalid race_event_id: ${process.argv[3]}（须为 race_calendar.id 正整数）`);
  process.exit(1);
}
const itemType = process.argv[4] ?? "Marathon";
const targetPhrase = process.argv[5] ?? "255";

const asof = new Date().toISOString().slice(0, 10);
const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const provider = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
// 只建一次：MemorySaver checkpointer 随 graph 走，重建会丢掉第 1 轮的会话。
const agent = await createCoachAgent(provider, config);

console.log(`driving coach graph for ${username} (${userId}), race=#${raceEventId} ${itemType}, target=${targetPhrase}, asof=${asof}`);

try {
  // 预检：赛事存在性 + prompt 第 2 步的内容门槛（四项全缺才拒答，这里只做展示）。
  const calendar = await provider.getRaceCalendarContext(raceEventId);
  if (calendar === null) {
    console.error(`race_calendar #${raceEventId} 不存在或未发布（published=1），策略上下文拿不到。`);
    process.exit(1);
  }
  console.log(`\n[预检] ${calendar.name_cn ?? calendar.name} · ${calendar.race_date} · ${calendar.province ?? ""}${calendar.city ?? ""} · source=${calendar.content_source ?? "(none)"}`);
  const targetItem = calendar.items.find((item) => item.item_type === itemType);
  if (!targetItem) {
    console.error(`[预检] 赛事没有 ${itemType} 项目行（现有: ${calendar.items.map((i) => i.item_type).join(", ") || "无"}），item_type 与 race_calendar_item.type 不同词。`);
    process.exit(1);
  }
  const missing = [
    targetItem.route_description ? null : "route_description",
    targetItem.total_ascent_m === null || targetItem.total_ascent_m === undefined ? "total_ascent_m" : null,
    targetItem.course_challenges.length > 0 ? null : "course_challenges",
    targetItem.cutoffs.length > 0 ? null : "cutoffs",
  ].filter((field): field is string => field !== null);
  console.log(
    `[预检] ${itemType} 内容: route=${targetItem.route_description ? "✓" : "✗"} ascent=${targetItem.total_ascent_m ?? "✗"} challenges=${targetItem.course_challenges.length} cutoffs=${targetItem.cutoffs.length} aid=${targetItem.aid_stations.length}` +
      (missing.length === 4 ? " ← 四项全缺，教练将按契约拒答" : missing.length > 0 ? `（缺 ${missing.join("/")}，不拦）` : "（齐）"),
  );

  const threadId = `e2e-race-strategy-${Date.now()}`;
  const invokeConfig = {
    context: { userId, asof, target: { kind: "race", race_event_id: raceEventId, item_type: itemType } },
    configurable: { thread_id: threadId },
  };

  // 第 1 轮：小程序策略卡 kickoff（按钮即意图，不带目标时间）→ 预期追问。
  const kickoff = `我想和你聊聊「${calendar.name_cn ?? calendar.name}」的比赛策略`;
  console.log(`\n===== 第 1 轮 thread=${threadId} =====\nuser: ${kickoff}`);
  const startedAt = Date.now();
  const first = (await agent.invoke({ messages: [new HumanMessage(kickoff)] }, invokeConfig)) as CoachResult;
  printTurn(first, 800);
  const firstCard = lastCard(first);
  console.log(firstCard === undefined ? "✓ 第 1 轮未出结构化策略（符合预期的追问轮）" : "⚠️ 第 1 轮就出了结构化策略（未先确认目标）");

  // 第 2 轮：补目标完赛时间 → 预期结构化信封出卡。
  const followUp = `${targetPhrase}，按这个目标帮我出一版策略`;
  console.log(`\n===== 第 2 轮 =====\nuser: ${followUp}`);
  const second = (await agent.invoke({ messages: [new HumanMessage(followUp)] }, invokeConfig)) as CoachResult;
  console.log(`(${Math.round((Date.now() - startedAt) / 1000)}s since turn 1 start)`);
  printTurn(second, 2400);
  const strategy = second.raceStrategy ?? cardStrategy(second);
  if (strategy === undefined || strategy === null) {
    console.error("\n✗ 第 2 轮没有产出结构化 RaceStrategy（raceStrategy 通道与 card 信封都为空）");
    process.exitCode = 1;
  } else {
    const s = strategy as Record<string, unknown>;
    console.log(`\n✓ RaceStrategy: target=${s.target_finish_time} segments=${Array.isArray(s.pace_segments) ? s.pace_segments.length : "?"}`);
    console.log(JSON.stringify(strategy, null, 2).slice(0, 3000));
  }
} finally {
  await provider.close();
}

function lastText(result: CoachResult): string {
  const last = result.messages.at(-1);
  if (!last) return "(no messages)";
  // 数组 content（text parts 拼接）与字符串 content 两种形态都要可读。
  if (Array.isArray(last.content)) {
    return last.content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

function lastCard(result: CoachResult): StrategyCard | undefined {
  const last = result.messages.at(-1);
  const card = last?.additional_kwargs?.card as StrategyCard | undefined;
  return card?.$type === "race-strategy" ? card : undefined;
}

function cardStrategy(result: CoachResult): unknown {
  return lastCard(result)?.data;
}

function printTurn(result: CoachResult, maxChars: number): void {
  console.log(`coach (${result.messages.length} msgs in thread):`);
  console.log(lastText(result).slice(0, maxChars));
}
