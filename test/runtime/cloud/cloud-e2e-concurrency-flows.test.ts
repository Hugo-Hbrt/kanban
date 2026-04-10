import { describe, expect, it } from "vitest";
import {
	type CallbackIngestionContext,
	type CallbackPayload,
	extractCallbackHeaders,
	ingestTerminalCallback,
} from "../../../src/cloud/cloud-callback-ingestion";
import type { CancelActor } from "../../../src/cloud/cloud-execution-cancel";
import { cancelCloudExecution } from "../../../src/cloud/cloud-execution-cancel";
import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Per-org concurrency limiter (in-memory mock)
// ---------------------------------------------------------------------------

interface ConcurrencySlot {
	readonly taskId: string;
	readonly orgId: string;
	readonly startedAt: number;
}

class MockConcurrencyLimiter {
	private readonly maxPerOrg: number;
	private readonly slots = new Map<string, ConcurrencySlot[]>();
	private readonly waitQueue: Array<{ orgId: string; taskId: string; resolve: () => void }> = [];

	constructor(maxPerOrg: number) {
		this.maxPerOrg = maxPerOrg;
	}

	acquire(orgId: string, taskId: string): boolean {
		const orgSlots = this.slots.get(orgId) ?? [];
		if (orgSlots.length >= this.maxPerOrg) return false;
		orgSlots.push({ taskId, orgId, startedAt: Date.now() });
		this.slots.set(orgId, orgSlots);
		return true;
	}

	release(orgId: string, taskId: string): void {
		const orgSlots = this.slots.get(orgId) ?? [];
		this.slots.set(
			orgId,
			orgSlots.filter((s) => s.taskId !== taskId),
		);
		// Dispatch next waiting task for this org
		const idx = this.waitQueue.findIndex((w) => w.orgId === orgId);
		if (idx !== -1) {
			const next = this.waitQueue.splice(idx, 1)[0];
			if (next && this.acquire(next.orgId, next.taskId)) {
				next.resolve();
			}
		}
	}

	enqueue(orgId: string, taskId: string): Promise<void> {
		if (this.acquire(orgId, taskId)) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.waitQueue.push({ orgId, taskId, resolve });
		});
	}

	activeCount(orgId: string): number {
		return (this.slots.get(orgId) ?? []).length;
	}

	queueLength(orgId: string): number {
		return this.waitQueue.filter((w) => w.orgId === orgId).length;
	}

	getQueueOrder(orgId: string): string[] {
		return this.waitQueue.filter((w) => w.orgId === orgId).map((w) => w.taskId);
	}
}

// ---------------------------------------------------------------------------
// Cancel context helper for concurrency tests
// ---------------------------------------------------------------------------

function createCancelCtx(initialState: CloudExecutionState) {
	const events: PersistedTaskEvent[] = [];
	return {
		async deriveTaskState() {
			if (events.length === 0) return initialState;
			return events[events.length - 1]?.toState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			events.push({ ...event });
		},
		async appendEvents(newEvents: readonly PersistedTaskEvent[]) {
			for (const e of newEvents) events.push({ ...e });
		},
		async readExecutionsForTask() {
			return [] as PersistedTaskExecution[];
		},
		async updateExecution() {
			return false;
		},
		async deleteInstance() {},
		now: () => new Date().toISOString(),
		_events: events,
	};
}

// ===========================================================================
// Per-org limit enforcement
// ===========================================================================

describe("E2E Concurrency Flows \u2014 Per-org limit enforcement", () => {
	it("enforces per-org concurrency limit", () => {
		const limiter = new MockConcurrencyLimiter(2);
		expect(limiter.acquire("org-1", "task-1")).toBe(true);
		expect(limiter.acquire("org-1", "task-2")).toBe(true);
		expect(limiter.acquire("org-1", "task-3")).toBe(false);
		expect(limiter.activeCount("org-1")).toBe(2);
	});

	it("different orgs have independent limits", () => {
		const limiter = new MockConcurrencyLimiter(1);
		expect(limiter.acquire("org-1", "task-1")).toBe(true);
		expect(limiter.acquire("org-2", "task-2")).toBe(true);
		expect(limiter.acquire("org-1", "task-3")).toBe(false);
		expect(limiter.acquire("org-2", "task-4")).toBe(false);
	});
});

// ===========================================================================
// Fair queuing FIFO ordering
// ===========================================================================

