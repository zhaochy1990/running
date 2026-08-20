import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadApiConfig } from "./config.js";

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

test("loads base YAML when the selected environment has no overlay", () => {
  withConfigRepo({ "coach-api.yaml": BASE_YAML }, (cwd) => {
    const config = loadApiConfig({
      cwd,
      env: { STRIDE_COACH_ENV: "test" },
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
    (cwd) => {
      const config = loadApiConfig({
        cwd,
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
        '  public_key_pem: ""\n' + "  public_key_path: config/public.pem",
      ),
      "public.pem": "path-public-key",
    },
    (cwd) => {
      assert.equal(
        loadApiConfig({
          cwd,
          env: { STRIDE_COACH_ENV: "test" },
        }).auth.publicKeyPem,
        "path-public-key",
      );
      assert.equal(
        loadApiConfig({
          cwd,
          env: {
            STRIDE_COACH_ENV: "test",
            STRIDE_AUTH_PUBLIC_KEY_PEM: "env-public-key",
          },
        }).auth.publicKeyPem,
        "env-public-key",
      );
    },
  );
});

test("rejects unknown YAML keys in strict mode", () => {
  withConfigRepo({ "coach-api.yaml": `${BASE_YAML}unknown_setting: true\n` }, (cwd) => {
    assert.throws(() => loadApiConfig({ cwd, env: { STRIDE_COACH_ENV: "test" } }), /configuration param 'unknown_setting' not declared/);
  });
});

test("rejects invalid ports and ambiguous JWT key environment variables", () => {
  withConfigRepo({ "coach-api.yaml": BASE_YAML }, (cwd) => {
    assert.throws(
      () =>
        loadApiConfig({
          cwd,
          env: {
            STRIDE_COACH_ENV: "test",
            STRIDE_COACH_API_PORT: "70000",
          },
        }),
      /must be an integer between 1 and 65535/,
    );
    assert.throws(
      () =>
        loadApiConfig({
          cwd,
          env: {
            STRIDE_COACH_ENV: "test",
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
    (cwd) => {
      assert.throws(() => loadApiConfig({ cwd, env: { STRIDE_COACH_ENV: "test" } }), /stride_database.password: must be a non-empty string/);
    },
  );
  withConfigRepo(
    {
      "coach-api.yaml": BASE_YAML.replace("  public_key_pem: base-public-key", '  public_key_pem: ""'),
    },
    (cwd) => {
      assert.throws(() => loadApiConfig({ cwd, env: { STRIDE_COACH_ENV: "test" } }), /auth.public_key_pem or auth.public_key_path must be configured/);
    },
  );
});

function withConfigRepo(files: Record<string, string>, run: (cwd: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "coach-api-config-"));
  try {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, ".root"), "");
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, "config", name), content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
