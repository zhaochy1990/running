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
