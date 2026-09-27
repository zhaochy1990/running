# @stride/common

Shared runtime utilities for STRIDE's TypeScript packages. Consumers are
`coach_agent`, `coach_agent_api` and `coach_agent_worker` — all three depend on
this package, so anything added here is on every coach path.

## What's here

| Module | Owns |
| --- | --- |
| `src/config.ts` | Convict wrapper. Callers pass absolute config file paths; the loader does no repo-root discovery. |
| `src/logger.ts` | The pino root logger and `getLogger(name)` children. |
| `src/llm/models.ts` | Building a LangChain model from a `ModelConfig`. |

## The LLM layer

`src/llm/models.ts` is the **single** place that turns a config into a model.
Do not build `ChatOpenAI` / `ChatOpenAIResponses` anywhere else — duplicated
client construction is how endpoint, auth and thinking-switch drift creeps in.

`buildModel` has two shapes:

```ts
// A plain chat model, for the conversational agents.
buildModel(config): ChatOpenAI | ChatOpenAIResponses

// A schema-bound runnable: one call, one validated-or-rejected submission.
buildModel({ ...config, structured: { schema, name, validate? } }): StructuredRunnable
```

The `structured` request carries everything that call needs:

- `schema` — the zod schema the answer must satisfy (`jsonSchema` + `strict`).
- `name` — the submission function name, also used in logs and error messages.
- `validate` — domain rules a schema cannot express ("the verdict must agree
  with the authoritative facts", "the plan must pass the deterministic rule
  filter"). A rejection surfaces as a `ModelContractError`.

That error type is load-bearing, not decoration. `graph/master_plan/nodes.ts`
classifies failures with `isContractError` / `isInfrastructureError` to decide
whether a failed generation is a quality problem (never retried) or
infrastructure (worth retrying). A provider failure wrapped as a contract error
makes the worker retry work that can never succeed, so `buildModel` wraps only
decode and `validate` failures and lets everything else propagate untouched.

## Testing

```bash
npm test        # unit tests, no network
npm run test:e2e  # build + typecheck + REAL provider calls
```

**If you change `src/llm/models.ts`, you must run `npm run test:e2e`.**

The unit tests inject fakes, so they cannot see what the provider actually does
with a config — the response content shape, the error shape, whether `strict`
really constrains the model. `e2e/models.test.ts` is the only place that
observes that. It has already caught two defects that unit tests passed
straight through: the Responses API returning content blocks instead of a
string, and a transport failure that the SDK's own retry turned into a
hundred-second call.

The e2e suite covers every configuration the business runs:

| Scenario | Business role |
| --- | --- |
| `chat-completions`, thinking off | `qa` / `other` |
| `chat-completions`, thinking on | production `qa` |
| `responses`, no structured request | planning roles' default |
| `responses` + structured | the master-plan graph's six models |
| `validate` accepts / rewrites / rejects | domain rules |
| auth failure, provider rejection | worker retry classification |

### Which model the e2e runs

The endpoint, key env var and model id are written out in `e2e/models.test.ts`
rather than read from `config/coach.yaml`. Parsing the shipped file would make
this suite break — or worse, silently start testing something else — whenever a
role or a model id changes there, and the suite is about the LLM layer's
behavior, not about that file.

The cost is manual: **when the business switches models, update
`e2e/models.test.ts` too.** The values to keep in step are `ENDPOINT`,
`API_KEY_ENV` and `MODEL`. Model names live in `config/coach.yaml`'s `models:`
registry; `agents:` binds each role to one.

Two role values the e2e deliberately does *not* copy: `max_tokens` and
`timeout_s`. The shipped role timeouts reach 600s, which would turn a hung call
into a ten-minute test.

Requirements: Node 24 and the `DEEPSEEK_API_KEY` environment variable.
**Without the key every case is skipped, not failed** — a stray run cannot break CI. `npm test` never touches the network;
the e2e file lives outside `src/`, so the library build skips it.

`e2e/` is outside `src/`, which means the library `tsconfig.json` cannot
type-check it and Node's type stripping does not check types at all. That is
what `tsconfig.e2e.json` (and the `typecheck:e2e` step inside `test:e2e`) is
for.
