import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadApiConfig } from "../src/config.js";

const BASE_YAML = [
  "api:",
  "  host: base-host",
  "  port: 8081",
  "auth:",
  "  public_key_pem: base-public-key",
  '  public_key_path: ""',
  "  issuer: base-issuer",
  "  audience: base-audience",
  "stride_database:",
  "  host: stride-base",
  "  port: 3306",
  "  user: stride-reader",
  "  password: stride-password",
  "  database: stride",
  "persistence_database:",
  "  host: persistence-base",
  "  port: 3307",
  "  user: coach-writer",
  "  password: coach-password",
  "  database: coach_agent",
  "",
].join("\n");

/** Absolute config file paths for `loadApiConfig` in the temp repo (`<root>/config/`). */
function apiConfigFiles(root: string, env: string): string[] {
  const configDir = join(root, "config");
  const files = [join(configDir, "coach-api.yaml")];
  const overlay = join(configDir, `coach-api.${env}.yaml`);
  if (existsSync(overlay)) {
    files.push(overlay);
  }
  return files;
}

test("loads base YAML when the selected environment has no overlay", () => {
  withConfigRepo({ "coach-api.yaml": BASE_YAML }, (root) => {
    const config = loadApiConfig({
      configFiles: apiConfigFiles(root, "dev"),
      env: { STRIDE_COACH_ENV: "dev" },
    });
    assert.equal(config.host, "base-host");
    assert.equal(config.port, 8081);
    assert.equal(config.auth.publicKeyPem, "base-public-key");
    assert.deepEqual(config.strideDatabase, {
      host: "stride-base",
      port: 3306,
      user: "stride-reader",
      password: "stride-password",
      database: "stride",
    });
  });
});

test("environment YAML overrides base and environment variables override both", () => {
  withConfigRepo(
    {
      "coach-api.yaml": BASE_YAML,
      "coach-api.staging.yaml": [
        "api:",
        "  host: staging-host",
        "  port: 8082",
        "auth:",
        "  issuer: staging-issuer",
        "persistence_database:",
        "  user: staging-writer",
        "",
      ].join("\n"),
    },
    (root) => {
      const config = loadApiConfig({
        configFiles: apiConfigFiles(root, "staging"),
        env: {
          STRIDE_COACH_ENV: "staging",
          STRIDE_COACH_API_HOST: "env-host",
          STRIDE_COACH_API_PORT: "9090",
          COACH_AGENT_MYSQL_USER: "env-writer",
        },
      });
      assert.equal(config.host, "env-host");
      assert.equal(config.port, 9090);
      assert.equal(config.auth.issuer, "staging-issuer");
      assert.equal(config.persistenceDatabase.user, "env-writer");
    },
  );
});

test("an environment PEM replaces a YAML key path", () => {
  withConfigRepo(
    {
      "coach-api.yaml": BASE_YAML.replace(
        "  public_key_pem: base-public-key\n" + '  public_key_path: ""',
        '  public_key_pem: ""\n' + "  public_key_path: public.pem",
      ),
      "public.pem": "path-public-key",
    },
    (root) => {
      assert.equal(
        loadApiConfig({
          configFiles: apiConfigFiles(root, "dev"),
          env: { STRIDE_COACH_ENV: "dev" },
        }).auth.publicKeyPem,
        "path-public-key",
      );
      assert.equal(
        loadApiConfig({
          configFiles: apiConfigFiles(root, "dev"),
          env: {
            STRIDE_COACH_ENV: "dev",
            STRIDE_AUTH_PUBLIC_KEY_PEM: "env-public-key",
          },
        }).auth.publicKeyPem,
        "env-public-key",
      );
    },
  );
});

test("rejects unknown YAML keys in strict mode", () => {
  withConfigRepo({ "coach-api.yaml": `${BASE_YAML}unknown_setting: true\n` }, (root) => {
    assert.throws(
      () => loadApiConfig({ configFiles: apiConfigFiles(root, "dev"), env: { STRIDE_COACH_ENV: "dev" } }),
      /configuration param 'unknown_setting' not declared/,
    );
  });
});

test("rejects invalid ports and ambiguous JWT key environment variables", () => {
  withConfigRepo({ "coach-api.yaml": BASE_YAML }, (root) => {
    assert.throws(
      () =>
        loadApiConfig({
          configFiles: apiConfigFiles(root, "dev"),
          env: {
            STRIDE_COACH_ENV: "dev",
            STRIDE_COACH_API_PORT: "70000",
          },
        }),
      /must be an integer between 1 and 65535/,
    );
    assert.throws(
      () =>
        loadApiConfig({
          configFiles: apiConfigFiles(root, "dev"),
          env: {
            STRIDE_COACH_ENV: "dev",
            STRIDE_AUTH_PUBLIC_KEY_PEM: "pem",
            STRIDE_AUTH_PUBLIC_KEY_PATH: "config/public.pem",
          },
        }),
      /Set only one of STRIDE_AUTH_PUBLIC_KEY_PEM or STRIDE_AUTH_PUBLIC_KEY_PATH/,
    );
  });
});

test("fails closed when required database or JWT settings are absent", () => {
  withConfigRepo(
    {
      "coach-api.yaml": BASE_YAML.replace("  password: stride-password", '  password: ""'),
    },
    (root) => {
      assert.throws(
        () => loadApiConfig({ configFiles: apiConfigFiles(root, "dev"), env: { STRIDE_COACH_ENV: "dev" } }),
        /stride_database.password: must be a non-empty string/,
      );
    },
  );
  withConfigRepo(
    {
      "coach-api.yaml": BASE_YAML.replace("  public_key_pem: base-public-key", '  public_key_pem: ""'),
    },
    (root) => {
      assert.throws(
        () => loadApiConfig({ configFiles: apiConfigFiles(root, "dev"), env: { STRIDE_COACH_ENV: "dev" } }),
        /auth.public_key_pem or auth.public_key_path must be configured/,
      );
    },
  );
});

function withConfigRepo(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "coach-api-config-"));
  try {
    mkdirSync(join(root, "config"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, "config", name), content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
