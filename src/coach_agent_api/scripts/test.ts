import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  ASK_USER_QUESTION_KIND,
  type AskUserQuestionPayload,
  Command,
  createCoachAgent,
  formatTokenUsageReport,
  LlmTokenUsageTracker,
  loadConfig,
  MasterPlanSchema,
} from "@stride/coach-agent";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";
import { MySqlDataProvider } from "../src/data/mysqlDataProvider.js";
import { shanghaiDay } from '@stride/contract';

const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
const agent = await createCoachAgent(store, config);

const userId = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const asof = shanghaiDay(new Date().toISOString());

console.log("ASOF:", asof.toString(), "USER_ID:", userId);
// const userId = "11c2e582-5a85-4633-81d2-df7e37ad7b48";

// await agent.invoke({
//   messages: [{ role: "user", content: "帮我生成下周的训练计划" }],
// }, cfg);

// await agent.invoke({
//   messages: [{ role: "user", content: "我这周练的怎么样？" }],
// }, cfg);

// await agent.invoke({
//   messages: [{ role: "user", content: "我这周的训练计划是什么？" }],
// }, cfg);

// 回答来源：交互式从 stdin 读；自动化测试则用 HITL_ANSWERS（\n 分隔）按序喂入，
// 避免管道 EOF 关闭 readline 的问题。
const scriptedAnswers = (process.env.HITL_ANSWERS ?? "").split("\n").filter((s) => s.length > 0);
let scriptCursor = 0;
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function readAnswer(): Promise<string> {
  if (scriptCursor < scriptedAnswers.length) {
    const answer = scriptedAnswers[scriptCursor++];
    if (answer === undefined) throw new Error("scripted answer is missing");
    console.log(`你的回答 > ${answer}   (scripted)`);
    return answer;
  }
  return (await rl.question("你的回答 > ")).trim();
}

function printAnswer(res: { messages: Array<{ content: unknown }> }): void {
  const last = res.messages.at(-1);
  const content = last?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  console.log(`\n===== 最后回答 =====\n${text}`);

  const rawJson = MasterPlanSchema.parse(typeof content === "string" ? JSON.parse(content) : content);

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");

  // YYYY-MM-DD_hh:mm:ss_{userId}.json
  var outputFileName = `${year}-${month}-${day}_${hour}:${minute}:${second}_${userId}.json`;

  writeFileSync(`./test-output/${outputFileName}`, JSON.stringify(rawJson, null, 2));
  console.log(`\n===== 最后回答已写入 ./test-output/${outputFileName} =====`);
}

/** 把 ask_user_question 的 interrupt payload 渲染成给运动员看的追问文本。 */
function renderQuestion(value: AskUserQuestionPayload): string {
  const lines: string[] = [];
  if (value.header) lines.push(`【${value.header}】`);
  lines.push(value.question);
  value.options.forEach((o, i) => {
    lines.push(`  ${i + 1}. ${o.label}${o.description ? ` —— ${o.description}` : ""}`);
  });
  if (value.options.length) {
    lines.push(value.allowMultiple ? "（可多选，逗号分隔序号，或直接自由作答）" : "（可选一个序号，或直接自由作答）");
  }
  return lines.join("\n");
}

/**
 * 带 human-in-the-loop 的一问一答：invoke 后若图被 ask_user_question 暂停
 * （返回 __interrupt__），就把问题打给运动员、读取回答、用 Command({ resume })
 * 恢复，直到没有新的追问为止。
 */
async function askWithHITL(content: string, thread: string): Promise<void> {
  const tokenUsage = new LlmTokenUsageTracker();
  const cfg = {
    context: { userId, asof },
    configurable: { thread_id: thread },
    callbacks: [tokenUsage],
  };
  const startTime = Date.now();
  try {
    let res = (await agent.invoke({ messages: [{ role: "user", content }] }, cfg)) as {
      messages: Array<{ content: unknown }>;
      __interrupt__?: Array<{ value: AskUserQuestionPayload }>;
    };

    let guard = 0;
    while (res.__interrupt__?.length && guard++ < 6) {
      const intr = res.__interrupt__[0]?.value;
      if (intr?.kind === ASK_USER_QUESTION_KIND) {
        console.log(`\n----- 教练想追问你 -----\n${renderQuestion(intr)}`);
        //     } else {
        //       console.log(`\n----- 教练暂停并请求输入 -----\n${JSON.stringify(intr.value)}`);
      }
      const answer = (await readAnswer()).trim();
      res = (await agent.invoke(new Command({ resume: answer }), cfg)) as typeof res;
    }

    printAnswer(res);
  } finally {
    console.log(`Request took ${Date.now() - startTime} ms`);
    console.log(`\n${formatTokenUsageReport(tokenUsage.summary())}`);
  }
}

// // ── Scenario：生成赛季计划 → Coach 先回看历史比赛 → 若发现跑崩则追问原因 ──
// await askWithHITL(
//   "生成赛季计划 → 分析历史比赛 → 追问跑崩原因",
//   "帮我生成一个新的赛季训练计划，目标是明年上海马拉松 sub-3:10。",
//   "sess-master",
// );

// Test race goal: 2026-10-18 西安马拉松，目标 2:50:00，全马；每周 6 天训练，单次不超过 3 小时，无伤病。
// await askWithHITL(
//   "帮我生成一个新的赛季训练计划，目标是 2026-10-18 西安马拉松 2:50:00。全马；每周可训练 6 天，单次不超过 3 小时，目前无伤病。",
//   "session-master-plan",
// );

await askWithHITL("今天是哪天？", "123");

await rl.close();
await store.close();
