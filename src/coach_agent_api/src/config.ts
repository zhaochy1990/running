import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import convict from "convict";
import { parse } from "yaml";
import type { MySqlConfig } from "./persistence/mysql.js";

const DEFAULT_ENVIRONMENT = "local";
const BASE_CONFIG_FILE = "coach-api.yaml";
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

convict.addParser({
	extension: ["yaml", "yml"],
	parse,
});

convict.addFormat({
	name: "active-port",
	coerce: (value) => Number(value),
	validate: (value) => {
		if (!Number.isInteger(value) || value < 1 || value > 65535) {
			throw new Error("must be an integer between 1 and 65535");
		}
	},
});

interface RawApiConfig {
	api: {
		host: string;
		port: number;
	};
	auth: {
		public_key_pem: string;
		public_key_path: string;
		issuer: string;
		audience: string;
	};
	stride_database: MySqlConfig;
	persistence_database: MySqlConfig;
}

export interface ApiConfig {
	host: string;
	port: number;
	strideDatabase: MySqlConfig;
	persistenceDatabase: MySqlConfig;
	auth: { publicKeyPem: string; issuer: string; audience?: string };
}

export interface LoadApiConfigOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

const requiredString = (value: unknown): void => {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("must be a non-empty string");
	}
};

const databaseName = (value: unknown): void => {
	requiredString(value);
	if (!/^[A-Za-z0-9_]+$/.test(value as string)) {
		throw new Error("must be a plain MySQL identifier");
	}
};

const schema: convict.Schema<RawApiConfig> = {
	api: {
		host: {
			doc: "HTTP bind address",
			format: requiredString,
			default: "0.0.0.0",
			env: "STRIDE_COACH_API_HOST",
		},
		port: {
			doc: "HTTP listen port",
			format: "active-port",
			default: 8080,
			env: "STRIDE_COACH_API_PORT",
		},
	},
	auth: {
		public_key_pem: {
			doc: "Inline RS256 public key PEM",
			format: String,
			default: "",
			env: "STRIDE_AUTH_PUBLIC_KEY_PEM",
			sensitive: true,
		},
		public_key_path: {
			doc: "RS256 public key path, relative to the repository root",
			format: String,
			default: "",
			env: "STRIDE_AUTH_PUBLIC_KEY_PATH",
		},
		issuer: {
			doc: "Expected JWT issuer",
			format: requiredString,
			default: "auth-service",
			env: "STRIDE_AUTH_ISSUER",
		},
		audience: {
			doc: "Optional expected JWT audience",
			format: String,
			default: "",
			env: "STRIDE_AUTH_AUDIENCE",
		},
	},
	stride_database: databaseSchema({
		host: "STRIDE_COACH_DATA_HOST",
		port: "STRIDE_COACH_DATA_PORT",
		user: "STRIDE_COACH_DATA_READONLY_USER",
		password: "STRIDE_COACH_DATA_READONLY_PASSWORD",
		database: "STRIDE_COACH_DATA_DATABASE",
	}),
	persistence_database: databaseSchema({
		host: "COACH_AGENT_MYSQL_HOST",
		port: "COACH_AGENT_MYSQL_PORT",
		user: "COACH_AGENT_MYSQL_USER",
		password: "COACH_AGENT_MYSQL_PASSWORD",
		database: "COACH_AGENT_MYSQL_DATABASE",
	}),
};

export function loadApiConfig(options: LoadApiConfigOptions = {}): ApiConfig {
	const repoRoot = findRepoRoot(options.cwd ?? process.cwd());
	const env = normalizeAuthEnvironment(options.env ?? process.env);
	const environment =
		env.STRIDE_COACH_ENV ?? env.NODE_ENV ?? DEFAULT_ENVIRONMENT;
	if (!ENVIRONMENT_PATTERN.test(environment)) {
		throw new Error(`Invalid Coach API environment name: ${environment}`);
	}

	const configDir = join(repoRoot, "config");
	const baseConfigPath = join(configDir, BASE_CONFIG_FILE);
	if (!existsSync(baseConfigPath)) {
		throw new Error(`Coach API base config not found: ${baseConfigPath}`);
	}
	const environmentConfigPath = join(
		configDir,
		`coach-api.${environment}.yaml`,
	);
	const configFiles = [baseConfigPath];
	if (existsSync(environmentConfigPath)) {
		configFiles.push(environmentConfigPath);
	}

	const config = convict<RawApiConfig>(schema, { env, args: [] });
	config.loadFile(configFiles);
	config.validate({ allowed: "strict" });
	const raw = config.getProperties();
	const publicKeyPem = resolvePublicKey(raw.auth, repoRoot);

	return {
		host: raw.api.host,
		port: raw.api.port,
		strideDatabase: raw.stride_database,
		persistenceDatabase: raw.persistence_database,
		auth: {
			publicKeyPem,
			issuer: raw.auth.issuer,
			...(raw.auth.audience ? { audience: raw.auth.audience } : {}),
		},
	};
}

function databaseSchema(env: {
	host: string;
	port: string;
	user: string;
	password: string;
	database: string;
}): convict.Schema<MySqlConfig> {
	return {
		host: { format: requiredString, default: "", env: env.host },
		port: { format: "active-port", default: 3306, env: env.port },
		user: { format: requiredString, default: "", env: env.user },
		password: {
			format: requiredString,
			default: "",
			env: env.password,
			sensitive: true,
		},
		database: { format: databaseName, default: "", env: env.database },
	};
}

/** An environment-supplied key source replaces the key source from YAML. */
function normalizeAuthEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const normalized = { ...env };
	const hasPem = Boolean(env.STRIDE_AUTH_PUBLIC_KEY_PEM);
	const hasPath = Boolean(env.STRIDE_AUTH_PUBLIC_KEY_PATH);
	if (hasPem && hasPath) {
		throw new Error(
			"Set only one of STRIDE_AUTH_PUBLIC_KEY_PEM or STRIDE_AUTH_PUBLIC_KEY_PATH",
		);
	}
	if (hasPem) normalized.STRIDE_AUTH_PUBLIC_KEY_PATH = "";
	if (hasPath) normalized.STRIDE_AUTH_PUBLIC_KEY_PEM = "";
	return normalized;
}

function resolvePublicKey(
	auth: RawApiConfig["auth"],
	repoRoot: string,
): string {
	if (auth.public_key_pem && auth.public_key_path) {
		throw new Error(
			"Configure only one of auth.public_key_pem or auth.public_key_path",
		);
	}
	if (auth.public_key_pem) return auth.public_key_pem;
	if (!auth.public_key_path) {
		throw new Error(
			"auth.public_key_pem or auth.public_key_path must be configured",
		);
	}
	const keyPath = isAbsolute(auth.public_key_path)
		? auth.public_key_path
		: resolve(repoRoot, auth.public_key_path);
	return readFileSync(keyPath, "utf8");
}

function findRepoRoot(startDir: string): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [resolve(startDir), moduleDir]) {
		let currentDir = candidate;
		while (true) {
			if (
				existsSync(join(currentDir, ".root")) &&
				existsSync(join(currentDir, "config"))
			) {
				return currentDir;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}
	throw new Error(`Unable to find repository root from ${resolve(startDir)}`);
}
