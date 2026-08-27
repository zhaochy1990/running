import type { TurnReceipt } from "./receipt.js";

export type TurnRecovery = { kind: "complete"; receipt: TurnReceipt } | { kind: "incomplete"; fingerprint: string };

export interface TurnReceiptStore {
  get(threadId: string, clientTurnId: string): Promise<TurnReceipt | undefined>;
  recover(threadId: string, clientTurnId: string): Promise<TurnRecovery | undefined>;
  put(threadId: string, clientTurnId: string, receipt: TurnReceipt): Promise<void>;
  prune(threadId: string, keep: number): Promise<void>;
}

export interface ThreadLock {
  runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
}

export class InMemoryTurnState implements TurnReceiptStore, ThreadLock {
  private readonly receipts = new Map<string, TurnReceipt>();
  private readonly turnOrder = new Map<string, string[]>();
  private readonly tails = new Map<string, Promise<void>>();

  get(threadId: string, clientTurnId: string): Promise<TurnReceipt | undefined> {
    return Promise.resolve(this.receipts.get(`${threadId}:${clientTurnId}`));
  }

  recover(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  put(threadId: string, clientTurnId: string, receipt: TurnReceipt): Promise<void> {
    this.receipts.set(`${threadId}:${clientTurnId}`, receipt);
    this.turnOrder.set(threadId, [...(this.turnOrder.get(threadId) ?? []).filter((turnId) => turnId !== clientTurnId), clientTurnId]);
    return Promise.resolve();
  }

  prune(threadId: string, keep: number): Promise<void> {
    const ordered = this.turnOrder.get(threadId) ?? [];
    for (const turnId of ordered.slice(0, -keep)) {
      this.receipts.delete(`${threadId}:${turnId}`);
    }
    this.turnOrder.set(threadId, ordered.slice(-keep));
    return Promise.resolve();
  }

  async runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(threadId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    }
  }
}
