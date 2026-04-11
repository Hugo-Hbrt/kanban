import { describe, expect, it } from "vitest";
import {
	type CallbackIngestionContext,
	type CallbackPayload,
	extractCallbackHeaders,
	ingestTerminalCallback,
} from "../../../src/cloud/cloud-callback-ingestion";
import type { CancelActor, CancelExecutionContext } from "../../../src/cloud/cloud-execution-cancel";
import { cancelCloudExecution } from "../../../src/cloud/cloud-execution-cancel";
import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import { CLOUD_EXECUTION_TRANSITIONS } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR: CancelActor = { type: "user", id: "user-cancel-e2e", name: "E2E Cancel User" };
const API_ACTOR: CancelActor = { type: "api_caller", id: "api-key-e2e" };
const SYSTEM_ACTOR: CancelActor = { type: "system", id: "reconciler" };

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
			executionId: "exec-e2e-1",
			taskId: "task-e2e-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: "2026-01-01T00:00:00Z",
			instanceId: opts.instanceId,
			remoteMetadata: opts.instanceId
				? { instanceId: opts.instanceId, repoUrl: "https://github.com/test/repo", baseBranch: "main" }
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

function createCallbackIngestionContext(opts: {
	currentState: CloudExecutionState | null;
	processedKeys?: Set<string>;
}): CallbackIngestionContext & { _processedKeys: Set<string> } {
	const processedKeys = opts.processedKeys ?? new Set<string>();
	return {
		async getTaskExecutionState() {
			return opts.currentState;
		},
		async hasProcessedCallback(key) {
			return processedKeys.has(key);
		},
		async recordProcessedCallback(key) {
			processedKeys.add(key);
		},
		signingSecret: null,
		_processedKeys: processedKeys,
	};
}

// ===========================================================================
// E2E Cancel Flow Tests — Cancel from each pre-terminal state
// ===========================================================================

describe("E2E Cancel Flows — Cancel from each pre-terminal state", () => {
	const preTerminalStates: CloudExecutionState[] = ["queued", "policy_check", "provisioning", "running", "completing"];

	for (const state of preTerminalStates) {
		it(`cancel from ${state}: transitions to canceled then teardown`, async () => {
			const hasSandbox = state === "provisioning" || state === "running" || state === "completing";
			const ctx = createMockCancelContext({
				initialState: state,
				hasExecution: true,
				instanceId: hasSandbox ? "inst-e2e" : undefined,
			});
			const result = await cancelCloudExecution({ taskId: "task-e2e-1", actor: TEST_ACTOR }, ctx);
			expect(result.canceled).toBe(true);
			if (result.canceled) {
				expect(result.previousState).toBe(state);
				expect(result.teardownTriggered).toBe(true);
				expect(result.eventsAppended).toBe(2);
			}
			expect(ctx._events).toHaveLength(2);
			expect(ctx._events[0]?.fromState).toBe(state);
			expect(ctx._events[0]?.toState).toBe("canceled");
			expect(ctx._events[1]?.fromState).toBe("canceled");
			expect(ctx._events[1]?.toState).toBe("teardown");
		});

		it(`cancel from ${state}: execution record updated with terminal state`, async () => {
			const ctx = createMockCancelContext({ initialState: state, hasExecution: true, instanceId: "inst-e2e" });
			await cancelCloudExecution({ taskId: "task-e2e-1", actor: TEST_ACTOR, reason: "e2e" }, ctx);
			const exec = ctx._executions[0];
			expect(exec?.terminalState).toBe("canceled");
			expect(exec?.completedAt).toBe("2026-01-01T12:00:00Z");
		});
	}

	it("cancel transitions match the lifecycle transition table", () => {
		const cancelTransitions = CLOUD_EXECUTION_TRANSITIONS.filter((t) => t.trigger === "user_cancel");
		for (const state of ["queued", "policy_check", "provisioning", "running", "completing"] as const) {
			const t = cancelTransitions.find((ct) => ct.from === state);
			expect(t, `Missing cancel transition from ${state}`).toBeDefined();
			expect(t?.to).toBe("canceled");
		}
	});
});

// ===========================================================================
// E2E Cancel Flows — Late callback after cancel is rejected
// ===========================================================================

