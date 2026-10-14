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
import { MySqlDataProvider } from "@stride/coach-agent-worker";
import { shanghaiDay, shanghaiIso } from '@stride/contract';

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

// const question = "我上周日晚上跑的怎么样？";
const question = "帮我分析一下近期的HRV，RHR";

const input ={ 
  messages: [{ 
    role: "user", 
    content: JSON.stringify({timestamp:  shanghaiIso(),message: question}), 
  }] 
};
const res = await agent.invoke(input, cfg);
const endTime = Date.now();
console.log(`\n===== 耗时 ${endTime - startTime} ms =====`);
console.log("Intent: ", res.intent?.intent);

const messageCnt = res.messages.length;
console.log(`\n===== 消息数量 ${messageCnt} =====`);

console.log("\n===== Final Response from AI =====");
console.log(res.messages.at(-1)?.content);


await store.close();
