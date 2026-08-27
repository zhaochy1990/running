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
      CompletedChatResponse: {
        type: "object",
        required: ["status", "message", "session_id", "client_turn_id"],
        properties: {
          status: { type: "string", const: "completed" },
          message: { type: "string" },
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
