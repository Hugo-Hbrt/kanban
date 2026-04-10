import { describe, expect, it } from "vitest";

import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import type { CloudInstanceState, CloudInstanceStatusResponse } from "../../../src/cloud/cloud-instance-client";
import {
	DEFAULT_RECONCILER_CONFIG,
	type ReconcilerCloudClient,
	type ReconcilerConfig,
	type ReconcilerStoreInterface,
	type ReconcilerTimers,
	StuckTaskReconciler,
} from "../../../src/cloud/cloud-stuck-task-reconciler";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeEvent(
	taskId: string,
	fromState: CloudExecutionState,
	trigger: string,
	toState: CloudExecutionState,
	baseMs: number,
): PersistedTaskEvent {
	return {
		eventId: `evt-${taskId}-${toState}-${baseMs}`,
		taskId,
		trigger: trigger as PersistedTaskEvent["trigger"],
		fromState,
		toState,
		timestamp: new Date(baseMs).toISOString(),
		triggerSource: "system",
	};
}

function buildEventsToState(taskId: string, targetState: CloudExecutionState, baseMs: number): PersistedTaskEvent[] {
	const chain: Array<[CloudExecutionState, string, CloudExecutionState, number]> = [
		["draft", "submit", "queued", baseMs],
		["queued", "dequeue", "policy_check", baseMs + 1000],
		["policy_check", "authorized", "provisioning", baseMs + 2000],
		["provisioning", "sandbox_ready", "running", baseMs + 3000],
		["running", "execution_done", "completing", baseMs + 4000],
	];
	const events: PersistedTaskEvent[] = [];
	for (const [from, trigger, to, ms] of chain) {
		events.push(makeEvent(taskId, from, trigger, to, ms));
		if (to === targetState) break;
	}
	return events;
}

function makeExecution(taskId: string, overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: `exec-${taskId}`,
		taskId,
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		instanceId: `inst-${taskId}`,
		remoteMetadata: {
			instanceId: `inst-${taskId}`,
			repoUrl: "https://github.com/test/repo",
			baseBranch: "main",
		},
		...overrides,
	};
}

function createMockStore(
	events: PersistedTaskEvent[] = [],
	executions: PersistedTaskExecution[] = [],
): ReconcilerStoreInterface & { _events: PersistedTaskEvent[]; _executions: PersistedTaskExecution[] } {
	const _events = [...events];
	const _executions = [...executions];
	return {
		_events,
		_executions,
		async readEvents() {
			return [..._events];
		},
		async readEventsForTask(taskId: string) {
			return _events.filter((e) => e.taskId === taskId);
		},
		async deriveTaskState(taskId: string) {
			const taskEvents = _events.filter((e) => e.taskId === taskId);
			if (taskEvents.length === 0) return "draft";
			return taskEvents[taskEvents.length - 1]?.toState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			_events.push({ ...event });
		},
		async readExecutions() {
			return [..._executions];
		},
		async readExecutionsForTask(taskId: string) {
			return _executions.filter((e) => e.taskId === taskId);
		},
		async updateExecution(executionId: string, updates: Partial<PersistedTaskExecution>) {
			const idx = _executions.findIndex((e) => e.executionId === executionId);
			if (idx === -1) return false;
			_executions[idx] = { ..._executions[idx]!, ...updates } as PersistedTaskExecution;
			return true;
		},
	};
}

function createMockClient(opts: { instanceState?: CloudInstanceState; failGet?: boolean } = {}): ReconcilerCloudClient {
	return {
		async getInstance(instanceId: string): Promise<CloudInstanceStatusResponse> {
			if (opts.failGet) throw new Error("unreachable");
			return {
				instance_id: instanceId,
				user_id: "u",
				namespace: "ns",
				state: opts.instanceState ?? "executing",
				hostname: `${instanceId}.test`,
			};
		},
		async deleteInstance() {},
	};
}

