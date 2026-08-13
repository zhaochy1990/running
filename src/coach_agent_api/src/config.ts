import { readFileSync } from "node:fs";
import type { MySqlConfig } from "./persistence/mysql.js";

export interface ApiConfig {
	host: string;
	port: number;
	strideDatabase: MySqlConfig;
	auth: { publicKeyPem: string; issuer: string; audience?: string };
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	const publicKeyPem =
		env.STRIDE_AUTH_PUBLIC_KEY_PEM ??
		(env.STRIDE_AUTH_PUBLIC_KEY_PATH
			? readFileSync(env.STRIDE_AUTH_PUBLIC_KEY_PATH, "utf8")
			: undefined);
	if (!publicKeyPem)
		throw new Error(
			"STRIDE_AUTH_PUBLIC_KEY_PEM or STRIDE_AUTH_PUBLIC_KEY_PATH is required",
		);
	const strideDatabase = loadStrideDataConfig(env);
	return {
		host: env.STRIDE_COACH_API_HOST ?? "0.0.0.0",
		port: numberEnv(env, "STRIDE_COACH_API_PORT", 8080),
		strideDatabase,
		auth: {
			publicKeyPem,
			issuer: env.STRIDE_AUTH_ISSUER ?? "auth-service",
			...(env.STRIDE_AUTH_AUDIENCE
				? { audience: env.STRIDE_AUTH_AUDIENCE }
				: {}),
		},
	};
}

export function loadStrideDataConfig(
	env: NodeJS.ProcessEnv = process.env,
): MySqlConfig {
	return {
		host: required(env, "STRIDE_COACH_DATA_HOST"),
		port: numberEnv(env, "STRIDE_COACH_DATA_PORT", 3306),
		user: required(env, "STRIDE_COACH_DATA_READONLY_USER"),
		password: required(env, "STRIDE_COACH_DATA_READONLY_PASSWORD"),
		database: required(env, "STRIDE_COACH_DATA_DATABASE"),
	};
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function numberEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
): number {
	const value = Number(env[name] ?? fallback);
	if (!Number.isInteger(value) || value < 1 || value > 65535)
		throw new Error(`${name} must be a valid port`);
	return value;
}
