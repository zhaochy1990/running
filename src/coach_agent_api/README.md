# Coach Agent API

HTTP composition root for `coach_agent`. This package owns transport, JWT authentication, MySQL adapters, database writes, and process lifecycle. The core package owns Agent behavior and the read-only `DataProvider` interface.

## Endpoints

- `GET /health` — public liveness probe.
- `GET /openapi.json` — public OpenAPI 3.1 document.
- `GET /docs` — public Swagger UI with bearer-token support.
- `POST /api/users/me/coach/chat` — authenticated Coach turn. The server derives `userId` from the verified RS256 JWT `sub`; request bodies cannot choose a user.

Request body:

```json
{
  "session_id": "session-1",
  "client_turn_id": "turn-1",
  "message": "最近状态怎么样？"
}
```

Supply `resume` instead of `message` to continue a human-in-the-loop interrupt; it may be a string or an array of selected option labels.

`client_turn_id` is an idempotency key within the derived user/session thread. Identical retries replay the stored public response, reuse with different input returns `409`, and turns on one thread execute serially. The API retains the latest 50 receipts per thread.

## Configuration

The API uses Convict with this precedence:

`schema defaults < config/coach-api.yaml < config/coach-api.<environment>.yaml < environment variables`

`STRIDE_COACH_ENV`, then `NODE_ENV`, selects the environment; it defaults to `local`. Unknown YAML keys and invalid or missing required values fail at startup. The checked-in local overlay targets `src/go/docker-compose.yml`; production secrets remain environment-only.

Schema-mapped variables:

- HTTP: `STRIDE_COACH_API_HOST`, `STRIDE_COACH_API_PORT`
- JWT: exactly one of `STRIDE_AUTH_PUBLIC_KEY_PEM` or `STRIDE_AUTH_PUBLIC_KEY_PATH`, plus `STRIDE_AUTH_ISSUER` and optional `STRIDE_AUTH_AUDIENCE`
- Read-only STRIDE MySQL: `STRIDE_COACH_DATA_HOST`, `STRIDE_COACH_DATA_PORT`, `STRIDE_COACH_DATA_READONLY_USER`, `STRIDE_COACH_DATA_READONLY_PASSWORD`, `STRIDE_COACH_DATA_DATABASE`
- Coach checkpoint/store MySQL: `COACH_AGENT_MYSQL_HOST`, `COACH_AGENT_MYSQL_PORT`, `COACH_AGENT_MYSQL_USER`, `COACH_AGENT_MYSQL_PASSWORD`, `COACH_AGENT_MYSQL_DATABASE`

The API config is separate from `coach_agent`'s model/agent YAML because that dynamic registry has a different schema and is also reused by future composition roots such as a CLI.

Use Node 24. From the repository root, run `pnpm install`, then use
`pnpm --filter coach_agent_api test` and `pnpm --filter coach_agent_api start`.
`pnpm --filter coach_agent_api smoke` starts an ephemeral in-process HTTP
server with fake dependencies and verifies `/health`, `/openapi.json`, and
`/docs` without contacting MySQL or an LLM.
