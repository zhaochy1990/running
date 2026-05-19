# Server Runtime Configuration Design

## Goal

Refactor STRIDE backend runtime configuration so service modules no longer read scattered environment variables directly. Runtime configuration should be represented by typed module-specific classes, loaded through one server-side configuration center, and support multiple environments.

This design covers backend runtime configuration only: `src/stride_server` and server-side adapters. It does not cover frontend `VITE_*` configuration, Flutter/mobile configuration, or per-user watch credential files such as `data/{user}/config.json`.

## Current State

The codebase already has one strong configuration pattern in `coach.runtime.config`: TOML is loaded from `config/coach.toml` and converted into typed dataclasses such as `CoachConfig` and `ModelSpec`.

Most backend runtime configuration is still read directly from environment variables in service modules. Examples include:

- Auth: `STRIDE_ENV`, `STRIDE_AUTH_PUBLIC_KEY_PEM`, `STRIDE_AUTH_PUBLIC_KEY_PATH`, `STRIDE_AUTH_ISSUER`, `STRIDE_AUTH_AUDIENCE`.
- Auth-service client: `STRIDE_AUTH_URL`.
- LLM/commentary: `LLM_ENABLED`, `LLM_DEFAULT_MODEL`, `AOAI_COMMENTARY_ENABLED`, `AZURE_OPENAI_*`.
- Content and social storage: `STRIDE_CONTENT_BLOB_*`, `STRIDE_LIKES_TABLE_*`, `STRIDE_MASTER_PLAN_TABLE_*`.
- Coach persistence: `STRIDE_COACH_TABLE_ACCOUNT_URL`, `STRIDE_COACH_BLOB_ACCOUNT_URL`, table/container names, file backend dir.
- Notifications and JPush: `STRIDE_NOTIFICATIONS_*`, `JPUSH_APP_KEY`, `JPUSH_MASTER_SECRET`.
- Internal routes and sync: `STRIDE_INTERNAL_TOKEN`, `STRIDE_SYNC_STALE_AFTER_SECONDS`, provider Key Vault settings.

The refactor should preserve runtime behavior while moving these settings behind typed config objects.

## Chosen Approach

Add a new backend-only package:

```text
src/stride_server/config/
  __init__.py
  models.py
  loader.py
  sources.py
```

`models.py` defines a top-level `ServerConfig` dataclass and module-specific child dataclasses:

```python
@dataclass(frozen=True)
class ServerConfig:
    env: str
    akv: AzureKeyVaultConfig
    auth: AuthConfig
    auth_service: AuthServiceConfig
    llm: LLMConfig
    commentary: CommentaryConfig
    storage: StorageConfig
    coach_persistence: CoachPersistenceConfig
    notifications: NotificationConfig
    sync: SyncConfig
    internal: InternalConfig
```

The config center stays in `stride_server`, not `coach`, to preserve the existing import-linter boundary: `coach.*` must not import server, Azure, FastAPI, or database modules.

## Configuration Sources

The final config is built by merging these source groups in order:

```text
file layer
< Azure Key Vault
< environment variables
```

Later sources override earlier sources.

The file layer is either the default discovered files or the explicit file list:

```text
default:  config/server.toml < config/server.{env}.toml
explicit: STRIDE_CONFIG_FILES, in listed order
```

The active environment name is resolved from:

```text
STRIDE_CONFIG_ENV
STRIDE_ENV
default
```

Examples:

```text
STRIDE_CONFIG_ENV=local -> config/server.toml + config/server.local.toml
STRIDE_CONFIG_ENV=prod  -> config/server.toml + config/server.prod.toml
```

`STRIDE_CONFIG_FILES` is a semicolon-separated file list on Windows and may also accept comma-separated values for portability. When present, it replaces default file discovery and becomes the complete file layer. Azure Key Vault and environment variables are still applied after it.

File missing rules:

- `config/server.toml` is required when the default file discovery path is used.
- `config/server.{env}.toml` is optional.
- Every file named in `STRIDE_CONFIG_FILES` is required.

## Merge Rules

Each source returns a nested dictionary using the same logical key paths as the dataclasses.

Merge behavior:

- Dictionaries are merged recursively.
- Scalar values replace previous values.
- Lists replace previous lists as a whole.
- Empty strings from environment variables are explicit values and are not skipped.
- After merging, the resulting dictionary is converted to dataclasses and validated.

Validation should cover at least:

- URL fields are either empty or valid `http://` / `https://` URLs.
- Timeout and stale-threshold values are positive numbers.
- Integer and boolean fields are parsed deterministically.
- Non-dev runtime must have auth verification configured unless explicitly disabled by config.
- Required Azure backend fields are present when that backend is selected.

## Azure Key Vault

Azure Key Vault support is itself configured through the file/env merge enough to discover the vault:

```toml
[akv]
enabled = true
vault_url = "https://stride-kv-common.vault.azure.net/"
secret_prefix = "stride-server"
```

AKV bootstrap settings may come from the file layer or environment variables. Environment variables used for AKV bootstrap are read before fetching secrets; the final environment-variable source is still applied after AKV so env remains the highest-priority override.

Secret names map from config paths to stable Azure secret names:

