import { getLogger } from "@stride/common";
import { ERROR_CODES, newPermanentError } from "../job/errors.js";

const logger = getLogger("plan-job/go-client");

interface InsertDraftResponse {
  success: boolean;
  plan_id: string;
  status: string;
}

/**
 * Minimal client for the Go internal plan-draft insert endpoints
 * (`POST /api/users/{user_id}/master-plan/drafts` and
 * `POST /api/users/{user_id}/plan/weeks/{weekName}/drafts`,
 * X-Internal-Token). Insert-only and idempotent by draft_id; the worker never
 * touches plan tables directly (Go stays the single writer — ADR 0006/0030).
 */
export class GoDraftClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Insert a season plan draft. Idempotent: `draftId` replay returns the
   * existing plan id. Rejected content or config errors are permanent
   * (re-validating/re-running cannot fix them); 5xx faults are retryable.
   */
  insertMasterPlanDraft(userId: string, draftId: string, content: unknown): Promise<string> {
    return this.insertDraftTo(`/api/users/${userId}/master-plan/drafts`, draftId, content);
  }

  /**
   * Insert a this-week schedule draft for a Shanghai week. Idempotent by
   * `draftId`; error handling matches the master-plan insert. Note the weekly
   * route has no `users` segment (`/api/:user/plan/weeks/:weekName/drafts`),
   * unlike the master route (`/api/users/:user_id/master-plan/drafts`).
   */
  insertWeeklyPlanDraft(userId: string, weekName: string, draftId: string, content: unknown): Promise<string> {
    return this.insertDraftTo(`/api/${userId}/plan/weeks/${weekName}/drafts`, draftId, content);
  }

  private async insertDraftTo(path: string, draftId: string, content: unknown): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": this.internalToken,
      },
      body: JSON.stringify({ draft_id: draftId, content }),
    });

    if (response.status === 201 || response.status === 200) {
      const body = (await response.json()) as Partial<InsertDraftResponse>;
      if (typeof body.plan_id !== "string" || body.plan_id.length === 0) {
        throw new Error("go draft insert returned no plan_id");
      }
      logger.info({ draftId, status: response.status, planId: body.plan_id, path }, "plan draft inserted via Go internal endpoint");
      return body.plan_id;
    }

    const detail = await safeText(response);
    if (response.status === 422 || response.status === 400 || response.status === 409 || response.status === 403) {
      // Deterministic on the generated content / config — retrying cannot fix it.
      throw newPermanentError(ERROR_CODES.DRAFT_REJECTED, new Error(`go draft insert ${response.status}: ${detail}`));
    }
    // 401 (bad token), 413, 5xx — transient unclear / infra: retry policy applies.
    throw new Error(`go draft insert failed (${response.status}): ${detail}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
