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
} from "coach_agent";
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

const thread = "test-thread";

const cfg = {
    context: { userId, asof },
    configurable: { thread_id: thread },
  };
const startTime = Date.now();
const res = await agent.invoke({ messages: [{ role: "user", content:"我这周练的怎么样？" }] }, cfg);
const endTime = Date.now();
console.log(`\n===== 耗时 ${endTime - startTime} ms =====`);

console.log(res);
    // while (res.__interrupt__?.length && guard++ < 6) {
    //   const intr = res.__interrupt__[0]?.value;
    //   if (intr?.kind === ASK_USER_QUESTION_KIND) {
    //     console.log(`\n----- 教练想追问你 -----\n${renderQuestion(intr)}`);
    //     //     } else {
    //     //       console.log(`\n----- 教练暂停并请求输入 -----\n${JSON.stringify(intr.value)}`);
    //   }
    //   const answer = (await readAnswer()).trim();
    //   res = (await agent.invoke(new Command({ resume: answer }), cfg)) as typeof res;
    // }
// await agent.invoke({
//   messages: [{ role: "user", content: "帮我生成下周的训练计划" }],
// }, cfg);

// await agent.invoke({
//   messages: [{ role: "user", content: "我这周练的怎么样？" }],
// }, cfg);

// await agent.invoke({
//   messages: [{ role: "user", content: "我这周的训练计划是什么？" }],
// }, cfg);

await store.close();
