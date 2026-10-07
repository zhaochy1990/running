/**
 * 本地 E2E：完整 coach 图跑一轮「制定赛季训练计划」（deepagent 版
 * generate-master-plan agent），验证 orchestrator 路由 → 内层生成 → 宽松信封
 * 解析 → markdown+卡片消息全链路。MemorySaver checkpoint，无外部依赖。
 *
 * 运行：npm run build:all && STRIDE_COACH_ENV=prod node dist/scripts/test_master_plan_agent.js
 * （DEEPSEEK_API_KEY 需在环境里；工具只读，不写任何数据。）
 */
import { HumanMessage } from "@langchain/core/messages";
import { createCoachAgent, loadConfig } from "@stride/coach-agent";
import { MySqlDataProvider } from "@stride/coach-agent-worker";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";

const USERS: Record<string, string> = {
  zhaochaoyi: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
};

// configPaths resolves the overlay from STRIDE_COACH_ENV；本地驱动用 prod 模型注册表。
process.env.STRIDE_COACH_ENV = "prod";

const username = process.argv[2] ?? "zhaochaoyi";
const userId = USERS[username];
if (!userId) {
  console.error(`Unknown username: ${username}. Valid: ${Object.keys(USERS).join(", ")}`);
  process.exit(1);
}

const asof = new Date().toISOString().slice(0, 10);
const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const provider = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
const agent = await createCoachAgent(provider, config);

console.log(`driving coach graph for ${username} (${userId}), asof=${asof}`);
const startedAt = Date.now();
try {
  const result = (await agent.invoke(
    { messages: [new HumanMessage("帮我重新制定赛季训练计划")] },
    { context: { userId, asof }, configurable: { thread_id: `e2e-master-plan-${startedAt}` } },
  )) as { messages: Array<{ content: unknown; additional_kwargs?: Record<string, unknown>; _getType?: () => string }> };

  const elapsed = Date.now() - startedAt;
  const last = result.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
  console.log(`\n===== ${elapsed}ms, ${result.messages.length} message(s) in thread =====`);
  console.log(text.slice(0, 1500));
  const card = last?.additional_kwargs?.card as Record<string, unknown> | undefined;
  console.log("\ncard:", card ? JSON.stringify(card).slice(0, 300) : "(none)");
} finally {
  await provider.close();
}
