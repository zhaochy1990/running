import { createHash } from "node:crypto";
import { getLogger } from "@stride/common";
import type { TurnRequest } from "../dto/turn.js";
import { TurnConflictError } from "./errors.js";
import type { ThreadLock, TurnReceiptStore } from "./receiptStore.js";

const logger = getLogger("turn/coordinator");

export interface TurnCoordinator {
  run<T extends Record<string, unknown>>(request: TurnRequest, operation: (resumeFromCheckpoint: boolean) => Promise<T>): Promise<T>;

  getFingerprint(payload: unknown): string;
}

export class CoordinatedTurnRunner implements TurnCoordinator {
  constructor(
    private readonly receipts: TurnReceiptStore,
    private readonly lock: ThreadLock,
  ) {}

  run<T extends Record<string, unknown>>(request: TurnRequest, operation: (resumeFromCheckpoint: boolean) => Promise<T>): Promise<T> {
    return this.lock.runExclusive(request.threadId, async () => {
      const existing = await this.receipts.get(request.threadId, request.clientTurnId);
      if (existing) {
        if (existing.fingerprint === request.fingerprint) {
          return existing.response as T;
        }
        logger.warn("client_turn_id was reused with a different request");
      }

      const recovered = await this.receipts.recover(request.threadId, request.clientTurnId);
      const recoveredFingerprint = recovered?.kind === "complete" ? recovered.receipt.fingerprint : recovered?.fingerprint;
      if (recoveredFingerprint !== undefined && recoveredFingerprint !== request.fingerprint) {
        throw new TurnConflictError("client_turn_id was reused with a different request");
      }
      if (recovered?.kind === "complete") {
        await this.receipts.put(request.threadId, request.clientTurnId, recovered.receipt);
        await this.receipts.prune(request.threadId, 50);
        return recovered.receipt.response as T;
      }

      const response = await operation(recovered?.kind === "incomplete");
      await this.receipts.put(request.threadId, request.clientTurnId, {
        fingerprint: request.fingerprint,
        response,
      });
      await this.receipts.prune(request.threadId, 50);
      return response;
    });
  }

  getFingerprint(payload: unknown): string {
    return createHash("sha256").update(this.stableJson(payload)).digest("hex");
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(this.stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableJson(item)}`)
        .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("turn fingerprint is not JSON serializable");
    return encoded;
  }
}
