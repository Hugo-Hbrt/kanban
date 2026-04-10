import { describe, expect, it } from "vitest";

import type { CancelActor, CancelExecutionContext } from "../../../src/cloud/cloud-execution-cancel";
import { cancelCloudExecution } from "../../../src/cloud/cloud-execution-cancel";
import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR: CancelActor = { type: "user", id: "user-123", name: "Test User" };

function createMockCancelContext(opts?: {
	initialState?: CloudExecutionState;
	hasExecution?: boolean;
	instanceId?: string;
	failDelete?: boolean;
}): CancelExecutionContext & {
	_events: PersistedTaskEvent[];
	_executions: PersistedTaskExecution[];
	_deleteCalls: string[];
} {
	const events: PersistedTaskEvent[] = [];
	const executions: PersistedTaskExecution[] = [];
	const deleteCalls: string[] = [];

	if (opts?.hasExecution) {
		executions.push({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: "2026-01-01T00:00:00Z",
			instanceId: opts.instanceId,
			remoteMetadata: opts.instanceId
				? {
						instanceId: opts.instanceId,
						repoUrl: "https://github.com/test/repo",
						baseBranch: "main",
					}
				: undefined,
		});
	}

	return {
		async deriveTaskState() {
			if (events.length === 0) return opts?.initialState ?? "draft";
			return events[events.length - 1]?.toState;
		},
		async appendEvent(event) {
			events.push({ ...event });
		},
		async appendEvents(newEvents) {
			for (const e of newEvents) events.push({ ...e });
		},
		async readExecutionsForTask() {
			return [...executions];
		},
		async updateExecution(executionId, updates) {
			const idx = executions.findIndex((e) => e.executionId === executionId);
			if (idx === -1) return false;
			const existing = executions[idx];
			if (existing) executions[idx] = { ...existing, ...updates };
			return true;
		},
		async deleteInstance(instanceId) {
			if (opts?.failDelete) throw new Error("Delete failed");
			deleteCalls.push(instanceId);
		},
		now: () => "2026-01-01T12:00:00Z",
		_events: events,
		_executions: executions,
		_deleteCalls: deleteCalls,
	};
}

// ===========================================================================
// Tests: Cancel from each pre-terminal state
// ===========================================================================

describe("cancelCloudExecution — cancel from each pre-terminal state", () => {
	const preTerminalStates: CloudExecutionState[] = ["queued", "policy_check", "provisioning", "running", "completing"];

	for (const state of preTerminalStates) {
		it(`cancels from ${state} -> canceled`, async () => {
			const ctx = createMockCancelContext({ initialState: state });
			const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
			expect(result.canceled).toBe(true);
			if (result.canceled) {
				expect(result.previousState).toBe(state);
				expect(result.teardownTriggered).toBe(true);
				expect(result.eventsAppended).toBe(2); // cancel + auto_teardown
			}
		});
	}
});

// ===========================================================================
// Tests: Event persistence
// ===========================================================================

describe("cancelCloudExecution — event persistence", () => {
	it("persists cancel event with trigger=user_cancel and user metadata", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR, reason: "no longer needed" }, ctx);

		const cancelEvent = ctx._events.find((e) => e.trigger === "user_cancel");
		expect(cancelEvent).toBeDefined();
		expect(cancelEvent?.triggerSource).toBe("user");
		expect(cancelEvent?.fromState).toBe("running");
		expect(cancelEvent?.toState).toBe("canceled");
		expect(cancelEvent?.metadata).toMatchObject({
			cancelActor: TEST_ACTOR,
			cancelReason: "no longer needed",
			cancelledFromState: "running",
		});
	});

	it("persists auto_teardown event after cancel event", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);

		expect(ctx._events).toHaveLength(2);
		expect(ctx._events[0]?.trigger).toBe("user_cancel");
		expect(ctx._events[1]?.trigger).toBe("auto_teardown");
		expect(ctx._events[1]?.fromState).toBe("canceled");
		expect(ctx._events[1]?.toState).toBe("teardown");
		expect(ctx._events[1]?.triggerSource).toBe("system");
	});

	it("uses idempotencyKey as eventId when provided", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR, idempotencyKey: "idem-key-1" }, ctx);
		expect(ctx._events[0]?.eventId).toBe("idem-key-1");
	});
});

// ===========================================================================
// Tests: Instance deletion on cancel
// ===========================================================================

