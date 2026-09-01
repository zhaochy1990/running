import { type CoachAgentConfig, createCoachAgent } from "@stride/coach-agent";
import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth.js";
import { MySqlDataProvider } from "./data/mysqlDataProvider.js";
import type { ApiConfig } from "./dto/config.js";
import { createPersistence, type Persistence } from "./persistence/index.js";
import { CoachInvokerImpl } from "./coach/coachInvoker.js";

export interface CoachApiRuntime {
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** Compose API-owned adapters and release partial resources if startup fails. */
export async function createCoachApiRuntime(apiConfig: ApiConfig, coachConfig: CoachAgentConfig): Promise<CoachApiRuntime> {
  const dataProvider = MySqlDataProvider.create(apiConfig.strideDatabase);
  let persistence: Persistence | undefined;
  try {
    persistence = await createPersistence(apiConfig.persistenceDatabase);
    const coachInvoker = new CoachInvokerImpl(dataProvider, coachConfig, persistence);
    await coachInvoker.initialize();

    const jwtVerifier = createJwtVerifier(apiConfig.auth);
    return {
      app: createApp({
        jwtVerifier,
        turnCoordinator: persistence.turnCoordinator,
        coachInvoker: coachInvoker,
      }),
      close: () => Promise.all([dataProvider.close(), persistence?.close()]).then(() => undefined),
    };
  } catch (error) {
    await Promise.allSettled([dataProvider.close(), ...(persistence ? [persistence.close()] : [])]);
    throw error;
  }
}
