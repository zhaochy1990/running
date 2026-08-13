import assert from "node:assert/strict";
import test from "node:test";
import {
	CoordinatedTurnRunner,
	type ThreadLock,
	TurnConflictError,
	type TurnReceipt,
	type TurnReceiptStore,
} from "./turns.js";

class MemoryReceipts implements TurnReceiptStore {
	readonly values = new Map<string, TurnReceipt>();
	get(threadId: string, turnId: string) {
		return Promise.resolve(this.values.get(`${threadId}:${turnId}`));
	}
	put(threadId: string, turnId: string, receipt: TurnReceipt) {
		this.values.set(`${threadId}:${turnId}`, receipt);
		return Promise.resolve();
	}
	prune() {
		return Promise.resolve();
	}
}

class MemoryThreadLock implements ThreadLock {
	private readonly tails = new Map<string, Promise<void>>();

	async runExclusive<T>(
		threadId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = this.tails.get(threadId) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.tails.set(
			threadId,
			previous.then(() => current),
		);
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

test("same turn and fingerprint replays without invoking again", async () => {
	const runner = new CoordinatedTurnRunner(
		new MemoryReceipts(),
		new MemoryThreadLock(),
	);
	let calls = 0;
	const request = {
		threadId: "thread",
		clientTurnId: "turn",
		fingerprint: "a",
	};
	const operation = async () => ({ answer: ++calls });
	assert.deepEqual(await runner.run(request, operation), { answer: 1 });
	assert.deepEqual(await runner.run(request, operation), { answer: 1 });
	assert.equal(calls, 1);
});

test("same turn with another fingerprint conflicts", async () => {
	const runner = new CoordinatedTurnRunner(
		new MemoryReceipts(),
		new MemoryThreadLock(),
	);
	await runner.run(
		{ threadId: "thread", clientTurnId: "turn", fingerprint: "a" },
		async () => ({ answer: 1 }),
	);
	await assert.rejects(
		runner.run(
			{ threadId: "thread", clientTurnId: "turn", fingerprint: "b" },
			async () => ({ answer: 2 }),
		),
		TurnConflictError,
	);
});

test("concurrent turns on one thread run serially", async () => {
	const runner = new CoordinatedTurnRunner(
		new MemoryReceipts(),
		new MemoryThreadLock(),
	);
	let active = 0;
	let maxActive = 0;
	const invoke = (turn: string) =>
		runner.run(
			{ threadId: "thread", clientTurnId: turn, fingerprint: turn },
			async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return { turn };
			},
		);
	await Promise.all([invoke("one"), invoke("two")]);
	assert.equal(maxActive, 1);
});
