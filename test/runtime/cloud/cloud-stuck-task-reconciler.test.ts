import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
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
// Mock Helpers
// ---------------------------------------------------------------------------

function makeEvent(
	taskId: string,
	from: CloudExecutionState,
	trigger: CloudExecutionTrigger,
	to: CloudExecutionState,
	timestampMs?: number,
): PersistedTaskEvent {
	return {
		eventId: randomUUID(),
		taskId,
		trigger,
		fromState: from,
		toState: to,
		timestamp: new Date(timestampMs ?? Date.now()).toISOString(),
		triggerSource: "system",
	};
}

function buildEventsToState(taskId: string, target: CloudExecutionState, baseTime = 1_000_000): PersistedTaskEvent[] {
	const chain: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
		["running", "execution_done", "completing"],
	];
	const events: PersistedTaskEvent[] = [];
	let t = baseTime;
	for (const [from, trigger, to] of chain) {
		if (target === from) break;
		events.push(makeEvent(taskId, from, trigger, to, t));
		t += 1000;
		if (target === to) break;
	}
	return events;
}

function makeExecution(taskId: string, overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: overrides.executionId ?? randomUUID(),
		taskId,
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: "2026-04-09T10:00:00Z",
		instanceId: "inst-1",
		remoteMetadata: {
			instanceId: "inst-1",
			repoUrl: "https://github.com/org/repo",
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
			if (taskEvents.length === 0) return "draft" as CloudExecutionState;
			return taskEvents[taskEvents.length - 1]!.toState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			if (_events.some((e) => e.eventId === event.eventId)) throw new Error(`Duplicate: ${event.eventId}`);
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
			const existing = _executions[idx]!;
			_executions[idx] = { ...existing, ...updates } as PersistedTaskExecution;
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
				user_id: "test-user",
				namespace: "test-ns",
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
// Tests
// ===========================================================================

describe("DEFAULT_RECONCILER_CONFIG", () => {
	it("has PRD Section 8 default thresholds", () => {
		expect(DEFAULT_RECONCILER_CONFIG.staleThresholdMs).toBe(90_000);
		expect(DEFAULT_RECONCILER_CONFIG.provisionTimeoutMs).toBe(180_000);
		expect(DEFAULT_RECONCILER_CONFIG.executionHardTimeoutMs).toBe(7_200_000);
		expect(DEFAULT_RECONCILER_CONFIG.heartbeatIntervalMs).toBe(15_000);
		expect(DEFAULT_RECONCILER_CONFIG.teardownTimeoutMs).toBe(120_000);
	});
});

describe("StuckTaskReconciler — Lease Management", () => {
	it("registerTask creates a lease with expiry", () => {
		const timers = createFakeTimers(1_000_000);
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG, undefined, timers);
		r.registerTask("task-1", "exec-1", "inst-1");
		const lease = r.getLease("task-1");
		expect(lease).toBeDefined();
		expect(lease!.expiresAt).toBe(1_000_000 + 90_000);
		expect(lease!.markedStale).toBe(false);
		expect(lease!.reconnectAttempts).toBe(0);
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
});

describe("StuckTaskReconciler — start/stop", () => {
	it("start and stop toggle isRunning", () => {
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG);
		expect(r.isRunning).toBe(false);
		r.start();
		expect(r.isRunning).toBe(true);
		r.stop();
		expect(r.isRunning).toBe(false);
	});

	it("double start is idempotent", () => {
		const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG);
		r.start();
		r.start();
		expect(r.isRunning).toBe(true);
		r.stop();
	});

	describe("StuckTaskReconciler — Stale running detection", () => {
		it("marks a running task as stale when lease expired and no heartbeat", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const client = createMockClient({ instanceState: "executing" });
			const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);

			// Advance past stale threshold
			timers.advance(100_000);
			const result = await r.scan();
			const staleAction = result.actions.find((a) => a.action === "marked_stale");
			expect(staleAction).toBeDefined();
			expect(staleAction!.taskId).toBe("task-1");
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
			const leaseExtended = result.actions.find((a) => a.action === "lease_extended");
			expect(leaseExtended).toBeDefined();
			expect(leaseExtended!.reason).toContain("still active");
		});

		it("fails task when instance is terminated after stale mark", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const client = createMockClient({ instanceState: "terminated" });
			const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);

			timers.advance(100_000);
			const result = await r.scan();
			const failAction = result.actions.find((a) => a.action === "failed_timeout");
			expect(failAction).toBeDefined();
			expect(failAction!.newState).toBe("failed");
			// Verify event was persisted
			expect(store._events.length).toBeGreaterThan(events.length);
			const lastEvent = store._events[store._events.length - 1]!;
			expect(lastEvent.triggerSource).toBe("system");
			expect(lastEvent.toState).toBe("failed");
		});

		it("fails task as unreachable after max reconnect attempts", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const client = createMockClient({ failGet: true });
			const config = { ...FAST_CONFIG, maxReconnectAttempts: 2 };
			const r = new StuckTaskReconciler(store, client, config, undefined, timers);

			// First scan — marks stale, attempt fails (attempt 1)
			timers.advance(100_000);
			await r.scan();
			// Second scan — another attempt (attempt 2)
			timers.advance(100_000);
			await r.scan();
			// Third scan — max attempts reached
			timers.advance(100_000);
			const result = await r.scan();
			const failAction = result.actions.find((a) => a.action === "failed_unreachable");
			expect(failAction).toBeDefined();
			expect(failAction!.newState).toBe("failed");
		});

		it("does not act on tasks with active leases", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);

			// Register task with a fresh lease
			r.registerTask("task-1", exec.executionId, "inst-1");
			// Advance but not past stale threshold
			timers.advance(50_000);
			const result = await r.scan();
			expect(result.actions).toHaveLength(0);
		});
	});

	describe("StuckTaskReconciler — Execution hard timeout", () => {
		it("fails a running task when execution hard timeout exceeded", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);

			timers.advance(7_204_000); // Past 2h even accounting for startedAt offset
			const result = await r.scan();
			const action = result.actions.find((a) => a.action === "failed_execution_timeout");
			expect(action).toBeDefined();
			expect(action!.newState).toBe("failed");
		});
	});

	describe("StuckTaskReconciler — Stuck provisioning", () => {
		it("fails a provisioning task when provision timeout exceeded", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "provisioning", baseTime);
			const exec = makeExecution("task-1");
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);

			timers.advance(200_000); // Past 3 min
			const result = await r.scan();
			const action = result.actions.find((a) => a.action === "failed_provision_timeout");
			expect(action).toBeDefined();
			expect(action!.newState).toBe("failed");
			expect(store._events.length).toBeGreaterThan(events.length);
		});

		it("does not fail provisioning before timeout", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "provisioning", baseTime);
			const store = createMockStore(events, [makeExecution("task-1")]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);

			timers.advance(60_000); // 1 min — within timeout
			const result = await r.scan();
			expect(result.actions.filter((a) => a.action === "failed_provision_timeout")).toHaveLength(0);
		});
	});

	describe("StuckTaskReconciler — Stuck completing", () => {
		it("fails a completing task when finalization timeout exceeded", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "completing", baseTime);
			const exec = makeExecution("task-1");
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);

			timers.advance(130_000); // Past 2 min
			const result = await r.scan();
			const action = result.actions.find((a) => a.action === "failed_completing_timeout");
			expect(action).toBeDefined();
			expect(action!.newState).toBe("failed");
		});
	});

	describe("StuckTaskReconciler — Stuck teardown", () => {
		it("forces teardown to archived when teardown timeout exceeded", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			// Build events to "failed" then add auto_teardown
			const events = buildEventsToState("task-1", "running", baseTime);
			events.push(makeEvent("task-1", "running", "execution_error", "failed", baseTime + 5000));
			events.push(makeEvent("task-1", "failed", "auto_teardown", "teardown", baseTime + 6000));
			const exec = makeExecution("task-1");
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);

			timers.advance(130_000); // Past 2 min
			const result = await r.scan();
			const action = result.actions.find((a) => a.action === "failed_teardown_timeout");
			expect(action).toBeDefined();
			expect(action!.newState).toBe("archived");
		});
	});

	describe("StuckTaskReconciler — Orphaned instance detection", () => {
		it("flags instances not associated with any Kanban task", () => {
			const timers = createFakeTimers(1_000_000);
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
			const actions = r.detectOrphans(["inst-1"]);
			expect(actions).toHaveLength(0);
		});

		it("does not duplicate orphan flags", () => {
			const timers = createFakeTimers(1_000_000);
			const r = new StuckTaskReconciler(createMockStore(), createMockClient(), FAST_CONFIG, undefined, timers);
			r.flagOrphanedInstance("inst-orphan", "test reason");
			r.flagOrphanedInstance("inst-orphan", "test reason 2");
			expect(r.getOrphanedInstances().size).toBe(1);
		});
	});

	describe("StuckTaskReconciler — Restart recovery", () => {
		it("resumes monitoring for still-running instances", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const client = createMockClient({ instanceState: "executing" });
			const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
			const result = await r.recoverOnStartup();
			const resumeAction = result.actions.find((a) => a.action === "resumed_monitoring");
			expect(resumeAction).toBeDefined();
			expect(resumeAction!.taskId).toBe("task-1");
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
			const failAction = result.actions.find((a) => a.action === "failed_timeout");
			expect(failAction).toBeDefined();
			expect(failAction!.newState).toBe("failed");
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
			const failAction = result.actions.find((a) => a.action === "failed_timeout");
			expect(failAction).toBeDefined();
		});

		it("re-registers provisioning tasks for monitoring", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "provisioning", baseTime);
			const store = createMockStore(events, [makeExecution("task-1")]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
			const result = await r.recoverOnStartup();
			expect(result.actions.find((a) => a.action === "resumed_monitoring")).toBeDefined();
			expect(r.getLease("task-1")).toBeDefined();
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

		it("fails running task with no instance ID on restart", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { instanceId: undefined, remoteMetadata: undefined });
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
			const result = await r.recoverOnStartup();
			expect(result.actions.find((a) => a.action === "failed_timeout")).toBeDefined();
		});
	});

	describe("StuckTaskReconciler — Audit events", () => {
		it("persists events with trigger=system and reconciler metadata", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "running", baseTime);
			const exec = makeExecution("task-1", { startedAt: new Date(baseTime + 3000).toISOString() });
			const store = createMockStore(events, [exec]);
			const client = createMockClient({ instanceState: "terminated" });
			const r = new StuckTaskReconciler(store, client, FAST_CONFIG, undefined, timers);
			timers.advance(100_000);
			await r.scan();
			const newEvents = store._events.slice(events.length);
			expect(newEvents.length).toBeGreaterThan(0);
			const failEvent = newEvents.find((e) => e.toState === "failed");
			expect(failEvent).toBeDefined();
			expect(failEvent!.triggerSource).toBe("system");
			expect(failEvent!.metadata).toBeDefined();
			expect(failEvent!.metadata!.reconcilerAction).toBe("failed_by_reconciler");
		});

		it("updates execution record with terminal state and summary", async () => {
			const baseTime = 1_000_000;
			const timers = createFakeTimers(baseTime);
			const events = buildEventsToState("task-1", "provisioning", baseTime);
			const exec = makeExecution("task-1");
			const store = createMockStore(events, [exec]);
			const r = new StuckTaskReconciler(store, createMockClient(), FAST_CONFIG, undefined, timers);
			timers.advance(200_000);
			await r.scan();
			const updated = store._executions.find((e) => e.taskId === "task-1");
			expect(updated!.terminalState).toBe("failed");
			expect(updated!.resultSummary).toContain("Reconciler:");
			expect(updated!.completedAt).toBeDefined();
		});
	});

	describe("StuckTaskReconciler — scan cleans up archived leases", () => {
		it("removes leases for archived tasks during scan", async () => {
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
	});
});
