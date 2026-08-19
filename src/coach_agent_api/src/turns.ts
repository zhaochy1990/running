import { createHash } from "node:crypto";

export interface TurnRequest {
	threadId: string;
	clientTurnId: string;
	fingerprint: string;
}

export interface TurnCoordinator {
	run<T extends Record<string, unknown>>(
		request: TurnRequest,
		operation: (resumeFromCheckpoint: boolean) => Promise<T>,
	): Promise<T>;
}

export interface TurnReceipt {
	fingerprint: string;
	response: Record<string, unknown>;
}

export interface TurnReceiptStore {
	get(threadId: string, clientTurnId: string): Promise<TurnReceipt | undefined>;
	recover(
		threadId: string,
		clientTurnId: string,
	): Promise<TurnRecovery | undefined>;
	put(
		threadId: string,
		clientTurnId: string,
		receipt: TurnReceipt,
	): Promise<void>;
	prune(threadId: string, keep: number): Promise<void>;
}

export type TurnRecovery =
	| { kind: "complete"; receipt: TurnReceipt }
	| { kind: "incomplete"; fingerprint: string };

export interface ThreadLock {
	runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
}

export class TurnConflictError extends Error {}
export class ThreadBusyError extends Error {}

class InMemoryTurnState implements TurnReceiptStore, ThreadLock {
	private readonly receipts = new Map<string, TurnReceipt>();
	private readonly turnOrder = new Map<string, string[]>();
	private readonly tails = new Map<string, Promise<void>>();

	get(
		threadId: string,
		clientTurnId: string,
	): Promise<TurnReceipt | undefined> {
		return Promise.resolve(this.receipts.get(`${threadId}:${clientTurnId}`));
	}

	recover(): Promise<undefined> {
		return Promise.resolve(undefined);
	}

	put(
		threadId: string,
		clientTurnId: string,
		receipt: TurnReceipt,
	): Promise<void> {
		this.receipts.set(`${threadId}:${clientTurnId}`, receipt);
		this.turnOrder.set(threadId, [
			...(this.turnOrder.get(threadId) ?? []).filter(
				(turnId) => turnId !== clientTurnId,
			),
			clientTurnId,
		]);
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

	async runExclusive<T>(
		threadId: string,
		operation: () => Promise<T>,
	): Promise<T> {
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

export class CoordinatedTurnRunner implements TurnCoordinator {
	constructor(
		private readonly receipts: TurnReceiptStore,
		private readonly lock: ThreadLock,
	) {}

	run<T extends Record<string, unknown>>(
		request: TurnRequest,
		operation: (resumeFromCheckpoint: boolean) => Promise<T>,
	): Promise<T> {
		return this.lock.runExclusive(request.threadId, async () => {
			const existing = await this.receipts.get(
				request.threadId,
				request.clientTurnId,
			);
			if (existing) {
				if (existing.fingerprint !== request.fingerprint) {
					throw new TurnConflictError(
						"client_turn_id was reused with a different request",
					);
				}
				return existing.response as T;
			}

			const recovered = await this.receipts.recover(
				request.threadId,
				request.clientTurnId,
			);
			const recoveredFingerprint =
				recovered?.kind === "complete"
					? recovered.receipt.fingerprint
					: recovered?.fingerprint;
			if (
				recoveredFingerprint !== undefined &&
				recoveredFingerprint !== request.fingerprint
			) {
				throw new TurnConflictError(
					"client_turn_id was reused with a different request",
				);
			}
			if (recovered?.kind === "complete") {
				await this.receipts.put(
					request.threadId,
					request.clientTurnId,
					recovered.receipt,
				);
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
}

export function fingerprintTurn(payload: unknown): string {
	return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined)
		throw new Error("turn fingerprint is not JSON serializable");
	return encoded;
}

export function createInMemoryTurnCoordinator(): TurnCoordinator {
	const state = new InMemoryTurnState();
	return new CoordinatedTurnRunner(state, state);
}