describe("E2E Cancel Flows — Late callback after cancel is rejected", () => {
	it("callback arriving after cancel is rejected as duplicate/terminal", async () => {
		const cancelCtx = createMockCancelContext({
			initialState: "running",
			hasExecution: true,
			instanceId: "inst-late",
		});
		const cancelResult = await cancelCloudExecution({ taskId: "task-late-1", actor: TEST_ACTOR }, cancelCtx);
		expect(cancelResult.canceled).toBe(true);

		const payload: CallbackPayload = {
			instanceId: "inst-late",
			status: "success",
			taskId: "task-late-1",
			attemptNumber: 1,
		};
		const ingestionCtx = createCallbackIngestionContext({ currentState: "canceled" });
		const result = await ingestTerminalCallback(
			JSON.stringify(payload),
			extractCallbackHeaders({}),
			{ taskId: "task-late-1" },
			ingestionCtx,
		);
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.duplicate).toBe(true);
	});

	it("success callback on already-failed task is rejected", async () => {
		const ingestionCtx = createCallbackIngestionContext({ currentState: "failed" });
		const payload: CallbackPayload = {
			instanceId: "inst-f",
			status: "success",
			taskId: "task-f-1",
			attemptNumber: 1,
		};
		const result = await ingestTerminalCallback(
			JSON.stringify(payload),
			extractCallbackHeaders({}),
			{ taskId: "task-f-1" },
			ingestionCtx,
		);
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.duplicate).toBe(true);
	});
});

// ===========================================================================
// E2E Cancel Flows — Cancel is idempotent
// ===========================================================================

describe("E2E Cancel Flows — Cancel is idempotent", () => {
	it("first cancel succeeds, second cancel is no-op", async () => {
		const ctx = createMockCancelContext({ initialState: "running", hasExecution: true, instanceId: "inst-idem" });
		const first = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(first.canceled).toBe(true);
		const eventsAfterFirst = ctx._events.length;
		const second = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(second.canceled).toBe(false);
		if (!second.canceled) expect(second.idempotentNoOp).toBe(true);
		expect(ctx._events.length).toBe(eventsAfterFirst);
	});

	it("cancel from different actor types is idempotent after first cancel", async () => {
		const ctx = createMockCancelContext({ initialState: "provisioning" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		const result = await cancelCloudExecution({ taskId: "task-1", actor: API_ACTOR }, ctx);
		expect(result.canceled).toBe(false);
		if (!result.canceled) expect(result.idempotentNoOp).toBe(true);
	});

	for (const state of ["completed", "failed", "archived", "teardown"] as CloudExecutionState[]) {
		it(`cancel on ${state} task is idempotent no-op`, async () => {
			const ctx = createMockCancelContext({ initialState: state });
			const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
			expect(result.canceled).toBe(false);
			if (!result.canceled) expect(result.idempotentNoOp).toBe(true);
		});
	}

	it("triple cancel: only first writes events", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		const eventCount = ctx._events.length;
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		await cancelCloudExecution({ taskId: "task-1", actor: SYSTEM_ACTOR }, ctx);
		expect(ctx._events.length).toBe(eventCount);
	});
});

// ===========================================================================
// E2E Cancel Flows — Instance teardown triggers on cancel
// ===========================================================================

describe("E2E Cancel Flows — Instance teardown triggers on cancel", () => {
	it("DELETE is called for running instance on cancel", async () => {
		const ctx = createMockCancelContext({ initialState: "running", hasExecution: true, instanceId: "inst-del-1" });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(true);
		if (result.canceled) expect(result.instanceDeletionTriggered).toBe(true);
		expect(ctx._deleteCalls).toEqual(["inst-del-1"]);
	});

	it("no DELETE for queued task (no sandbox)", async () => {
		const ctx = createMockCancelContext({ initialState: "queued", hasExecution: true });
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(true);
		if (result.canceled) expect(result.instanceDeletionTriggered).toBe(false);
		expect(ctx._deleteCalls).toHaveLength(0);
	});

	it("cancel succeeds even if DELETE fails (best-effort)", async () => {
		const ctx = createMockCancelContext({
			initialState: "running",
			hasExecution: true,
			instanceId: "inst-fail",
			failDelete: true,
		});
		const result = await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		expect(result.canceled).toBe(true);
		expect(ctx._events).toHaveLength(2);
	});

	it("auto_teardown event has system triggerSource", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR }, ctx);
		const teardownEvent = ctx._events.find((e) => e.trigger === "auto_teardown");
		expect(teardownEvent?.triggerSource).toBe("system");
		expect(teardownEvent?.fromState).toBe("canceled");
		expect(teardownEvent?.toState).toBe("teardown");
	});

	it("cancel event metadata records actor, reason, and source state", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR, reason: "e2e test" }, ctx);
		const cancelEvent = ctx._events.find((e) => e.trigger === "user_cancel");
		expect(cancelEvent?.metadata).toMatchObject({
			cancelActor: TEST_ACTOR,
			cancelReason: "e2e test",
			cancelledFromState: "running",
		});
	});

	it("idempotencyKey is used as eventId", async () => {
		const ctx = createMockCancelContext({ initialState: "running" });
		await cancelCloudExecution({ taskId: "task-1", actor: TEST_ACTOR, idempotencyKey: "idem-e2e-001" }, ctx);
		expect(ctx._events[0]?.eventId).toBe("idem-e2e-001");
	});
});
