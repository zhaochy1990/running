import { type CoachAgentConfig, createCoachAgent } from "coach_agent";
import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { MySqlDataProvider } from "./data/mysqlDataProvider.js";
import { createPersistence, type Persistence } from "./persistence/index.js";

export interface CoachApiRuntime {
	app: ReturnType<typeof createApp>;
	close(): Promise<void>;
}

/** Compose API-owned adapters and release partial resources if startup fails. */
export async function createCoachApiRuntime(
	apiConfig: ApiConfig,
	coachConfig: CoachAgentConfig,
): Promise<CoachApiRuntime> {
	const dataProvider = MySqlDataProvider.create(apiConfig.strideDatabase);
	let persistence: Persistence | undefined;
	try {
		persistence = await createPersistence(apiConfig.persistenceDatabase);
		const activePersistence = persistence;
		const coach = await createCoachAgent(dataProvider, coachConfig, {
			checkpointer: activePersistence.checkpointer,
			store: activePersistence.store,
		});
		const jwtVerifier = await createJwtVerifier(apiConfig.auth);
		return {
			app: createApp({
				jwtVerifier,
				turnCoordinator: activePersistence.turnCoordinator,
				coach: {
					invoke: (input, invocationConfig) =>
						coach.invoke(input as never, invocationConfig as never),
				},
			}),
			close: () =>
				Promise.all([dataProvider.close(), activePersistence.close()]).then(
					() => undefined,
				),
		};
	} catch (error) {
		await Promise.allSettled([
			dataProvider.close(),
			...(persistence ? [persistence.close()] : []),
		]);
		throw error;
	}
}