describe("cancelCloudExecution — instance deletion", () => {
	it("triggers DELETE when instance exists", async () => {
		const ctx = createMockCancelContext({
			initialState: "running",
			hasExecution: true,
			instanceId: "inst-abc",
		});
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(true);
		if (result.canceled) expect(result.instanceDeletionTriggered).toBe(true);
		expect(ctx._deleteCalls).toEqual(["inst-abc"]);
	});

	it("does not trigger deletion when no instance exists", async () => {
		const ctx = createMockCancelContext({ initialState: "queued", hasExecution: true });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(true);
		if (result.canceled) expect(result.instanceDeletionTriggered).toBe(false);
		expect(ctx._deleteCalls).toHaveLength(0);
	});

	it("cancel succeeds even if instance deletion fails", async () => {
		const ctx = createMockCancelContext({
			initialState: "running",
			hasExecution: true,
			instanceId: "inst-abc",
			failDelete: true,
		});
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(true);
		if (result.canceled) expect(result.instanceDeletionTriggered).toBe(true);
		expect(ctx._events).toHaveLength(2); // events still persisted
	});
});

// ===========================================================================
// Tests: Idempotency
// ===========================================================================

describe("cancelCloudExecution — idempotency", () => {
	it("returns no-op for already-canceled task", async () => {
		const ctx = createMockCancelContext({ initialState: "canceled" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) {
			expect(result.idempotentNoOp).toBe(true);
			expect(result.reason).toContain("already canceled");
		}
		expect(ctx._events).toHaveLength(0);
	});

	it("returns no-op for completed task", async () => {
		const ctx = createMockCancelContext({ initialState: "completed" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) expect(result.idempotentNoOp).toBe(true);
	});

	it("returns no-op for failed task", async () => {
		const ctx = createMockCancelContext({ initialState: "failed" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) expect(result.idempotentNoOp).toBe(true);
	});

	it("returns no-op for teardown task", async () => {
		const ctx = createMockCancelContext({ initialState: "teardown" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) expect(result.idempotentNoOp).toBe(true);
	});

	it("returns no-op for archived task", async () => {
		const ctx = createMockCancelContext({ initialState: "archived" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) expect(result.idempotentNoOp).toBe(true);
	});

	it("returns non-idempotent rejection for draft", async () => {
		const ctx = createMockCancelContext({ initialState: "draft" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) {
			expect(result.idempotentNoOp).toBe(false);
			expect(result.reason).toContain("does not support cancellation");
		}
	});
});

// ===========================================================================
// Tests: Execution record updates
// ===========================================================================

describe("cancelCloudExecution — execution record", () => {
	it("updates execution with terminalState=canceled", async () => {
		const ctx = createMockCancelContext({
			initialState: "running",
			hasExecution: true,
			instanceId: "inst-1",
		});
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR, reason: "test reason" }, ctx);
		const exec = ctx._executions[0];
		expect(exec?.terminalState).toBe("canceled");
		expect(exec?.completedAt).toBe("2026-01-01T12:00:00Z");
		expect(exec?.resultSummary).toContain("canceled");
		expect(exec?.resultSummary).toContain("user:user-123");
		expect(exec?.resultSummary).toContain("test reason");
	});

	it("records different actor types", async () => {
		const apiActor: CancelActor = { type: "api_caller", id: "api-key-456" };
		const ctx = createMockCancelContext({ initialState: "running", hasExecution: true });
		await cancelCloudExecution({ taskId: "task-1", actor: apiActor }, ctx);
		const exec = ctx._executions[0];
		expect(exec?.resultSummary).toContain("api_caller:api-key-456");
	});
});

// ===========================================================================
// Tests: Race conditions
// ===========================================================================

describe("cancelCloudExecution — race conditions", () => {
	it("double cancel is idempotent", async () => {
		const ctx = createMockCancelContext({ initialState: "provisioning" });
		const first = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(first.canceled).toBe(true);
		const eventsAfterFirst = ctx._events.length;

		const second = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(second.canceled).toBe(false);
		if (!second.canceled) expect(second.idempotentNoOp).toBe(true);
		expect(ctx._events.length).toBe(eventsAfterFirst);
	});

	it("cancel after cancel: state is teardown, second cancel is no-op", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		// After cancel + auto_teardown, state is "teardown"
		const state = ctx._events[ctx._events.length - 1]?.toState;
		expect(state).toBe("teardown");

		const second = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(second.canceled).toBe(false);
		if (!second.canceled) expect(second.idempotentNoOp).toBe(true);
	});
});
