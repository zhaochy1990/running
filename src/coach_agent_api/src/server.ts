import { serve } from "@hono/node-server";
import { loadConfig } from "coach_agent";
import pino from "pino";
import { loadApiConfig } from "./config.js";
import { createCoachApiRuntime } from "./runtime.js";

const logger = pino({ name: "coach-agent-api" });
const apiConfig = loadApiConfig();
const runtime = await createCoachApiRuntime(apiConfig, loadConfig());
const server = serve({ fetch: runtime.app.fetch, hostname: apiConfig.host, port: apiConfig.port }, (info) => {
  logger.info({ host: info.address, port: info.port }, "coach agent API listening");
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "shutting down");
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await runtime.close();
  } catch (error) {
    logger.error({ error, signal }, "shutdown failed");
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
