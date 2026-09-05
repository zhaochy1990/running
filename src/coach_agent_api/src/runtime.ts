import type { CoachAgentConfig } from "@stride/coach-agent";
import { createApp } from "./app.js";
import { createJwtVerifier, fetchAuthPublicKey } from "./auth.js";
import { CoachInvokerImpl } from "./coach/coachInvoker.js";
import { MySqlDataProvider } from "./data/mysqlDataProvider.js";
import type { ApiConfig } from "./dto/config.js";
import { createPersistence, type Persistence } from "./persistence/index.js";

export interface CoachApiRuntime {
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** Use the configured inline/file key, otherwise fetch it from the auth-service at startup. */
async function resolvePublicKeyPem(auth: ApiConfig["auth"]): Promise<string> {
  if (auth.publicKeyPem) {
    return auth.publicKeyPem;
  }
  if (!auth.authServiceUrl) {
    throw new Error("auth.public_key_pem, auth.public_key_path, or auth.auth_service_url must be configured");
  }
  return fetchAuthPublicKey(auth.authServiceUrl);
}

/** Compose API-owned adapters and release partial resources if startup fails. */
export async function createCoachApiRuntime(apiConfig: ApiConfig, coachConfig: CoachAgentConfig): Promise<CoachApiRuntime> {
  const dataProvider = MySqlDataProvider.create(apiConfig.strideDatabase);
  let persistence: Persistence | undefined;
  try {
    persistence = await createPersistence(apiConfig.persistenceDatabase);
    const coachInvoker = new CoachInvokerImpl(dataProvider, coachConfig, persistence);
    await coachInvoker.initialize();

    const jwtVerifier = createJwtVerifier({
      publicKeyPem: await resolvePublicKeyPem(apiConfig.auth),
      issuer: apiConfig.auth.issuer,
      ...(apiConfig.auth.audience ? { audience: apiConfig.auth.audience } : {}),
    });
    return {
      app: createApp({
        jwtVerifier,
        turnCoordinator: persistence.turnCoordinator,
        coachInvoker: coachInvoker,
        checkpointer: persistence.checkpointer,
      }),
      close: () => Promise.all([dataProvider.close(), persistence?.close()]).then(() => undefined),
    };
  } catch (error) {
    await Promise.allSettled([dataProvider.close(), ...(persistence ? [persistence.close()] : [])]);
    throw error;
  }
}
