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
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scene: {
                    type: "string",
                    pattern: "^[\\x21-\\x7e]{1,32}$",
                    description:
                      "Optional 点位渠道号 (the QR scene `s` parameter) for the #867 funnel grouping; an invalid value is ignored, never a draw failure.",
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
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
          "The landing page prefetch: logged-in users who already drew render the result state directly. Returns participated=false for users who have not drawn; the participation record otherwise — prize view fields, the 3-digit code (null for「谢谢参与」), status (drawn / verified) and verification timestamps. Weights are never exposed.",
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
    "/api/lottery/activities/{id}/verify/lookup": {
      post: {
        tags: ["Lottery"],
        operationId: "lookupLotteryWinningCode",
        summary: "Look up a winning entry by its 3-digit code (staff)",
        description:
          "The #866 verify domain, first half. The caller authenticates with a user token and proves their staff identity by a fresh wx.login() code, which the server resolves to the requester's openid (auth-service internal endpoint) and checks against the lottery_staff whitelist (global rows or activity-scoped rows). A whitelisted miss is impossible to probe around: 403 not_staff carries the requester's own openid back, so the mini-program can display/copy it for the admin to whitelist. Lookups and redeems share one per-openid budget (30/minute) — the 3-digit code space only has 1000 entries. Every lookup is audit-logged (found / not_found).「谢谢参与」entries carry no code, so an unknown code is a definitive code_not_found.",
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
            "application/json": { schema: { $ref: "#/components/schemas/LotteryVerifyRequest" } },
          },
        },
        responses: {
          "200": {
            description: "The winning entry details for on-site cross-checking.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryVerifyResponse" },
              },
            },
          },
          "400": errorResponse("The activity id, code (exactly 3 digits) or wx_code is malformed."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("The resolved openid is not whitelisted (not_staff; the body carries the requester's own openid)."),
          "404": errorResponse("The activity does not exist / is not enabled, or the code does not exist (code_not_found)."),
          "429": errorResponse("Per-openid lookup/redeem rate limit exceeded; retry after the indicated delay."),
          "503": errorResponse("The staff-openid resolver is not configured or the auth-service endpoint failed (verify_openid_unavailable)."),
        },
      },
    },
    "/api/lottery/activities/{id}/verify/redeem": {
      post: {
        tags: ["Lottery"],
        operationId: "redeemLotteryWinningCode",
        summary: "Redeem a winning entry (staff)",
        description:
          "The #866 verify domain, second half: 待核销 (drawn) → 已核销 (verified) under a row lock, recording the verifier's openid and timestamp. Re-redeeming an already-verified entry changes nothing: the response is 200 with already_verified=true and the committed verifier + time (拒绝变更). The audit row is written in the same transaction as the state transition, so a committed redeem never lacks its trail. The activity time window is intentionally not enforced here — prize redemption continues after the draw window; enabled is the only switch.",
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
            "application/json": { schema: { $ref: "#/components/schemas/LotteryVerifyRequest" } },
          },
        },
        responses: {
          "200": {
            description: "The redeem result (already_verified=true when the entry was verified before).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryVerifyRedeemResponse" },
              },
            },
          },
          "400": errorResponse("The activity id, code (exactly 3 digits) or wx_code is malformed."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("The resolved openid is not whitelisted (not_staff; the body carries the requester's own openid)."),
          "404": errorResponse("The activity does not exist / is not enabled, or the code does not exist (code_not_found)."),
          "429": errorResponse("Per-openid lookup/redeem rate limit exceeded; retry after the indicated delay."),
          "503": errorResponse("The staff-openid resolver is not configured or the auth-service endpoint failed (verify_openid_unavailable)."),
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
    "/api/admin/lottery/activities/{id}/funnel": {
      get: {
        tags: ["Lottery"],
        operationId: "getLotteryFunnel",
        summary: "Participation funnel grouped by scene channel (admin)",
        description:
          "The #867 live dashboard read. Pre-draw stages (enter/login/bind) are ping counts from the public event endpoint; post-draw stages (draw/win/verified) are people counted from lottery_participations — win means a physical tier (code assigned), verified counts committed redemptions via verified_at. Rows are grouped by the scene `s` parameter baked into each QR stand; null scene = direct links / no channel.",
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
            description: "Funnel per scene + totals + per-tier remaining stock.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryFunnelResponse" },
              },
            },
          },
          "400": errorResponse("The activity id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot read lottery dashboards."),
          "404": errorResponse("The activity does not exist."),
        },
      },
    },
    "/api/lottery/activities/{id}/events": {
      post: {
        tags: ["Lottery"],
        operationId: "recordLotteryEvent",
        summary: "Funnel stage ping from the landing page (public)",
        description:
          "Best-effort funnel analytics for the #867 dashboard: the mini-program landing page pings `{stage: enter|login|bind, scene?}` at each stage transition. Public (no auth); a bearer, when present and valid, is used for user attribution only. Per-IP fixed-window rate limited (60/min per activity); the client fire-and-forgets and ignores the outcome.",
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
              schema: { $ref: "#/components/schemas/LotteryEventRequest" },
            },
          },
        },
        responses: {
          "204": { description: "Recorded." },
          "400": errorResponse("The body or activity id is invalid."),
          "404": errorResponse("The activity does not exist."),
          "429": errorResponse("Per-IP rate limit exceeded."),
        },
      },
    },
    "/api/admin/lottery/staff": {
      get: {
        tags: ["Lottery"],
        operationId: "listLotteryStaff",
        summary: "List the verification staff whitelist (admin)",
        description:
          "All whitelist rows (global rows with activity_id null plus activity-scoped rows). `?activity_id=` filters to that activity's rows plus the global ones.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "activity_id",
            in: "query",
            required: false,
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "The whitelist rows.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryStaffListResponse" },
              },
            },
          },
          "400": errorResponse("The activity_id query param is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot manage the whitelist."),
        },
      },
      post: {
        tags: ["Lottery"],
        operationId: "addLotteryStaff",
        summary: "Add a verification staff member (admin)",
        description:
          "Adds one whitelist row. activity_id omitted = global (may verify every activity); note is free-form (e.g. 现场值班人姓名). The openid comes from the mini-program verification page's not-whitelisted hint, which shows the requester's own openid for copy-paste.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LotteryStaffRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "The created whitelist row.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LotteryStaffResponse" },
              },
            },
          },
          "400": errorResponse("The body is structurally invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot manage the whitelist."),
        },
      },
    },
    "/api/admin/lottery/staff/{id}": {
      delete: {
        tags: ["Lottery"],
        operationId: "removeLotteryStaff",
        summary: "Remove a verification staff member (admin)",
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
          "204": { description: "Removed." },
          "400": errorResponse("The staff id is invalid."),
          "401": errorResponse("The bearer token is missing or invalid."),
          "403": errorResponse("A non-admin token cannot manage the whitelist."),
          "404": errorResponse("The whitelist row does not exist."),
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
            enum: ["generate_master_plan", "generate_rolling_block", "generate_adjustment"],
          },
          request: {
            type: "object",
            description:
              "The kernel request, schema depends on job_type (MasterPlanGraphRequest for generate_master_plan, RollingJobRequest for generate_rolling_block, AdjustJobRequest for generate_adjustment). Re-validated server-side.",
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
          status: { type: "string", enum: ["drawn", "verified"], description: "verified after the #866 staff redeem." },
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
          status: { type: "string", enum: ["drawn", "verified"], description: "verified after the #866 staff redeem." },
          verified_at: { type: ["string", "null"], description: "Set by the #866 staff redeem." },
          created_at: { type: "string" },
        },
        additionalProperties: false,
      },
      LotteryVerifyRequest: {
        type: "object",
        required: ["code", "wx_code"],
        description:
          "#866 verify endpoints: the 3-digit winning code plus a fresh wx.login() code the server resolves to the requester's openid (single-use at WeChat's side — fetch a new one per request).",
        properties: {
          code: { type: "string", pattern: "^[0-9]{3}$", description: "3-digit zero-padded winning code printed on the winner's page." },
          wx_code: { type: "string", minLength: 1, maxLength: 128, description: "A fresh wx.login() code; resolved server-side to the staff openid." },
        },
        additionalProperties: false,
      },
      LotteryVerifyResponse: {
        type: "object",
        required: ["code", "status", "prize", "won_at", "verified_at", "verified_by"],
        description: "The winning entry as the staff sees it before confirming the redeem.",
        properties: {
          code: { type: "string", pattern: "^[0-9]{3}$" },
          status: { type: "string", enum: ["drawn", "verified"] },
          prize: {
            type: "object",
            required: ["name", "image_url", "is_fallback"],
            properties: {
              name: { type: "string" },
              image_url: { type: ["string", "null"] },
              is_fallback: { type: "boolean" },
            },
            additionalProperties: false,
          },
          won_at: { type: "string", description: "When the winner drew (ISO-8601)." },
          verified_at: { type: ["string", "null"] },
          verified_by: { type: ["string", "null"], description: "The verifier openid, set by the redeem." },
        },
        additionalProperties: false,
      },
      LotteryVerifyRedeemResponse: {
        type: "object",
        required: ["code", "status", "prize", "won_at", "verified_at", "verified_by", "already_verified"],
        description: "The redeem outcome; already_verified=true means the committed verification was returned unchanged.",
        properties: {
          code: { type: "string", pattern: "^[0-9]{3}$" },
          status: { type: "string", const: "verified" },
          prize: {
            type: "object",
            required: ["name", "image_url", "is_fallback"],
            properties: {
              name: { type: "string" },
              image_url: { type: ["string", "null"] },
              is_fallback: { type: "boolean" },
            },
            additionalProperties: false,
          },
          won_at: { type: "string" },
          verified_at: { type: "string", description: "When the entry was verified (ISO-8601)." },
          verified_by: { type: "string", description: "The verifier openid that committed this redemption." },
          already_verified: { type: "boolean" },
        },
        additionalProperties: false,
      },
      LotteryEventRequest: {
        type: "object",
        required: ["stage"],
        properties: {
          stage: { type: "string", enum: ["enter", "login", "bind"] },
          scene: {
            type: ["string", "null"],
            pattern: "^[\\x21-\\x7e]{1,32}$",
            description: "点位渠道号 (the scene `s` parameter); null/omitted for direct links.",
          },
        },
        additionalProperties: false,
      },
      LotteryFunnelSceneRow: {
        type: "object",
        required: ["scene", "enter", "login", "bind", "draw", "win", "verified"],
        properties: {
          scene: { type: ["string", "null"], description: "null = direct links / no channel." },
          enter: { type: "integer", description: "Landing-page views (pings)." },
          login: { type: "integer", description: "Login-stage pings." },
          bind: { type: "integer", description: "Watch-binding-stage pings." },
          draw: { type: "integer", description: "Participations (people)." },
          win: { type: "integer", description: "Physical wins — a code was assigned (people)." },
          verified: { type: "integer", description: "Redeemed participations via verified_at (people)." },
        },
        additionalProperties: false,
      },
      LotteryFunnelResponse: {
        type: "object",
        required: ["activity", "scenes", "totals", "prizes"],
        properties: {
          activity: {
            type: "object",
            required: ["id", "name", "start_at", "end_at", "enabled"],
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              start_at: { type: "string" },
              end_at: { type: "string" },
              enabled: { type: "boolean" },
            },
            additionalProperties: false,
          },
          scenes: { type: "array", items: { $ref: "#/components/schemas/LotteryFunnelSceneRow" } },
          totals: { $ref: "#/components/schemas/LotteryFunnelSceneRow" },
          prizes: {
            type: "array",
            description: "Per-tier remaining stock alongside the funnel (live 库存余量).",
            items: {
              type: "object",
              required: ["name", "image_url", "stock", "remaining", "is_fallback"],
              properties: {
                name: { type: "string" },
                image_url: { type: ["string", "null"] },
                stock: { type: "integer" },
                remaining: { type: "integer" },
                is_fallback: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      LotteryStaffRequest: {
        type: "object",
        required: ["openid"],
        properties: {
          openid: nonBlankString(128),
          activity_id: { type: "integer", minimum: 1, description: "Omitted = global whitelist row." },
          note: { type: "string", maxLength: 255 },
        },
        additionalProperties: false,
      },
      LotteryStaffResponse: {
        type: "object",
        required: ["id", "openid", "activity_id", "note", "created_at"],
        properties: {
          id: { type: "integer" },
          openid: { type: "string" },
          activity_id: { type: ["integer", "null"] },
          note: { type: ["string", "null"] },
          created_at: { type: "string" },
        },
        additionalProperties: false,
      },
      LotteryStaffListResponse: {
        type: "object",
        required: ["staff"],
        properties: {
          staff: { type: "array", items: { $ref: "#/components/schemas/LotteryStaffResponse" } },
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