function createFakeTimers(startMs = 1_000_000): ReconcilerTimers & { advance(ms: number): void; currentMs: number } {
	let currentMs = startMs;
	return {
		get currentMs() {
			return currentMs;
		},
		now() {
			return currentMs;
		},
		async delay() {},
		advance(ms: number) {
			currentMs += ms;
		},
	};
}

const FAST_CONFIG: ReconcilerConfig = {
	...DEFAULT_RECONCILER_CONFIG,
	scanIntervalMs: 10,
	staleThresholdMs: 90_000,
	provisionTimeoutMs: 180_000,
	teardownTimeoutMs: 120_000,
	completingTimeoutMs: 120_000,
	executionHardTimeoutMs: 7_200_000,
	maxReconnectAttempts: 3,
	heartbeatIntervalMs: 15_000,
};

// ===========================================================================
// Stale running detection and recovery
// ===========================================================================

describe("E2E Reconciler Flows \u2014 Stale running detection", () => {
	it("marks running task as stale when lease expires and no heartbeat", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ instanceState: "executing" });
		const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
		timers.advance(100_000);
		const result = await r.scan();
		expect(result.actions.find((a) => a.action === "marked_stale")).toBeDefined();
	});

	it("extends lease when instance is still executing after stale mark", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ instanceState: "executing" });
		const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
		timers.advance(100_000);
		const result = await r.scan();
		expect(result.actions.find((a) => a.action === "lease_extended")).toBeDefined();
	});

	it("fails running task when instance is terminated", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ instanceState: "terminated" });
		const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
		timers.advance(100_000);
		const result = await r.scan();
		expect(result.actions.find((a) => a.action === "failed_timeout")).toBeDefined();
		const failEvent = store._events.find((e) => e.toState === "failed");
		expect(failEvent).toBeDefined();
		expect(failEvent?.triggerSource).toBe("system");
	});
});

// ===========================================================================
// Stuck provisioning timeout
// ===========================================================================

describe("E2E Reconciler Flows \u2014 Stuck provisioning timeout", () => {
	it("fails provisioning task when timeout exceeded", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "provisioning", baseTime);
		const store = createMockStore(events, [makeExecution("task-1")]);
		const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
		timers.advance(200_000);
		const result = await r.scan();
		expect(result.actions.find((a) => a.action === "failed_provision_timeout")).toBeDefined();
	});

	it("does not fail provisioning before timeout", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "provisioning", baseTime);
		const store = createMockStore(events, [makeExecution("task-1")]);
		const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
		timers.advance(60_000);
		const result = await r.scan();
		expect(result.actions.filter((a) => a.action === "failed_provision_timeout")).toHaveLength(0);
	});
});

// ===========================================================================
// Orphaned instance detection
// ===========================================================================

describe("E2E Reconciler Flows \u2014 Orphaned instance detection", () => {
	it("flags instances not associated with any Kanban task", () => {
		const timers = createFakeTimers();
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG, undefined, timers);
		r.registerTask("task-1", "exec-1", "inst-1");
		const actions = r.detectOrphans(["inst-1", "inst-orphan-1", "inst-orphan-2"]);
		expect(actions).toHaveLength(2);
		expect(actions.every((a) => a.action === "orphan_flagged")).toBe(true);
		expect(r.getOrphanedInstances().size).toBe(2);
	});

	it("does not flag expected instances", () => {
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG);
		r.registerTask("task-1", "exec-1", "inst-1");
		expect(r.detectOrphans(["inst-1"])).toHaveLength(0);
	});
});

// ===========================================================================
// Kanban restart recovery
// ===========================================================================

