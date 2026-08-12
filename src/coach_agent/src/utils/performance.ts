import { getLogger, type Logger } from "./logger.js";

const perfLogger = getLogger("performance");

export function measureExecutionTime<T>(
	fn: () => T,
	logger: Logger = perfLogger,
): { result: T; time: number } {
	const start = performance.now();
	const result = fn();
	const end = performance.now();

	logger.debug(`Execution ${fn.name} took time: ${end - start} ms`);

	return { result, time: end - start };
}

export async function measureExecutionTimeAsync<T>(
	fn: () => Promise<T>,
	logger: Logger = perfLogger,
): Promise<{ result: T; time: number }> {
	const start = performance.now();
	const result = await fn();
	const end = performance.now();

	logger.debug(`Execution ${fn.name} took time: ${end - start} ms`);

	return { result, time: end - start };
}
