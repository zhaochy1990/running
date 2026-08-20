import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Command } from "@langchain/langgraph";
import { MasterPlanSchema } from "@stride/contract";
import { createCoachAgent } from "../agents/coachAgent.js";
import { loadConfig, readStrideMySqlConfig } from "../config/config.js";
import {
	MySqlMasterPlanContextProvider,
	StrideDataStore,
} from "../persistence/index.js";
import {
	ASK_USER_QUESTION_KIND,
	type AskUserQuestionPayload,
} from "../tools/askUserQuestions.js";
import {
	formatTokenUsageReport,
	LlmTokenUsageTracker,
} from "../utils/tokenUsage.js";

const usernameMap: Record<string, string> = {
	pan: "5ee229a6-cdc1-4260-84d3-71ec622126c2",
	dingchentao: "7bd56762-3b04-42a6-9d8b-98f595628430",
	lvge: "0a74ac88-629e-4b8e-97c8-d49ccf5a986b",
	dehua: "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9",
	renzhen: "bffa65bc-4501-41e7-a68c-96da76d5b7bc",
	zhaochaoyi: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
};

function requireUserId(): { userId: string; username: string } {
	const username = process.argv[2];
	if (!username) {
		console.error("Missing username. Usage: npm run test:deepagent -- <user>");
		process.exit(1);
	}
	const userId = usernameMap[username];
	if (!userId) {
		console.error(
			`Unknown username: ${username}. Valid usernames: ${Object.keys(
				usernameMap,
			).join(", ")}`,
		);
		process.exit(1);
	}
	return { userId, username };
}

const { userId, username } = requireUserId();
const config = loadConfig();
const store = StrideDataStore.create(readStrideMySqlConfig(config));
const agent = await createCoachAgent(store, config);
const masterPlanContextProvider = new MySqlMasterPlanContextProvider(store);

console.log(`Using userId: ${userId}`);

const asof = "2026-08-16";

const res = await masterPlanContextProvider.loadSnapshot(userId, asof);
console.log(res);
const raceTarget = res.race_target;
if (!raceTarget) {
	console.error(`No active race target found for user ID: ${userId}`);
	process.exit(1);
}

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
const scriptedAnswers = (process.env.HITL_ANSWERS ?? "")
	.split("\n")
	.filter((s) => s.length > 0);
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

	const rawJson = MasterPlanSchema.parse(
		typeof content === "string" ? JSON.parse(content) : content,
	);

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hour = String(now.getHours()).padStart(2, "0");
	const minute = String(now.getMinutes()).padStart(2, "0");
	const second = String(now.getSeconds()).padStart(2, "0");

	// YYYY-MM-DD_hh:mm:ss_{userId}.json
	var outputFileName = `${year}-${month}-${day}_${hour}:${minute}:${second}_${username}.json`;

	writeFileSync(
		`./test-output/master-plan/${outputFileName}`,
		JSON.stringify(rawJson, null, 2),
	);
	console.log(`\n===== 最后回答已写入 ./test-output/${outputFileName} =====`);
}

/** 把 ask_user_question 的 interrupt payload 渲染成给运动员看的追问文本。 */
function renderQuestion(value: AskUserQuestionPayload): string {
	const lines: string[] = [];
	if (value.header) lines.push(`【${value.header}】`);
	lines.push(value.question);
	value.options.forEach((o, i) => {
		lines.push(
			`  ${i + 1}. ${o.label}${o.description ? ` —— ${o.description}` : ""}`,
		);
	});
	if (value.options.length) {
		lines.push(
			value.allowMultiple
				? "（可多选，逗号分隔序号，或直接自由作答）"
				: "（可选一个序号，或直接自由作答）",
		);
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
		let res = (await agent.invoke(
			{ messages: [{ role: "user", content }] },
			cfg,
		)) as {
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
			res = (await agent.invoke(
				new Command({ resume: answer }),
				cfg,
			)) as typeof res;
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

await askWithHITL(
	`帮助用户生成赛季训练计划。使用已保存的比赛目标：${raceTarget.race_distance}，比赛日期 ${raceTarget.race_date}，目标成绩 ${raceTarget.target_finish_time}，目标比赛 ${raceTarget.race_name}，每周训练 ${raceTarget.weekly_training_days} 天。根据用户档案和训练记录处理伤病及其他约束。`,
	"session-master-plan",
);

await rl.close();
await store.close();