```text
storage.likes.table_account_url -> stride-server--storage--likes--table-account-url
notifications.jpush.master_secret -> stride-server--notifications--jpush--master-secret
internal.token -> stride-server--internal--token
```

The implementation may fetch a known manifest of key paths derived from `ServerConfig`, rather than listing all Key Vault secrets. That avoids requiring broad list permissions when get-only permissions are enough.

All config values may be provided by file, AKV, or env. The implementation should not hard-code which values are sensitive. The user will review the resulting config surface later and decide which settings should move out of checked-in files.

## Environment Variable Mapping

Existing environment variables remain supported as overrides to preserve current deployment behavior. New canonical env names may be added, but old names should continue to work during migration.

Examples:

```text
STRIDE_AUTH_PUBLIC_KEY_PEM          -> auth.public_key_pem
STRIDE_AUTH_PUBLIC_KEY_PATH         -> auth.public_key_path
STRIDE_AUTH_ISSUER                  -> auth.issuer
STRIDE_AUTH_AUDIENCE                -> auth.audience
STRIDE_AUTH_URL                     -> auth_service.base_url
AZURE_OPENAI_ENDPOINT               -> llm.azure_openai.endpoint and commentary.azure_openai.endpoint
AZURE_OPENAI_API_KEY                -> llm.azure_openai.api_key and commentary.azure_openai.api_key
LLM_ENABLED                         -> llm.enabled
AOAI_COMMENTARY_ENABLED             -> commentary.enabled
STRIDE_INTERNAL_TOKEN               -> internal.token
STRIDE_COACH_TABLE_ACCOUNT_URL      -> coach_persistence.table_account_url
STRIDE_COACH_BLOB_ACCOUNT_URL       -> coach_persistence.blob_account_url
JPUSH_APP_KEY                       -> notifications.jpush.app_key
JPUSH_MASTER_SECRET                 -> notifications.jpush.master_secret
```

Where one legacy variable currently drives multiple modules, the loader can map it to both logical paths unless a more specific canonical variable is present.

## Runtime Wiring

The FastAPI composition root loads the config once:

```python
server_config = load_server_config()
app = create_app(_build_registry(), config=server_config)
```

`create_app` stores it on `app.state.config`.

Routes and request-scoped dependencies should read config through FastAPI dependency helpers. Module-level singleton factories should gain config-aware forms:

```python
get_master_plan_store(config: StorageConfig | None = None)
jobs_store_from_config(config: CoachPersistenceConfig)
weekly_version_store_from_config(config: CoachPersistenceConfig)
AzureTableCheckpointSaver.from_config(config: CoachPersistenceConfig)
```

Compatibility wrappers such as `*_from_env()` may remain initially, but they should delegate to `load_server_config()` and then to the config-aware factory.

## Module Migration Scope

The first implementation pass should migrate these direct environment reads:

- `stride_server.bearer`
- `stride_server.auth_service_client`
- `stride_server.llm_client`
- `stride_server.aoai_client`
- `stride_server.content_store`
- `stride_server.likes_store`
- `stride_server.master_plan_store`
- `stride_server.notifications.store`
- `stride_server.notifications.jpush_client`
- `stride_server.coach_adapters.persistence.*` factory methods
- `stride_server.routes.plan` internal token validation
- `stride_server.routes.onboarding` sync stale timeout

Provider credential modules such as `coros_sync.auth` and `garmin_sync.auth` are not backend runtime config in the first pass except where the server calls them through runtime configuration. Their per-user credential JSON files remain out of scope.

## Config Files

Add these files:

```text
config/server.toml
config/server.local.toml
config/server.prod.toml
```

`server.toml` contains common defaults and documentation comments. `server.local.toml` contains local development overrides such as dev auth behavior and file-backed stores. `server.prod.toml` contains production backend selections, resource names, and feature defaults. The initial files may contain all values, including values that might later be moved to AKV or env after review.

## Error Handling

Configuration load errors should be explicit and fail early during app startup. Errors should name the logical config path, not only the source variable.

Examples:

- `auth.public_key_path points to a missing file: ...`
- `storage.likes.table_account_url must be an http(s) URL`
- `coach_persistence.blob_account_url is required when coach_persistence.backend = "azure"`

Runtime paths that currently degrade gracefully, such as optional auth-service team lookups or disabled LLM features, should keep that behavior when the typed config says the feature is not configured or disabled.

## Testing Strategy

Add focused loader tests for:

- base file only
- base + environment file
- `STRIDE_CONFIG_FILES` replacing default file discovery
- AKV overriding files
- env overriding AKV
- deep merge semantics
- empty string env override
- type parsing for booleans, integers, floats, and URLs
- missing file behavior
- validation errors with logical key paths

Update migrated module tests to pass typed config objects or set config test files instead of monkeypatching scattered env vars. Keep limited env override tests to verify backward-compatible env names still map correctly.

Verification should include relevant backend tests and import boundary checks:

```bash
PYTHONPATH=src pytest tests/coach tests/stride_server tests/test_likes_routes.py tests/test_plan_routes.py
PYTHONPATH=src lint-imports
```

The exact test subset can be adjusted during implementation based on touched files.
