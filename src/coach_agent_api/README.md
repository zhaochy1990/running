# Coach Agent API

HTTP composition root for `coach_agent`. This package owns transport, JWT authentication, MySQL adapters, database writes, and process lifecycle. The core package owns Agent behavior and the read-only `DataProvider` interface.

## Endpoints

- `GET /health` — public liveness probe.
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

## Configuration

Required: `STRIDE_AUTH_PUBLIC_KEY_PEM` or `STRIDE_AUTH_PUBLIC_KEY_PATH`, plus `STRIDE_COACH_DATA_HOST`, `STRIDE_COACH_DATA_READONLY_USER`, `STRIDE_COACH_DATA_READONLY_PASSWORD`, and `STRIDE_COACH_DATA_DATABASE`. Optional ports and auth issuer/audience use the names documented in `src/config.ts`. Coach checkpoint/store MySQL continues to use `COACH_AGENT_MYSQL_*`.

Use Node 24, then run `npm ci`, `npm test`, and `npm start`. `npm run smoke` starts an ephemeral in-process HTTP server with fake dependencies and verifies `/health` without contacting MySQL or an LLM.
