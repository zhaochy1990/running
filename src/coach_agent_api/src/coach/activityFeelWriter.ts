import type { ActivityFeelWriter } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import type { ApiConfig } from "../dto/config.js";

const logger = getLogger("coachApi:activityFeelWriter");

/** 落库是问答 turn 的增值步骤，不把回复拖死在慢网络上。 */
const PATCH_TIMEOUT_MS = 10_000;

/**
 * #508 体感落库写端口：qa agent 的 set_activity_feel 经 Go API 的
 * PATCH /api/{user}/activities/{labelId} 写归一化 feel 列（Go 是 activities
 * 的唯一写入方，与 GoDraftClient/GoJobClient 同一依赖形态，X-Internal-Token）。
 * 失败直接抛错——落库失败必须让教练如实告诉运动员，不能假装成功。
 */
export function createActivityFeelWriter(goApi: ApiConfig["goApi"], fetchImpl: typeof fetch = fetch): ActivityFeelWriter {
  return {
    async setActivityFeel(userId, labelId, feel) {
      const response = await fetchImpl(`${goApi.baseUrl}/api/${encodeURIComponent(userId)}/activities/${encodeURIComponent(labelId)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-internal-token": goApi.internalToken,
        },
        body: JSON.stringify({ feel }),
        signal: AbortSignal.timeout(PATCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`set activity feel failed (${response.status}): ${await response.text()}`);
      }
      logger.info({ userId, labelId, feel }, "activity feel persisted via Go API");
    },
  };
}
