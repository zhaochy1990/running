import { getLogger } from "@stride/common";

const logger = getLogger("coach-api/race-strategy-client");

/**
 * Minimal client for the Go internal race-strategy write endpoint
 * (`POST /api/users/{user_id}/race-strategies`, X-Internal-Token). Upsert-only
 * (UNIQUE(user, event) keeps the latest version); Go stays the single writer of
 * the race_strategy table, mirroring the plan-draft discipline (ADR 0006/0030).
 */
export class GoRaceStrategyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Persist the strategy the coach produced for one race. Non-fatal by design:
   * a failed write is logged and reported as false — the chat reply itself must
   * still reach the athlete.
   */
  async saveRaceStrategy(userId: string, raceEventId: number, itemType: string, content: unknown): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/users/${userId}/race-strategies`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.internalToken,
        },
        body: JSON.stringify({ race_event_id: raceEventId, item_type: itemType, content }),
      });
    } catch (error) {
      logger.error({ err: error instanceof Error ? error : undefined, userId, raceEventId }, "race strategy save: Go API unreachable");
      return false;
    }
    if (response.status === 200 || response.status === 201) {
      logger.info({ userId, raceEventId, status: response.status }, "race strategy saved via Go internal endpoint");
      return true;
    }
    const detail = await safeText(response);
    logger.error({ userId, raceEventId, status: response.status, detail }, "race strategy save rejected by Go API");
    return false;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
