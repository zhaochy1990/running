import { buildModel, getAgentConfig, loadConfig, type ModelConfig } from '@stride/coach-agent';
import { coachAgentConfigFiles } from '../src/configPaths.js';
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI, ChatOpenAIResponses } from "@langchain/openai";
import { z } from "zod";

const no_thinking: ModelConfig = {
  name: 'deepseekv4flash',
  provider: 'openai-compatible',
  model: 'deepseek-v4-flash',
  endpoint: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  auth: 'api-key',
  api_kind: 'chat-completions',
  max_tokens: 16384,
  timeout_s: 120,
  reasoning_effort: 'low',
  thinking: 'disabled'
}

const thinking: ModelConfig = {
  name: 'deepseekv4flash',
  provider: 'openai-compatible',
  model: 'deepseek-v4-flash',
  endpoint: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  auth: 'api-key',
  api_kind: 'chat-completions',
  max_tokens: 16384,
  timeout_s: 120,
  reasoning_effort: 'high',
  thinking: 'enabled'
}

async function main() {
    const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
    // const qaConfig = getAgentConfig(config, 'qa');
    // console.log(qaConfig);


    const model = buildModel(thinking);
    
    // await testStream(model);
    await testWithStructuredOutput(model);
}

async function testNonStream(model: ChatOpenAI | ChatOpenAIResponses) {
    const resp = await model.invoke('hi');

    const response_metadata = resp.response_metadata;
    console.log('finish_reason: ', response_metadata?.finish_reason);
    console.log('model_name', response_metadata?.model_name);
    
    console.log('usage, ', JSON.stringify(response_metadata?.usage, null, 2));

    const reasoning_content = extractThinkingAndText(resp);
    console.log('reasoning_content: ', reasoning_content);
}

async function testStream(model: ChatOpenAI | ChatOpenAIResponses) {
    const messages = [
    new HumanMessage("请简单解释什么是大语言模型"),
  ];

  const stream = await model.stream(messages);

  for await (const chunk of stream) {
    console.log(chunk.text)
 }
}

async function testWithStructuredOutput(model: ChatOpenAI | ChatOpenAIResponses) {
    const RecipeSchema = z.object({
        name: z.string().describe("菜品名称"),
        ingredients: z.array(z.string()).describe("食材列表"),
        steps: z.array(z.string()).describe("制作步骤"),
        prepTimeMinutes: z.number().describe("准备时间（分钟）"),
    });


    const modelWithStructure = model.withStructuredOutput(RecipeSchema);
    const response = await modelWithStructure.invoke("生成一个简单番茄炒蛋的菜谱");
    console.log(response);
}


type TextContentBlock = {
  type: "text";
  text: string;
};

// Non-Stream
function extractThinkingAndText(msg: AIMessage| AIMessageChunk): { reasoning: string; text: string } {
    // 1. 思考内容：在 additional_kwargs.reasoning_content（字符串）
  const reasoning = (msg.additional_kwargs?.reasoning_content as string) ?? "";

  // 2. 最终回答：遍历 content 数组，累加所有 type="text" 的文本
  let text = "";
  if (Array.isArray(msg.content)) {
    text = msg.content
      .filter((block): block is TextContentBlock => block.type === "text")
      .map(block => block.text)
      .join("");
  } else if (typeof msg.content === "string") {
    text = msg.content;
  }

    return { reasoning, text };
}



await main()