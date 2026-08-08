import { loadConfig, readStrideMySqlConfig } from './config/config.js';
import { createCoachAgent } from './agents/coachAgent.js';
import { StrideDataStore } from './persistence/index.js';
import { ASK_USER_QUESTION_KIND, type AskUserQuestionPayload } from './tools/askUserQuestions.js';
import { Command } from '@langchain/langgraph';
import { createInterface } from 'node:readline/promises';
import { context } from 'langchain';

const config = loadConfig();
const store = StrideDataStore.create(readStrideMySqlConfig(config));
const agent = await createCoachAgent(store, config);

// const userId = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const userId = "11c2e582-5a85-4633-81d2-df7e37ad7b48";

const cfg = { context: { userId }, configurable: { thread_id: 'thread_id_1' } };

await agent.invoke({
  messages: [{ role: "user", content: "帮我生成训练计划" }],
}, cfg);

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
// const scriptedAnswers = (process.env.HITL_ANSWERS ?? "").split("\n").filter((s) => s.length > 0);
// let scriptCursor = 0;
const rl = createInterface({ input: process.stdin, output: process.stdout });

// async function readAnswer(): Promise<string> {
//   if (scriptCursor < scriptedAnswers.length) {
//     const answer = scriptedAnswers[scriptCursor++]!;
//     console.log(`你的回答 > ${answer}   (scripted)`);
//     return answer;
//   }
//   return (await rl.question("你的回答 > ")).trim();
// }

// function printAnswer(label: string, res: { messages: Array<{ content: unknown }> }): void {
//   const last = res.messages.at(-1);
//   const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
//   console.log(`\n===== ${label} =====\n${text}`);
// }

// /** 把 ask_user_question 的 interrupt payload 渲染成给运动员看的追问文本。 */
// function renderQuestion(value: AskUserQuestionPayload): string {
//   const lines: string[] = [];
//   if (value.header) lines.push(`【${value.header}】`);
//   lines.push(value.question);
//   value.options.forEach((o, i) => {
//     lines.push(`  ${i + 1}. ${o.label}${o.description ? ` —— ${o.description}` : ""}`);
//   });
//   if (value.options.length) {
//     lines.push(value.allowMultiple ? "（可多选，逗号分隔序号，或直接自由作答）" : "（可选一个序号，或直接自由作答）");
//   }
//   return lines.join("\n");
// }

// /**
//  * 带 human-in-the-loop 的一问一答：invoke 后若图被 ask_user_question 暂停
//  * （返回 __interrupt__），就把问题打给运动员、读取回答、用 Command({ resume })
//  * 恢复，直到没有新的追问为止。
//  */
// async function askWithHITL(label: string, content: string, thread: string): Promise<void> {
//   const cfg = { context: { userId }, configurable: { thread_id: thread } };
//   const startTime = Date.now();
//   let res = await agent.invoke({ messages: [{ role: "user", content }] }, cfg) as {
//     messages: Array<{ content: unknown }>;
//     __interrupt__?: Array<{ value: AskUserQuestionPayload }>;
//   };

//   let guard = 0;
//   while (res.__interrupt__?.length && guard++ < 6) {
//     const intr = res.__interrupt__[0]!;
//     if (intr.value?.kind === ASK_USER_QUESTION_KIND) {
//       console.log(`\n----- 教练想追问你 -----\n${renderQuestion(intr.value)}`);
//     } else {
//       console.log(`\n----- 教练暂停并请求输入 -----\n${JSON.stringify(intr.value)}`);
//     }
//     const answer = (await readAnswer()).trim();
//     res = await agent.invoke(new Command({ resume: answer }), cfg) as typeof res;
//   }

//   const endTime = Date.now();
//   printAnswer(label, res);
//   console.log(`Request took ${endTime - startTime} ms`);
// }

// // ── Scenario：生成赛季计划 → Coach 先回看历史比赛 → 若发现跑崩则追问原因 ──
// await askWithHITL(
//   "生成赛季计划 → 分析历史比赛 → 追问跑崩原因",
//   "帮我生成一个新的赛季训练计划，目标是明年上海马拉松 sub-3:10。",
//   "sess-master",
// );

// // ── 其它可选回归（默认注释）──
// // await askWithHITL("训练问答 → 负荷分析", "我最近的训练负荷和疲劳状态怎么样？现在能加量吗？", "sess-load");

await rl.close();
await store.close();
