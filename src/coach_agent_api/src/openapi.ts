export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Coach Agent API",
    version: "0.1.0",
    description: "Authenticated HTTP composition root for the STRIDE Coach Agent.",
  },
  tags: [
    { name: "System", description: "Service lifecycle endpoints." },
    { name: "Coach", description: "Authenticated Coach conversations." },
    { name: "Shares", description: "Coach chat sharing: authenticated snapshot creation, public read (#715)." },
    { name: "Lottery", description: "Lottery activity configuration: admin CRUD for activities/prize pools, public landing read (#863)." },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        operationId: "getHealth",
        summary: "Check service liveness",
        responses: {
          "200": {
            description: "The service is running.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/api/admin/users/{user_id}/coach-data": {
      delete: {
        tags: ["Coach"],
        operationId: "deleteCoachDataForUser",
        summary: "Delete a user's Coach data",
        description:
          "Administrator or self only: an administrator token may delete any user's Coach data; a regular token may delete only its own. Removes checkpoints, checkpoint writes, turn receipts, long-term memory, and share snapshots. Idempotent.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "user_id",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/TurnIdentifier" },
          },
        ],
        responses: {
          "200": {
            description: "Per-table deletion counts.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CoachDataDeletionResponse" },
              },
            },
          },
          "400": errorResponse("The user_id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A regular caller may delete only their own data."),
        },
      },
    },
    "/api/users/me/coach/chat": {
      post: {
        tags: ["Coach"],
        operationId: "createCoachTurn",
        summary: "Run or resume a Coach turn",
        description:
          "The authenticated JWT subject determines the user. client_turn_id is an idempotency key within the session. Send exactly one of message or resume.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Completed turn or human-input interrupt.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatResponse" },
              },
            },
          },
          "400": errorResponse("The request body is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "409": errorResponse("The client_turn_id was already used with different input."),
          "429": {
            ...errorResponse("The thread is busy; retry after the indicated delay."),
            headers: {
              "Retry-After": {
                description: "Suggested retry delay in seconds.",
                schema: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    },
    "/api/users/me/coach/plan-jobs": {
      post: {
        tags: ["Coach"],
        operationId: "createPlanJob",
        summary: "Enqueue a training-plan job (deterministic)",
        description:
          "Submits a directly-provided kernel request (server-side zod re-validation) as a plan job. Returns the job id and an estimated duration; poll the job id to follow progress. Idempotent by idempotency_key.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PlanJobEnqueueRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "The plan job was enqueued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlanJobEnqueueResponse" },
              },
            },
          },
          "400": errorResponse("The request body or kernel request is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
        },
      },
    },
    "/api/users/me/coach/plan-jobs/{job_id}": {
      get: {
        tags: ["Coach"],
        operationId: "getPlanJob",
        summary: "Poll a training-plan job",
        description: "Returns the job's status, stage, progress, error code and, when done, the resulting draft id.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "job_id",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/TurnIdentifier" },
          },
        ],
        responses: {
          "200": {
            description: "The job's current state.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlanJobPollResponse" },
              },
            },
          },
          "400": errorResponse("The job_id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "404": errorResponse("The plan job was not found."),
        },
      },
    },
    "/api/admin/users/{user_id}/coach/plan-jobs": {
      post: {
        tags: ["Admin"],
        operationId: "adminCreatePlanJob",
        summary: "Enqueue a training-plan job for an athlete (admin)",
        description:
          "Admin dashboard surface: starts a plan job for the user in the path (not the caller). Requires an admin-audience token with role=admin; user and internal callers are refused.",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "user_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PlanJobEnqueueRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "The plan job was enqueued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlanJobEnqueueResponse" },
              },
            },
          },
          "400": errorResponse("The request body or kernel request is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("The caller is not a verified admin."),
        },
      },
    },
    "/api/admin/users/{user_id}/coach/plan-jobs/{job_id}": {
      get: {
        tags: ["Admin"],
        operationId: "adminGetPlanJob",
        summary: "Poll an athlete's training-plan job (admin)",
        description: "Admin dashboard surface: returns one athlete's job state. Requires an admin-audience token with role=admin.",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "user_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "job_id",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/TurnIdentifier" },
          },
        ],
        responses: {
          "200": {
            description: "The job's current state.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlanJobPollResponse" },
              },
            },
          },
          "400": errorResponse("The job_id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("The caller is not a verified admin."),
          "404": errorResponse("The plan job was not found."),
        },
      },
    },
    "/api/users/me/coach/sessions": {
      get: {
        tags: ["Coach"],
        operationId: "listCoachSessions",
        summary: "List the caller's Coach sessions (chat history)",
        description:
          "Returns one entry per Coach conversation, newest first, with a preview derived from the session's first user message. Pairs with the per-session messages endpoint.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The caller's Coach sessions.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SessionListResponse" },
              },
            },
          },
          "401": errorResponse("The bearer token is missing or invalid."),
        },
      },
    },
    "/api/users/me/coach/sessions/{session_id}/messages": {
      get: {
        tags: ["Coach"],
        operationId: "getCoachSessionMessages",
        summary: "Load the conversation history for a Coach session",
        description: "The authenticated JWT subject determines the user; only session_id is passed, the thread is derived server-side.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "session_id",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/TurnIdentifier" },
          },
        ],
        responses: {
          "200": {
            description: "The session history (user and assistant turns only).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SessionHistoryResponse" },
              },
            },
          },
          "400": errorResponse("The session_id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
        },
      },
    },
    "/api/users/me/coach/sessions/{session_id}/share": {
      post: {
        tags: ["Shares"],
        operationId: "createShare",
        summary: "Create a share snapshot of selected session messages",
        description:
          "The server re-projects the thread from its checkpoint and extracts the selected messages itself (projection indices only — coach content cannot be forged). Re-sharing the exact same selection returns the existing share sid with reused=true. A wxacode failure never blocks creation (wxacode_url stays null).",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "session_id",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/TurnIdentifier" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShareCreateRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "The share snapshot was created.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ShareCreateResponse" },
              },
            },
          },
          "200": {
            description: "An identical selection already exists; the same sid is returned.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ShareCreateResponse" },
              },
            },
          },
          "400": errorResponse("The session_id, indices or sharer_name are invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "404": errorResponse("The session has no shareable history."),
          "422": errorResponse("策略性超限：所选消息超过 30 条、单条超 64KB 或总体积超 2MB（中文提示）."),
        },
      },
    },
    "/api/coach-shares/{sid}": {
      get: {
        tags: ["Shares"],
        operationId: "getCoachShare",
        summary: "Read a coach chat share snapshot (public)",
        description:
          "Public, unauthenticated share landing endpoint (30-day expiry computed at read time, light per-IP rate limit). Serves the immutable snapshot; the checkpoint is never touched.",
        parameters: [
          {
            name: "sid",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9]{16,22}$" },
          },
        ],
        responses: {
          "200": {
            description: "The share snapshot.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CoachShareResponse" },
              },
            },
          },
          "404": errorResponse("The share does not exist (malformed sid included)."),
          "410": errorResponse("The share expired (expired) or is no longer active (gone)."),
          "429": errorResponse("Per-IP read rate limit exceeded; retry after the indicated delay."),
        },
      },
    },
    "/api/lottery/activities/{id}": {
      get: {
        tags: ["Lottery"],
        operationId: "getLotteryActivityPublic",
        summary: "Read lottery landing-page display data (public)",
        description:
          "Public, unauthenticated read for the mini-program lottery landing page (#863): tier name/image/remaining stock, rules copy and the time-window phase. Weights and other internal configuration are never exposed. Unknown and not-yet-enabled activities are the same 404.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "Display data for the activity.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityPublicResponse" },
              },
            },
          },
          "404": errorResponse("The activity does not exist or is not enabled."),
        },
      },
    },
    "/api/lottery/activities/{id}/draw": {
      post: {
        tags: ["Lottery"],
        operationId: "drawLotteryActivity",
        summary: "Draw a lottery activity (login + bound watch required)",
        description:
          "The #865 draw core. Every gate is re-derived server-side: the activity must exist and be enabled (404 otherwise, same as the public read), the time window must be active (403 activity_not_active with the phase), and the caller must have a logged-in bound watch (403 watch_not_bound; presence-only secret semantics, same as GET /api/users/me/watch). The draw itself is one transaction: stock-aware weighted pick (zero-stock tiers skipped and re-normalized; the「谢谢参与」fallback tier when all physical tiers are empty), row-locked stock decrement (no oversell), and a random unoccupied 3-digit code (000-999) for physical wins. The three unique constraints are the anti-replay backstop: a repeat draw by the same user returns the committed result (200, deduplicated=true) instead of an error, and the same watch account re-drawing through another stride account is a 409 watch_already_drawn. After a fresh draw the server fires a fail-soft full-sync trigger in the background (skipped for users who already have pipeline runs; never affects the draw result).",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "201": {
            description: "The fresh draw result.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryDrawResponse" },
              },
            },
          },
          "200": {
            description: "The user already drew this activity; the committed result is returned (deduplicated=true).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryDrawResponse" },
              },
            },
          },
          "400": errorResponse("The activity id is malformed."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("The activity window is not active (activity_not_active) or no logged-in watch is bound (watch_not_bound)."),
          "404": errorResponse("The activity does not exist or is not enabled."),
          "409": errorResponse("This watch account already drew the activity through another stride account (watch_already_drawn)."),
        },
      },
    },
    "/api/lottery/activities/{id}/my-result": {
      get: {
        tags: ["Lottery"],
        operationId: "getLotteryMyResult",
        summary: "Read the caller's draw result for an activity",
        description:
          "The landing page prefetch: logged-in users who already drew render the result state directly. Returns participated=false for users who have not drawn; the participation record otherwise — prize view fields, the 3-digit code (null for「谢谢参与」), status (drawn / verified once P3 ships) and verification timestamps. Weights are never exposed.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "The participation state (participated=false when the user has not drawn).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryMyResultResponse" },
              },
            },
          },
          "400": errorResponse("The activity id is malformed."),
          "401": errorResponse("The bearer token is missing or invalid."),
        },
      },
    },
    "/api/admin/lottery/activities": {
      post: {
        tags: ["Lottery"],
        operationId: "createLotteryActivity",
        summary: "Create a lottery activity (admin)",
        description: "Creates a disabled activity; enable it with the enable endpoint once the prize pool and物料 are ready.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LotteryActivityRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "The created activity.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityResponse" },
              },
            },
          },
          "400": errorResponse("The body is structurally invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
          "422": errorResponse("The time window is empty (start must be before end)."),
        },
      },
      get: {
        tags: ["Lottery"],
        operationId: "listLotteryActivities",
        summary: "List lottery activities (admin)",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "All activities, newest first.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityListResponse" },
              },
            },
          },
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
        },
      },
    },
    "/api/admin/lottery/activities/{id}": {
      get: {
        tags: ["Lottery"],
        operationId: "getLotteryActivity",
        summary: "Read one lottery activity with its prize pool (admin)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "The activity including internal fields (weights, configured stock).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityDetailResponse" },
              },
            },
          },
          "400": errorResponse("The activity id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
          "404": errorResponse("The activity does not exist."),
        },
      },
      put: {
        tags: ["Lottery"],
        operationId: "updateLotteryActivity",
        summary: "Full update of a lottery activity (admin)",
        description: "PUT semantics: the activity scalar fields (name, time window, rules, hero image) are replaced wholesale.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LotteryActivityRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "The updated activity.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityResponse" },
              },
            },
          },
          "400": errorResponse("The body is structurally invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
          "404": errorResponse("The activity does not exist."),
          "422": errorResponse("The time window is empty (start must be before end)."),
        },
      },
    },
    "/api/admin/lottery/activities/{id}/prizes": {
      put: {
        tags: ["Lottery"],
        operationId: "replaceLotteryPrizes",
        summary: "Replace a lottery prize pool (admin)",
        description:
          "Wholesale replacement validated as a whole pool: exactly one「谢谢参与」fallback tier (stock 0), every weight > 0, total stock ≤ 999 (the 3-digit winning-code space). Rejected with 409 once any participation exists (#862 draw, P2).",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LotteryPrizesRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "The stored prize pool, insertion order = display order.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryPrizeListResponse" },
              },
            },
          },
          "400": errorResponse("The body is structurally invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
          "404": errorResponse("The activity does not exist."),
          "409": errorResponse("The activity already has participations; the pool can no longer be replaced."),
          "422": errorResponse("Pool rule violation: fallback tier count/stock or total stock > 999."),
        },
      },
    },
    "/api/admin/lottery/activities/{id}/enable": {
      post: {
        tags: ["Lottery"],
        operationId: "enableLotteryActivity",
        summary: "Enable a lottery activity (admin)",
        description: "启停 toggle: only enabled activities are served by the public landing endpoint.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "The updated activity.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityResponse" },
              },
            },
          },
          "400": errorResponse("The activity id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
          "404": errorResponse("The activity does not exist."),
        },
      },
    },
    "/api/admin/lottery/activities/{id}/disable": {
      post: {
        tags: ["Lottery"],
        operationId: "disableLotteryActivity",
        summary: "Disable a lottery activity (admin)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "The updated activity.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryActivityResponse" },
              },
            },
          },
          "400": errorResponse("The activity id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot configure lottery activities."),
          "404": errorResponse("The activity does not exist."),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      HealthResponse: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", const: "ok" } },
        additionalProperties: false,
      },
      ChatRequest: {
        oneOf: [{ $ref: "#/components/schemas/ChatMessageRequest" }, { $ref: "#/components/schemas/ChatResumeRequest" }],
      },
      ChatMessageRequest: {
        allOf: [
          { $ref: "#/components/schemas/ChatRequestBase" },
          {
            type: "object",
            required: ["message"],
            properties: {
              message: nonBlankString(20_000),
              timestamp: {
                type: "string",
                description: "ISO-8601 timestamp for the message. Defaults to the server's current Asia/Shanghai time when omitted.",
                example: "2026-05-09T14:30:00+08:00",
              },
            },
          },
        ],
      },
      ChatResumeRequest: {
        allOf: [
          { $ref: "#/components/schemas/ChatRequestBase" },
          {
            type: "object",
            required: ["resume"],
            properties: {
              resume: {
                oneOf: [
                  // Array items are capped individually; the handler also caps
                  // their combined length at 20,000 characters.
                  nonBlankString(20_000),
                  {
                    type: "array",
                    description: "The combined length of all answers must not exceed 20,000 characters.",
                    minItems: 1,
                    maxItems: 50,
                    items: nonBlankString(2_000),
                  },
                ],
              },
            },
          },
        ],
      },
      ChatRequestBase: {
        type: "object",
        required: ["session_id", "client_turn_id"],
        properties: {
          session_id: { $ref: "#/components/schemas/TurnIdentifier" },
          client_turn_id: { $ref: "#/components/schemas/TurnIdentifier" },
          target: { $ref: "#/components/schemas/CoachTarget" },
          review_context: { $ref: "#/components/schemas/ReviewContext" },
        },
      },
      TurnIdentifier: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
      },
      CoachTarget: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["master", "week", "session"] },
          plan_id: nullableString(128),
          folder: nullableString(128),
          date: { type: ["string", "null"], format: "date" },
          session_index: { type: ["integer", "null"], minimum: 0 },
        },
        additionalProperties: false,
      },
      ReviewContext: {
        type: "object",
        description:
          "Allowed only with target.kind=week. proposal.folder must equal target.folder. The serialized review_context must not exceed 65,536 bytes.",
        required: ["kind", "proposal"],
        properties: {
          kind: { type: "string", const: "weekly_create" },
          proposal: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
      ChatResponse: {
        oneOf: [{ $ref: "#/components/schemas/CompletedChatResponse" }, { $ref: "#/components/schemas/NeedsInputChatResponse" }],
      },
      SessionListResponse: {
        type: "object",
        required: ["sessions"],
        properties: {
          sessions: {
            type: "array",
            items: { $ref: "#/components/schemas/SessionListEntry" },
          },
        },
        additionalProperties: false,
      },
      SessionListEntry: {
        type: "object",
        required: ["session_id", "updated_at", "preview"],
        properties: {
          session_id: { $ref: "#/components/schemas/TurnIdentifier" },
          updated_at: { type: ["string", "null"], description: "ISO-8601 timestamp of the session's latest message." },
          preview: { type: "string", description: "The session's first user message, empty when none yet." },
        },
        additionalProperties: false,
      },
      SessionHistoryResponse: {
        type: "object",
        required: ["session_id", "thread_id", "messages"],
        properties: {
          session_id: { $ref: "#/components/schemas/TurnIdentifier" },
          thread_id: { type: "string" },
          messages: {
            type: "array",
            items: { $ref: "#/components/schemas/SessionHistoryMessage" },
          },
        },
        additionalProperties: false,
      },
      SessionHistoryMessage: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          content: { type: "string" },
          card: { $ref: "#/components/schemas/CardEnvelope" },
        },
        additionalProperties: false,
      },
      ShareCreateRequest: {
        type: "object",
        required: ["indices"],
        properties: {
          indices: {
            type: "array",
            description: "投影序号（toPublicHistory 输出下标，0 起）。服务端升序去重后最多 30 条。",
            minItems: 1,
            maxItems: 30,
            items: { type: "integer", minimum: 0 },
          },
          sharer_name: {
            type: "string",
            description: "分享者展示名（昵称），≤64 字符；缺省时快照不带该字段。",
            maxLength: 64,
          },
        },
        additionalProperties: false,
      },
      ShareCreateResponse: {
        type: "object",
        required: ["sid", "reused", "wxacode_url"],
        properties: {
          sid: { type: "string", description: "22 位 base62 分享 token：路径/二维码 scene/归因三合一。" },
          reused: { type: "boolean", description: "同一选集已分享过时为 true，sid 为既有分享。" },
          wxacode_url: {
            type: ["string", "null"],
            description: "小程序码 COS URL；fail-soft：生成失败为 null（分享创建不受阻）。null 的既有分享再次创建会重试一次。",
          },
        },
        additionalProperties: false,
      },
      CoachShareResponse: {
        type: "object",
        required: ["status", "message_count", "created_at", "wxacode_url", "messages"],
        properties: {
          status: { type: "string", const: "active" },
          sharer_name: { type: "string", description: "分享者展示名；快照未带时不出现。" },
          message_count: { type: "integer", minimum: 1 },
          created_at: { type: "string", format: "date-time", description: "快照创建时间；过期 = created_at + 30 天（读取时计算）。" },
          wxacode_url: { type: ["string", "null"] },
          messages: {
            type: "array",
            items: { $ref: "#/components/schemas/ShareMessage" },
          },
        },
        additionalProperties: false,
      },
      ShareMessage: {
        type: "object",
        description: "与 SessionHistoryMessage 同形（role/content/card），来自创建时服务端抽取的不可变快照。",
        required: ["role", "content"],
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          content: { type: "string" },
          card: { $ref: "#/components/schemas/CardEnvelope" },
        },
        additionalProperties: false,
      },
      CardEnvelope: {
        type: "object",
        description: "结构化产物信封，挂在产生它的 assistant 消息上（随 checkpoint 持久化）。done 响应与历史行共用。",
        required: ["$type", "data"],
        properties: {
          $type: { type: "string", description: "双端约定的渲染器 key（kebab-case），如 race-strategy。" },
          data: { type: "object", description: "产物本体，形状由 $type 决定（节点侧已 zod 校验）。" },
        },
        additionalProperties: false,
      },
      CompletedChatResponse: {
        type: "object",
        required: ["status", "message", "session_id", "client_turn_id"],
        properties: {
          status: { type: "string", const: "completed" },
          message: { type: "string" },
          card: { $ref: "#/components/schemas/CardEnvelope" },
          session_id: { $ref: "#/components/schemas/TurnIdentifier" },
          client_turn_id: { $ref: "#/components/schemas/TurnIdentifier" },
        },
        additionalProperties: false,
      },
      NeedsInputChatResponse: {
        type: "object",
        required: ["status", "interrupt", "session_id", "client_turn_id"],
        properties: {
          status: { type: "string", const: "needs_input" },
          interrupt: {},
          session_id: { $ref: "#/components/schemas/TurnIdentifier" },
          client_turn_id: { $ref: "#/components/schemas/TurnIdentifier" },
        },
        additionalProperties: false,
      },
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
        additionalProperties: false,
      },
      CoachDataDeletionResponse: {
        type: "object",
        required: ["user_id", "deleted"],
        properties: {
          user_id: { $ref: "#/components/schemas/TurnIdentifier" },
          deleted: {
            type: "object",
            description: "Affected row count per coach table.",
            additionalProperties: { type: "integer", minimum: 0 },
          },
        },
        additionalProperties: false,
      },
      PlanJobEnqueueRequest: {
        type: "object",
        required: ["job_type", "request"],
        properties: {
          job_type: {
            type: "string",
            enum: ["generate_master_plan", "generate_weekly_plan"],
          },
          request: {
            type: "object",
            description:
              "The kernel request, schema depends on job_type (MasterPlanGraphRequest for generate_master_plan, WeeklyPlanGeneratorRequest for generate_weekly_plan). Re-validated server-side.",
            additionalProperties: true,
          },
          idempotency_key: {
            type: "string",
            description: "Deduplicates enqueue: at most one job per (user, key).",
            maxLength: 128,
          },
        },
        additionalProperties: false,
      },
      WeeklyPlanGeneratorRequest: {
        type: "object",
        required: ["request_id"],
        properties: {
          request_id: { type: "string", minLength: 1 },
          requested_as_of: {
            type: "string",
            format: "date-time",
            description: "ISO-8601 instant; the graph targets the current or next Asia/Shanghai week.",
          },
        },
        additionalProperties: false,
      },
      PlanJobEnqueueResponse: {
        type: "object",
        required: ["job_id", "job_type", "estimated_duration_seconds"],
        properties: {
          job_id: { $ref: "#/components/schemas/TurnIdentifier" },
          job_type: { type: "string" },
          estimated_duration_seconds: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      PlanJobPollResponse: {
        type: "object",
        required: ["job_id", "job_type", "status", "stage", "progress_pct", "error_code", "result_draft_id"],
        properties: {
          job_id: { $ref: "#/components/schemas/TurnIdentifier" },
          job_type: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "done", "failed"] },
          stage: { type: "string" },
          progress_pct: { type: "integer", minimum: 0, maximum: 100 },
          error_code: { type: ["string", "null"] },
          result_draft_id: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      LotteryActivityRequest: {
        type: "object",
        required: ["name", "start_at", "end_at"],
        properties: {
          name: nonBlankString(128),
          start_at: { type: "string", description: "ISO-8601 with explicit timezone (Z or ±HH:MM)." },
          end_at: { type: "string", description: "ISO-8601 with explicit timezone; must be after start_at." },
          rules_text: { type: "string", maxLength: 20000 },
          hero_image: { type: "string", maxLength: 512, pattern: "^https://\\S+$" },
        },
        additionalProperties: false,
      },
      LotteryActivityResponse: {
        type: "object",
        required: ["id", "name", "start_at", "end_at", "enabled", "rules_text", "hero_image", "status", "created_at", "updated_at"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          start_at: { type: "string" },
          end_at: { type: "string" },
          enabled: { type: "boolean" },
          rules_text: { type: ["string", "null"] },
          hero_image: { type: ["string", "null"] },
          status: { type: "string", enum: ["not_started", "active", "ended"], description: "Time-window phase derived at read time." },
          created_at: { type: "string" },
          updated_at: { type: "string" },
        },
        additionalProperties: false,
      },
      LotteryActivityListResponse: {
        type: "object",
        required: ["activities"],
        properties: {
          activities: { type: "array", items: { $ref: "#/components/schemas/LotteryActivityResponse" } },
        },
        additionalProperties: false,
      },
      LotteryActivityDetailResponse: {
        allOf: [
          { $ref: "#/components/schemas/LotteryActivityResponse" },
          {
            type: "object",
            required: ["prizes"],
            properties: {
              prizes: { type: "array", items: { $ref: "#/components/schemas/LotteryPrizeResponse" } },
            },
          },
        ],
      },
      LotteryPrizesRequest: {
        type: "object",
        required: ["prizes"],
        properties: {
          prizes: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["name", "stock", "weight", "is_fallback"],
              properties: {
                name: nonBlankString(128),
                image_url: { type: "string", maxLength: 512, pattern: "^https://\\S+$" },
                stock: { type: "integer", minimum: 0, maximum: 999 },
                weight: { type: "integer", minimum: 1, maximum: 1000000 },
                is_fallback: { type: "boolean", description: "Exactly one tier per activity must set this." },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      LotteryPrizeResponse: {
        type: "object",
        required: ["id", "name", "image_url", "stock", "remaining", "weight", "is_fallback"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          image_url: { type: ["string", "null"] },
          stock: { type: "integer" },
          remaining: { type: "integer" },
          weight: { type: "integer" },
          is_fallback: { type: "boolean" },
        },
        additionalProperties: false,
      },
      LotteryPrizeListResponse: {
        type: "object",
        required: ["prizes"],
        properties: {
          prizes: { type: "array", items: { $ref: "#/components/schemas/LotteryPrizeResponse" } },
        },
        additionalProperties: false,
      },
      LotteryActivityPublicResponse: {
        type: "object",
        required: ["id", "name", "hero_image", "rules_text", "start_at", "end_at", "status", "prizes"],
        description: "Display fields only — weights and internal configuration are never exposed.",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          hero_image: { type: ["string", "null"] },
          rules_text: { type: ["string", "null"] },
          start_at: { type: "string" },
          end_at: { type: "string" },
          status: { type: "string", enum: ["not_started", "active", "ended"] },
          prizes: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "image_url", "remaining", "is_fallback"],
              properties: {
                name: { type: "string" },
                image_url: { type: ["string", "null"] },
                remaining: { type: ["integer", "null"], description: "null for the fallback tier (never runs out)." },
                is_fallback: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      LotteryDrawResponse: {
        type: "object",
        required: ["participated", "deduplicated", "prize", "code", "status", "created_at"],
        description: "Draw result (201 fresh, 200 repeat). Weights and configured stock are never exposed.",
        properties: {
          participated: { type: "boolean" },
          deduplicated: { type: "boolean", description: "true when the unique constraints resolved a replay to the committed result." },
          prize: {
            type: ["object", "null"],
            required: ["name", "image_url", "is_fallback"],
            properties: {
              name: { type: "string" },
              image_url: { type: ["string", "null"] },
              is_fallback: { type: "boolean" },
            },
            additionalProperties: false,
          },
          code: { type: ["string", "null"], pattern: "^[0-9]{3}$", description: "3-digit zero-padded winning code; null for「谢谢参与」." },
          status: { type: "string", enum: ["drawn"] },
          created_at: { type: "string" },
        },
        additionalProperties: false,
      },
      LotteryMyResultResponse: {
        type: "object",
        required: ["participated"],
        description: "The caller's participation state; everything but participated is present only after drawing.",
        properties: {
          participated: { type: "boolean" },
          prize: {
            type: ["object", "null"],
            required: ["name", "image_url", "is_fallback"],
            properties: {
              name: { type: "string" },
              image_url: { type: ["string", "null"] },
              is_fallback: { type: "boolean" },
            },
            additionalProperties: false,
          },
          code: { type: ["string", "null"], pattern: "^[0-9]{3}$" },
          status: { type: "string", enum: ["drawn"] },
          verified_at: { type: ["string", "null"], description: "Filled by the P3 verification domain." },
          created_at: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
} as const;

function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
      },
    },
  };
}

function nullableString(maxLength: number) {
  return { type: ["string", "null"], minLength: 1, maxLength };
}

function nonBlankString(maxLength: number) {
  return {
    type: "string",
    minLength: 1,
    maxLength,
    pattern: ".*\\S.*",
  };
}
