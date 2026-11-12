import OpenAI from "openai";
import { getBearerTokenProvider, DefaultAzureCredential } from "@azure/identity";

const endpoint = "https://word-learner-llm.services.ai.azure.com/openai/v1";
const deploymentName = "gpt-6.1-sol";
const tokenProvider = getBearerTokenProvider(
    new DefaultAzureCredential(),
    'https://ai.azure.com/.default');

const openai = new OpenAI({
    baseURL: endpoint,
    apiKey: tokenProvider
});

async function main() {

  const runner = openai.responses
    .stream({
      model: deploymentName,
      input: 'hi',
    })
    .on('event', (event) => console.log(event))
    .on('response.output_text.delta', (diff) => process.stdout.write(diff.delta));

  for await (const event of runner) {
    console.log('event', event);
  }

  const result = await runner.finalResponse();
  console.log(result.output_text);
}

main();