describe("E2E Reconciler Flows \u2014 Kanban restart recovery", () => {
	it("resumes monitoring for still-running instances", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ instanceState: "executing" });
		const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
		const result = await r.recoverOnStartup();
		expect(result.actions.find((a) => a.action === "resumed_monitoring")).toBeDefined();
		expect(r.getLease("task-1")).toBeDefined();
	});

	it("fails tasks when instance is terminated on restart", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ instanceState: "terminated" });
		const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
		const result = await r.recoverOnStartup();
		expect(result.actions.find((a) => a.action === "failed_timeout")).toBeDefined();
	});

	it("fails tasks when instance is unreachable on restart", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ failGet: true });
		const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
		const result = await r.recoverOnStartup();
		expect(result.actions.find((a) => a.action === "failed_timeout")).toBeDefined();
	});

	it("skips archived tasks", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		events.push(makeEvent("task-1", "running", "execution_error", "failed", baseTime + 5000));
		events.push(makeEvent("task-1", "failed", "auto_teardown", "teardown", baseTime + 6000));
		events.push(makeEvent("task-1", "teardown", "sandbox_terminated", "archived", baseTime + 7000));
		const store = createMockStore(events, [makeExecution("task-1")]);
		const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
		const result = await r.recoverOnStartup();
		expect(result.actions).toHaveLength(0);
	});
});

// ===========================================================================
// Lease expiry handling
// ===========================================================================

describe("E2E Reconciler Flows \u2014 Lease expiry handling", () => {
	it("registerTask creates a lease with expiry", () => {
		const timers = createFakeTimers(1_000_000);
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG, undefined, timers);
		r.registerTask("task-1", "exec-1", "inst-1");
		const lease = r.getLease("task-1");
		expect(lease).toBeDefined();
		expect(lease?.expiresAt).toBe(1_000_000 + 90_000);
		expect(lease?.markedStale).toBe(false);
	});

	it("renewLease resets stale marker and reconnect attempts", () => {
		const timers = createFakeTimers(1_000_000);
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG, undefined, timers);
		r.registerTask("task-1", "exec-1", "inst-1");
		const lease = r.getLease("task-1")!;
		lease.markedStale = true;
		lease.reconnectAttempts = 2;
		timers.advance(50_000);
		r.renewLease("task-1", "exec-1", "inst-1");
		const renewed = r.getLease("task-1")!;
		expect(renewed.markedStale).toBe(false);
		expect(renewed.reconnectAttempts).toBe(0);
		expect(renewed.expiresAt).toBe(1_050_000 + 90_000);
	});

	it("removeLease cleans up", () => {
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG);
		r.registerTask("task-1", "exec-1", "inst-1");
		expect(r.getLease("task-1")).toBeDefined();
		r.removeLease("task-1");
		expect(r.getLease("task-1")).toBeUndefined();
	});

	it("scan cleans up leases for archived tasks", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		events.push(makeEvent("task-1", "running", "execution_error", "failed", baseTime + 5000));
		events.push(makeEvent("task-1", "failed", "auto_teardown", "teardown", baseTime + 6000));
		events.push(makeEvent("task-1", "teardown", "sandbox_terminated", "archived", baseTime + 7000));
		const store = createMockStore(events, [makeExecution("task-1")]);
		const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
		r.registerTask("task-1", "exec-1", "inst-1");
		expect(r.getLease("task-1")).toBeDefined();
		await r.scan();
		expect(r.getLease("task-1")).toBeUndefined();
	});

	it("fails unreachable task after max reconnect attempts", async () => {
		const baseTime = 1_000_000;
		const timers = createFakeTimers(baseTime);
		const events = buildEventsToState("task-1", "running", baseTime);
		const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
		const store = createMockStore(events, [exec]);
		const client = createMockClient({ failGet: true });
		const config = { ...FAST_CONFIG, maxReconnectAttempts: 2 };
		const r = new StuckTaskReconciler(store, client, config, undefined, timers);
		timers.advance(100_000);
		await r.scan();
		timers.advance(100_000);
		await r.scan();
		timers.advance(100_000);
		const result = await r.scan();
		expect(result.actions.find((a) => a.action === "failed_unreachable")).toBeDefined();
	});
});