describe("E2E Concurrency Flows \u2014 Fair queuing FIFO ordering", () => {
	it("tasks are dispatched in FIFO order when slot opens", async () => {
		const limiter = new MockConcurrencyLimiter(1);
		expect(limiter.acquire("org-1", "task-1")).toBe(true);

		const dispatched: string[] = [];
		const p2 = limiter.enqueue("org-1", "task-2").then(() => dispatched.push("task-2"));
		const p3 = limiter.enqueue("org-1", "task-3").then(() => dispatched.push("task-3"));

		expect(limiter.queueLength("org-1")).toBe(2);
		expect(limiter.getQueueOrder("org-1")).toEqual(["task-2", "task-3"]);

		// Release task-1 => task-2 should dispatch first
		limiter.release("org-1", "task-1");
		await p2;
		expect(dispatched[0]).toBe("task-2");

		// Release task-2 => task-3 should dispatch
		limiter.release("org-1", "task-2");
		await p3;
		expect(dispatched[1]).toBe("task-3");
	});
});

// ===========================================================================
// Slot release on completion/cancel triggers next dispatch
// ===========================================================================

describe("E2E Concurrency Flows \u2014 Slot release triggers next dispatch", () => {
	it("completion releases slot and triggers next queued task", async () => {
		const limiter = new MockConcurrencyLimiter(1);
		limiter.acquire("org-1", "task-running");

		let nextDispatched = false;
		const pending = limiter.enqueue("org-1", "task-queued").then(() => {
			nextDispatched = true;
		});

		expect(nextDispatched).toBe(false);

		// Simulate completion releasing the slot
		limiter.release("org-1", "task-running");
		await pending;

		expect(nextDispatched).toBe(true);
		expect(limiter.activeCount("org-1")).toBe(1);
	});

	it("cancel releases slot and triggers next queued task", async () => {
		const limiter = new MockConcurrencyLimiter(1);
		limiter.acquire("org-1", "task-cancel-me");

		let nextDispatched = false;
		const pending = limiter.enqueue("org-1", "task-waiting").then(() => {
			nextDispatched = true;
		});

		// Simulate cancel releasing the slot
		limiter.release("org-1", "task-cancel-me");
		await pending;

		expect(nextDispatched).toBe(true);
	});
});

// ===========================================================================
// Concurrent cancel + callback race condition
// ===========================================================================

describe("E2E Concurrency Flows \u2014 Concurrent cancel + callback race", () => {
	it("cancel wins: subsequent callback is rejected", async () => {
		// Simulate cancel winning the race
		const cancelCtx = createCancelCtx("running");
		const actor: CancelActor = { type: "user", id: "user-race" };
		const cancelResult = await cancelCloudExecution({ taskId: "task-race", actor }, cancelCtx);
		expect(cancelResult.canceled).toBe(true);

		// Now callback arrives — task is already canceled (terminal)
		const ingestionCtx: CallbackIngestionContext = {
			async getTaskExecutionState() {
				return "canceled" as CloudExecutionState;
			},
			async hasProcessedCallback() {
				return false;
			},
			async recordProcessedCallback() {},
			signingSecret: null,
		};
		const payload: CallbackPayload = {
			instanceId: "inst-race",
			status: "success",
			task_id: "task-race",
			attempt_number: 1,
		};
		const cbResult = await ingestTerminalCallback(
			JSON.stringify(payload),
			extractCallbackHeaders({}),
			{ taskId: "task-race" },
			ingestionCtx,
		);
		expect(cbResult.accepted).toBe(false);
		if (!cbResult.accepted) expect(cbResult.duplicate).toBe(true);
	});

	it("callback wins: subsequent cancel is idempotent no-op", async () => {
		// Simulate callback processing first => task is now "completing"
		// Then user tries to cancel — task is in completing state, cancel is valid
		const cancelCtx = createCancelCtx("completed");
		const actor: CancelActor = { type: "user", id: "user-race-2" };
		const cancelResult = await cancelCloudExecution({ taskId: "task-race-2", actor }, cancelCtx);
		expect(cancelResult.canceled).toBe(false);
		if (!cancelResult.canceled) expect(cancelResult.idempotentNoOp).toBe(true);
	});

	it("double callback is deduplicated", async () => {
		const processedKeys = new Set<string>();
		const ingestionCtx: CallbackIngestionContext = {
			async getTaskExecutionState() {
				return "running" as CloudExecutionState;
			},
			async hasProcessedCallback(key) {
				return processedKeys.has(key);
			},
			async recordProcessedCallback(key) {
				processedKeys.add(key);
			},
			signingSecret: null,
		};
		const payload: CallbackPayload = {
			instanceId: "inst-dd",
			status: "success",
			task_id: "task-dd",
			attempt_number: 1,
		};
		const body = JSON.stringify(payload);
		const headers = extractCallbackHeaders({});

		const r1 = await ingestTerminalCallback(body, headers, { taskId: "task-dd" }, ingestionCtx);
		expect(r1.accepted).toBe(true);

		const r2 = await ingestTerminalCallback(body, headers, { taskId: "task-dd" }, ingestionCtx);
		expect(r2.accepted).toBe(false);
		if (!r2.accepted) expect(r2.duplicate).toBe(true);
	});
});
