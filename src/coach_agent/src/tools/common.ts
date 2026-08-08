/**
 * Generic tool factory — turn plain domain handlers into LangChain tools.
 *
 * Keeps two concerns separate:
 *   - Domain logic (a class/function that takes parsed `input` + typed `runtime`
 *     and returns rich data). Pure, LangChain-agnostic, easy to unit-test.
 *   - LangChain wiring (name/description/schema + `CoachToolRuntime` typing +
 *     output serialization). Centralized here so callers never hand-write
 *     `tool(...)` boilerplate again.
 *
 * `userId` (and any other global) is read from `runtime.context` — never a tool
 * argument (see src/coach_agent/AGENTS.md).
 *
 * @example Wrap a store-backed domain class
 * ```ts
 * // activities.ts
 * const getRecentActivitiesSchema = z.object({ limit: z.number().optional() });
 *
 * export class MySQLActivitiesTool {
 *   constructor(private store: StrideDataStore) {}
 *   async getRecentActivities(
 *     input: z.infer<typeof getRecentActivitiesSchema>,
 *     runtime: CoachToolRuntime,
 *   ): Promise<Activity[]> {
 *     const userId = runtime.context?.userId;
 *     return this.store.getRecentActivities(userId, input.limit ?? 10);
 *   }
 * }
 *
 * export function createActivitiesTools(store: StrideDataStore) {
 *   const impl = new MySQLActivitiesTool(store);
 *   return defineCoachTools([
 *     {
 *       name: "get_recent_activities",
 *       description: "Get recent training activities for the athlete",
 *       schema: getRecentActivitiesSchema,
 *       handler: (input, runtime) => impl.getRecentActivities(input, runtime),
 *     },
 *   ]);
 * }
 * ```
 */

import { tool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";

/**
 * A domain handler: pure business logic. Receives the parsed tool `input` and
 * the typed `CoachToolRuntime` (use `runtime.context?.userId`). May return any
 * JSON-serializable value — the factory serializes it into the ToolMessage.
 */
export type CoachToolHandler<Schema extends z.ZodObject<any>, Output> = (
  input: z.infer<Schema>,
  runtime: CoachToolRuntime,
) => Output | Promise<Output>;

/** Declarative description of one tool: metadata + schema + domain handler. */
export interface CoachToolSpec<
  Schema extends z.ZodObject<any> = z.ZodObject<any>,
  Output = unknown,
> {
  /** Model-facing tool name. Prefer snake_case. */
  name: string;
  /** Model-facing description — when/why to call this tool. */
  description: string;
  /** Zod input schema. Do NOT put `userId` here; it comes from context. */
  schema: Schema;
  /** Domain logic that produces the tool's result. */
  handler: CoachToolHandler<Schema, Output>;
}

/**
 * Wrap a single {@link CoachToolSpec} into a LangChain tool.
 */
/**
 * Wrap a single {@link CoachToolSpec} into a LangChain tool.
 *
 * Internally this is `tool(...)` with the `runtime` argument pre-typed as
 * `CoachToolRuntime`, so every handler gets `runtime.context.userId` typing for
 * free. The return type is whatever `tool()` infers (a `DynamicStructuredTool`),
 * so no type information is discarded.
 */
export function defineCoachTool<Schema extends z.ZodObject<any>, Output>(
  spec: CoachToolSpec<Schema, Output>,
) {
  return tool(
    (input: z.infer<Schema>, runtime: CoachToolRuntime) =>
      spec.handler(input, runtime),
    {
      name: spec.name,
      description: spec.description,
      schema: spec.schema,
    },
  );
}

/** Wrap many specs at once — convenience over mapping {@link defineCoachTool}. */
export function defineCoachTools(specs: Array<CoachToolSpec<any, any>>) {
  return specs.map(defineCoachTool);
}