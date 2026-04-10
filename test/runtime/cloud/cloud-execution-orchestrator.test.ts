import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import type {
	CloudExecutionStoreInterface,
	CloudInstanceFullClient,
	CloudRunInvoker,
	CreateInstanceRequest,
	InvokeRunRequest,
	InvokeRunResponse,
	OrchestratorConfig,
} from "../../../src/cloud/cloud-execution-orchestrator";
import {
	CloudExecutionOrchestrator,
	DEFAULT_ORCHESTRATOR_CONFIG,
	deriveWorktreePath,
	validateExecutionIdentityFidelity,
} from "../../../src/cloud/cloud-execution-orchestrator";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import type { AuthorizeRequest, GovernanceClient, UsageEventRequest } from "../../../src/cloud/cloud-governance-client";
import type { CloudInstanceResponse, CloudInstanceState } from "../../../src/cloud/cloud-instance-client";

// ---------------------------------------------------------------------------
// In-memory CloudExecutionStore mock
// ---------------------------------------------------------------------------

interface MockStore extends CloudExecutionStoreInterface {
	createExecution(execution: PersistedTaskExecution): Promise<void>;
	_events: PersistedTaskEvent[];
	_executions: PersistedTaskExecution[];
}

function createMockStore(): MockStore {
	const events: PersistedTaskEvent[] = [];
	const executions: PersistedTaskExecution[] = [];

	return {
		async readEvents() {
			return [...events];
		},
		async readEventsForTask(taskId: string) {
			return events.filter((e) => e.taskId === taskId);
		},
		async deriveTaskState(taskId: string) {
			const taskEvents = events.filter((e) => e.taskId === taskId);
			if (taskEvents.length === 0) return "draft" as CloudExecutionState;
			return taskEvents[taskEvents.length - 1]?.toState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			if (events.some((e) => e.eventId === event.eventId)) {
				throw new Error(`Duplicate event: ${event.eventId}`);
			}
			events.push({ ...event });
		},
		async appendEvents(newEvents: readonly PersistedTaskEvent[]) {
			for (const e of newEvents) {
				if (events.some((ex) => ex.eventId === e.eventId)) {
					throw new Error(`Duplicate event: ${e.eventId}`);
				}
				events.push({ ...e });
			}
		},
		async readExecutions() {
			return [...executions];
		},
		async readExecutionsForTask(taskId: string) {
			return executions.filter((e) => e.taskId === taskId);
		},
		async readExecution(executionId: string) {
			return executions.find((e) => e.executionId === executionId) ?? null;
		},
		async createExecution(execution: PersistedTaskExecution) {
			executions.push({ ...execution });
		},
		async updateExecution(executionId: string, updates: Partial<PersistedTaskExecution>) {
			const idx = executions.findIndex((e) => e.executionId === executionId);
			if (idx === -1) return false;
			const existing = executions[idx];
			if (existing) executions[idx] = { ...existing, ...updates };
			return true;
		},
		// Expose internals for test assertions
		_events: events,
		_executions: executions,
	} as MockStore;
}

// ---------------------------------------------------------------------------
// Mock cloud instance client (ready immediately)
// ---------------------------------------------------------------------------

function createMockClient(opts?: {
	readyImmediately?: boolean;
	instanceState?: CloudInstanceState;
	hostname?: string;
	failCreate?: boolean;
	failPoll?: boolean;
}): CloudInstanceFullClient & { createCalls: CreateInstanceRequest[]; deleteCalls: string[] } {
	const state = {
		createCalls: [] as CreateInstanceRequest[],
		deleteCalls: [] as string[],
	};
	return {
		get createCalls() {
			return state.createCalls;
		},
		get deleteCalls() {
			return state.deleteCalls;
		},
		async createInstance(request: CreateInstanceRequest): Promise<CloudInstanceResponse> {
			if (opts?.failCreate) throw new Error("Create failed");
			state.createCalls.push(request);
			return {
				instance_id: `inst-${request.taskId}`,
				user_id: "test-user",
				namespace: "test-ns",
				state: opts?.readyImmediately ? "ready" : (opts?.instanceState ?? "provisioning"),
				hostname: opts?.hostname ?? `${request.taskId}.runner.test`,
			};
		},
		async getInstance(instanceId: string): Promise<CloudInstanceResponse> {
			if (opts?.failPoll) throw new Error("Poll failed");
			return {
				instance_id: instanceId,
				user_id: "test-user",
				namespace: "test-ns",
				state: "ready",
				hostname: opts?.hostname ?? `${instanceId}.runner.test`,
			};
		},
		async deleteInstance(instanceId: string): Promise<void> {
			state.deleteCalls.push(instanceId);
		},
	};
}

// ---------------------------------------------------------------------------
// Mock run invoker
// ---------------------------------------------------------------------------

function createMockRunInvoker(opts?: {
	failCompose?: boolean;
	failRun?: boolean;
	rejectRun?: boolean;
}): CloudRunInvoker & { composeCalls: string[]; runCalls: InvokeRunRequest[] } {
	const state = {
		composeCalls: [] as string[],
		runCalls: [] as InvokeRunRequest[],
	};
	return {
		get composeCalls() {
			return state.composeCalls;
		},
		get runCalls() {
			return state.runCalls;
		},
		async composePrompt(taskId: string): Promise<string> {
			if (opts?.failCompose) throw new Error("Compose failed");
			state.composeCalls.push(taskId);
			return `Execute task ${taskId}`;
		},
		async invokeRun(request: InvokeRunRequest): Promise<InvokeRunResponse> {
			if (opts?.failRun) throw new Error("/run invocation failed");
			state.runCalls.push(request);
			return {
				accepted: !opts?.rejectRun,
				runId: opts?.rejectRun ? undefined : `run-${request.taskId}`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed the store with events to put a task in a specific state. */
async function seedTaskToState(
	store: CloudExecutionStoreInterface,
	taskId: string,
	targetState: CloudExecutionState,
): Promise<void> {
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
	];

	for (const [from, trigger, to] of transitions) {
		if (targetState === from) break;
		await store.appendEvent({
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: from,
			toState: to,
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		if (targetState === to) break;
	}
}

/** Fast config that makes the poller return immediately. */
const FAST_CONFIG: OrchestratorConfig = {
	tickIntervalMs: 10,
	pollerConfig: {
		pollIntervalMs: 10,
		provisionTimeoutMs: 5_000,
		maxConsecutiveErrors: 3,
		backoffMultiplier: 1,
		maxBackoffMs: 50,
	},
	teardownConfig: {
		maxRetries: 3,
		baseDelayMs: 1,
		maxDelayMs: 5,
		delay: async () => {},
	},
};

// ===========================================================================
// Tests
// ===========================================================================

describe("DEFAULT_ORCHESTRATOR_CONFIG", () => {
	it("has a 5-second tick interval", () => {
		expect(DEFAULT_ORCHESTRATOR_CONFIG.tickIntervalMs).toBe(5_000);
	});

	it("has poller config from DEFAULT_READINESS_POLLER_CONFIG", () => {
		expect(DEFAULT_ORCHESTRATOR_CONFIG.pollerConfig.pollIntervalMs).toBe(3_000);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.pollerConfig.provisionTimeoutMs).toBe(180_000);
	});
});

// ---------------------------------------------------------------------------
// queued -> policy_check -> provisioning -> running (happy path)
// ---------------------------------------------------------------------------

describe("Orchestrator — happy path: queued to running", () => {
	it("advances a queued task to policy_check via dequeue", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("queued");
		expect(result?.newState).toBe("policy_check");
		expect(result?.trigger).toBe("dequeue");
	});

	it("advances policy_check to provisioning via authorized (MVP stub)", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "policy_check");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("policy_check");
		expect(result?.newState).toBe("provisioning");
		expect(result?.trigger).toBe("authorized");
	});

	it("advances provisioning to running when instance is ready", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("provisioning");
		expect(result?.newState).toBe("running");
		expect(result?.trigger).toBe("sandbox_ready");
		expect(client.createCalls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle via processTick
// ---------------------------------------------------------------------------

describe("Orchestrator — full lifecycle via processTick", () => {
	it("drives task from queued through provisioning to running in multiple ticks", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");

		// Tick 1: queued -> policy_check
		const tick1 = await orch.processTick();
		expect(tick1).toHaveLength(1);
		expect(tick1[0]?.newState).toBe("policy_check");

		// Tick 2: policy_check -> provisioning
		const tick2 = await orch.processTick();
		expect(tick2).toHaveLength(1);
		expect(tick2[0]?.newState).toBe("provisioning");

		// Tick 3: provisioning -> running
		const tick3 = await orch.processTick();
		expect(tick3).toHaveLength(1);
		expect(tick3[0]?.newState).toBe("running");

		// Verify final state
		const finalState = await store.deriveTaskState("task-1");
		expect(finalState).toBe("running");
	});

	it("processes multiple tasks concurrently", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-a", "queued");
		await seedTaskToState(store, "task-b", "policy_check");

		const results = await orch.processTick();

		// Both tasks should advance
		expect(results).toHaveLength(2);

		const stateA = await store.deriveTaskState("task-a");
		const stateB = await store.deriveTaskState("task-b");
		expect(stateA).toBe("policy_check");
		expect(stateB).toBe("provisioning");
	});
});

// ---------------------------------------------------------------------------
// All transitions persisted as events
// ---------------------------------------------------------------------------

describe("Orchestrator — event persistence", () => {
	it("persists an event for every transition", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");
		const initialCount = store._events.length;

		await orch.processTask("task-1"); // queued -> policy_check

		expect(store._events).toHaveLength(initialCount + 1);
		const lastEvent = store._events[store._events.length - 1];
		expect(lastEvent).toBeDefined();
		expect(lastEvent.taskId).toBe("task-1");
		expect(lastEvent.fromState).toBe("queued");
		expect(lastEvent.toState).toBe("policy_check");
		expect(lastEvent.trigger).toBe("dequeue");
		expect(lastEvent.triggerSource).toBe("system");
		expect(lastEvent.eventId).toBeTruthy();
		expect(lastEvent.timestamp).toBeTruthy();
	});

	it("each event has a unique eventId", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");
		await orch.processTick();
		await orch.processTick();
		await orch.processTick();

		const ids = store._events.map((e) => e.eventId);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});
});

// ---------------------------------------------------------------------------
// Error paths -> failed
// ---------------------------------------------------------------------------

describe("Orchestrator — error paths", () => {
	it("transitions provisioning to failed on create instance failure", async () => {
		const store = createMockStore();
		const client = createMockClient({ failCreate: true });
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("provision_timeout");
	});

	it("transitions provisioning to failed on poll failure (max errors)", async () => {
		const store = createMockStore();
		const client = createMockClient({ failPoll: true });
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("provision_timeout");
	});

	it("transitions running to failed on /run invocation error", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker({ failRun: true });
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");

		// Need execution record with hostname/instanceId for /run
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-1",
			remoteMetadata: {
				instanceId: "inst-1",
				instanceHostname: "inst-1.runner.test",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("execution_error");
	});

	it("transitions running to failed on /run rejection", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker({ rejectRun: true });
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-1",
			remoteMetadata: {
				instanceId: "inst-1",
				instanceHostname: "inst-1.runner.test",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("execution_error");
	});

	it("transitions running to failed when hostname is missing", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		// No execution record = no hostname/instanceId

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("execution_error");
	});

	it("transitions running to failed on prompt compose error", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker({ failCompose: true });
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-1",
			remoteMetadata: {
				instanceId: "inst-1",
				instanceHostname: "inst-1.runner.test",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("execution_error");
	});
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("Orchestrator — cancellation (P2-1: explicit cancel flow)", () => {
	it("cancels a queued task to canceled via user_cancel", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await seedTaskToState(store, "task-1", "queued");
		orch.requestCancellation("task-1");
		const results = await orch.processTick();
		const cancelResult = results.find((r) => r.taskId === "task-1" && r.newState === "canceled");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.trigger).toBe("user_cancel");
		const finalState = await store.deriveTaskState("task-1");
		expect(["canceled", "teardown"]).toContain(finalState);
	});

	it("cancels a policy_check task to canceled via user_cancel", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await seedTaskToState(store, "task-1", "policy_check");
		orch.requestCancellation("task-1");
		const results = await orch.processTick();
		const cancelResult = results.find((r) => r.taskId === "task-1");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.newState).toBe("canceled");
		expect(cancelResult?.trigger).toBe("user_cancel");
	});

	it("cancels a provisioning task to canceled via user_cancel", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await seedTaskToState(store, "task-1", "provisioning");
		orch.requestCancellation("task-1");
		const results = await orch.processTick();
		const cancelResult = results.find((r) => r.taskId === "task-1");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.newState).toBe("canceled");
		expect(cancelResult?.trigger).toBe("user_cancel");
	});

	it("cancels a running task to canceled via user_cancel", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await seedTaskToState(store, "task-1", "running");
		orch.requestCancellation("task-1");
		const results = await orch.processTick();
		const cancelResult = results.find((r) => r.taskId === "task-1");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.newState).toBe("canceled");
		expect(cancelResult?.trigger).toBe("user_cancel");
	});

	it("cancellation is a no-op for already-terminal tasks (but teardown still advances)", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		// Seed task to failed state
		await seedTaskToState(store, "task-1", "provisioning");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "provision_timeout",
			fromState: "provisioning",
			toState: "failed",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});

		const countBefore = store._events.length;

		orch.requestCancellation("task-1");
		const results = await orch.processTick();

		// Cancellation itself is a no-op for terminal tasks, but teardown advances:
		// failed → teardown via auto_teardown, then teardown → archived via sandbox_terminated
		const cancelResults = results.filter((r) => r.trigger === "user_cancel" || r.trigger === "denied");
		expect(cancelResults).toHaveLength(0); // no cancellation transition applied

		// Teardown events are added (terminal → teardown, teardown → archived)
		expect(store._events.length).toBeGreaterThan(countBefore);
	});
});

// ---------------------------------------------------------------------------
// Idempotency and restart safety
// ---------------------------------------------------------------------------

describe("Orchestrator — idempotency and restart safety", () => {
	it("terminal tasks advance to teardown (no longer a no-op)", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		// Seed to failed
		await seedTaskToState(store, "task-1", "provisioning");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "provision_timeout",
			fromState: "provisioning",
			toState: "failed",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});

		const result = await orch.processTask("task-1");
		// Terminal states now advance to teardown via auto_teardown
		expect(result).not.toBeNull();
		expect(result?.previousState).toBe("failed");
		expect(result?.newState).toBe("teardown");
		expect(result?.trigger).toBe("auto_teardown");
	});

	it("archived tasks are truly a no-op", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		// Seed to archived (terminal → teardown → archived)
		await seedTaskToState(store, "task-1", "provisioning");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "provision_timeout",
			fromState: "provisioning",
			toState: "failed",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "auto_teardown",
			fromState: "failed",
			toState: "teardown",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "sandbox_terminated",
			fromState: "teardown",
			toState: "archived",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});

		const result = await orch.processTask("task-1");
		expect(result).toBeNull();
	});

	it("recovers state from persistence after restart", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();

		// First orchestrator instance drives to policy_check
		const orch1 = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await seedTaskToState(store, "task-1", "queued");
		await orch1.processTask("task-1"); // queued -> policy_check
		orch1.stop();

		// Simulated restart: new orchestrator instance
		const orch2 = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		const result = await orch2.processTask("task-1");

		// Should pick up from policy_check
		expect(result).not.toBeNull();
		expect(result?.previousState).toBe("policy_check");
		expect(result?.newState).toBe("provisioning");
	});

	it("is safe with draft tasks (no events yet)", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		const result = await orch.processTask("nonexistent");
		expect(result).toBeNull();
	});

	it("does not re-invoke /run if execution already started", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(), // Already started!
			instanceId: "inst-1",
			remoteMetadata: {
				instanceId: "inst-1",
				instanceHostname: "inst-1.runner.test",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");
		expect(result).toBeNull();
		expect(invoker.composeCalls).toHaveLength(0);
		expect(invoker.runCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Running: /run invocation success path
// ---------------------------------------------------------------------------

describe("Orchestrator — /run invocation", () => {
	it("invokes /run and marks execution as started", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-1",
			remoteMetadata: {
				instanceId: "inst-1",
				instanceHostname: "inst-1.runner.test",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");

		// /run accepted -> returns null (stays running, waiting for callback)
		expect(result).toBeNull();
		expect(invoker.composeCalls).toHaveLength(1);
		expect(invoker.runCalls).toHaveLength(1);
		expect(invoker.runCalls[0]?.hostname).toBe("inst-1.runner.test");
		expect(invoker.runCalls[0]?.instanceId).toBe("inst-1");

		// Execution should be marked as started
		const exec = store._executions.find((e) => e.executionId === "exec-1");
		expect(exec).toBeTruthy();
		expect(exec?.startedAt).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

describe("Orchestrator — start/stop", () => {
	it("can be started and stopped without error", () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		orch.start();
		orch.stop();
		// No error means success
	});

	it("start is idempotent", () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		orch.start();
		orch.start(); // second call is no-op
		orch.stop();
	});
});

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

describe("Orchestrator — transition validation", () => {
	it("all transitions go through the lifecycle validator", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");

		// Drive through the full flow
		await orch.processTick(); // queued -> policy_check
		await orch.processTick(); // policy_check -> provisioning
		await orch.processTick(); // provisioning -> running

		// Check that every persisted event has valid from->to transitions
		const task1Events = store._events.filter((e) => e.taskId === "task-1");
		// Include seed events + orchestrator events
		expect(task1Events.length).toBeGreaterThanOrEqual(4); // seed submit + 3 orchestrator transitions

		for (let i = 1; i < task1Events.length; i++) {
			const prev = task1Events[i - 1];
			const curr = task1Events[i];
			expect(prev).toBeDefined();
			expect(curr).toBeDefined();
			if (prev && curr) {
				expect(curr.fromState).toBe(prev.toState);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Provisioning creates instance and updates execution metadata
// ---------------------------------------------------------------------------

describe("Orchestrator — provisioning creates instance", () => {
	it("calls createInstance with task metadata", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		// Create execution record with repo info
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			remoteMetadata: {
				instanceId: "",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "develop",
				featureBranch: "feat/cloud",
			},
		});

		await orch.processTask("task-1");

		expect(client.createCalls).toHaveLength(1);
		expect(client.createCalls[0]?.taskId).toBe("task-1");
		expect(client.createCalls[0]?.repoUrl).toBe("https://github.com/test/repo");
		expect(client.createCalls[0]?.baseBranch).toBe("develop");
		expect(client.createCalls[0]?.featureBranch).toBe("feat/cloud");
	});

	// ---------------------------------------------------------------------------
	// Mock Governance Client
	// ---------------------------------------------------------------------------

	interface MockGovernanceClient extends GovernanceClient {
		authorizeCalls: AuthorizeRequest[];
		usageCalls: UsageEventRequest[];
		auditCalls: Array<{ taskId: string; fromState: string; toState: string }>;
	}

	function createMockGovernanceClient(opts?: {
		decision?: "authorized" | "denied";
		reason?: string;
	}): MockGovernanceClient {
		const mock: MockGovernanceClient = {
			authorizeCalls: [],
			usageCalls: [],
			auditCalls: [],
			async checkAuthorization(request) {
				mock.authorizeCalls.push(request);
				return {
					decision: opts?.decision ?? "authorized",
					reason: opts?.reason,
				};
			},
			async reportUsage(request) {
				mock.usageCalls.push(request);
				return { accepted: true };
			},
			async reportAudit(request) {
				mock.auditCalls.push({ taskId: request.taskId, fromState: request.fromState, toState: request.toState });
				return { accepted: true };
			},
		};
		return mock;
	}

	// ---------------------------------------------------------------------------
	// Governance — policy check: authorized flow
	// ---------------------------------------------------------------------------

	describe("Orchestrator — governance policy check", () => {
		it("transitions policy_check -> provisioning when governance authorizes", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient({ decision: "authorized" });
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			await seedTaskToState(store, "task-1", "policy_check");
			const result = await orch.processTask("task-1");

			expect(result).not.toBeNull();
			expect(result?.previousState).toBe("policy_check");
			expect(result?.newState).toBe("provisioning");
			expect(result?.trigger).toBe("authorized");
			expect(governance.authorizeCalls).toHaveLength(1);
			expect(governance.authorizeCalls[0]?.taskId).toBe("task-1");
		});

		it("transitions policy_check -> failed when governance denies", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient({ decision: "denied", reason: "over quota" });
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			await seedTaskToState(store, "task-1", "policy_check");
			const result = await orch.processTask("task-1");

			expect(result).not.toBeNull();
			expect(result?.previousState).toBe("policy_check");
			expect(result?.newState).toBe("failed");
			expect(result?.trigger).toBe("denied");
			expect(governance.authorizeCalls).toHaveLength(1);
		});

		it("auto-authorizes when no governance client is configured", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			// No governance client — backward compatible behavior
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

			await seedTaskToState(store, "task-1", "policy_check");
			const result = await orch.processTask("task-1");

			expect(result).not.toBeNull();
			expect(result?.previousState).toBe("policy_check");
			expect(result?.newState).toBe("provisioning");
			expect(result?.trigger).toBe("authorized");
		});

		it("passes full request context including projectId and orgId to checkAuthorization", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient({ decision: "authorized" });
			const configWithOrg: OrchestratorConfig = {
				...FAST_CONFIG,
				projectId: "proj-42",
				orgId: "org-99",
				requestedLimits: { maxTokens: 10_000 },
			};
			const orch = new CloudExecutionOrchestrator(
				store,
				client,
				invoker,
				configWithOrg,
				undefined,
				null,
				governance,
			);

			await seedTaskToState(store, "task-1", "policy_check");

			// Create execution with metadata so handler can read it
			await store.createExecution({
				executionId: "exec-pol-1",
				taskId: "task-1",
				attemptNumber: 1,
				executionMode: "cloud_agent",
				createdAt: new Date().toISOString(),
				resultSummary: "Implement feature X",
				remoteMetadata: {
					instanceId: "pending",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
				},
			});

			await orch.processTask("task-1");

			expect(governance.authorizeCalls).toHaveLength(1);
			const call = governance.authorizeCalls[0];
			expect(call?.taskId).toBe("task-1");
			expect(call?.orgId).toBe("org-99");
			expect(call?.executionMode).toBe("cloud_agent");
			expect(call?.projectId).toBe("proj-42");
			expect(call?.requestedLimits).toEqual({ maxTokens: 10_000 });

			const taskSpec = call?.taskSpec;
			expect(taskSpec).toBeDefined();
			expect(taskSpec?.prompt).toBe("Implement feature X");
			expect(taskSpec?.baseRef).toBe("main");
			expect(taskSpec?.executionMode).toBe("cloud_agent");
		});

		it("defaults projectId to 'default' when not configured", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient({ decision: "authorized" });
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			await seedTaskToState(store, "task-1", "policy_check");

			await orch.processTask("task-1");

			expect(governance.authorizeCalls).toHaveLength(1);
			const call = governance.authorizeCalls[0];
			expect(call?.projectId).toBe("default");
		});
	});

	// ---------------------------------------------------------------------------
	// Governance — usage event emission
	// ---------------------------------------------------------------------------

	describe("Orchestrator — governance usage events", () => {
		it("reports usage event when terminal state transitions to teardown", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient();
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			// Seed to failed state
			await seedTaskToState(store, "task-1", "provisioning");
			await store.appendEvent({
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "provision_timeout",
				fromState: "provisioning",
				toState: "failed",
				timestamp: new Date().toISOString(),
				triggerSource: "system",
			});

			await orch.processTask("task-1"); // failed -> teardown (reports usage)

			expect(governance.usageCalls).toHaveLength(1);
			expect(governance.usageCalls[0]?.taskId).toBe("task-1");
			expect(governance.usageCalls[0]?.terminalState).toBe("failed");
		});

		it("passes full usage payload including executionMode and token metadata", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient();
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			// Seed to failed state with execution metadata
			await seedTaskToState(store, "task-1", "provisioning");
			await store.createExecution({
				executionId: "exec-usage-1",
				taskId: "task-1",
				attemptNumber: 1,
				executionMode: "cloud_agent",
				createdAt: new Date().toISOString(),
				durationSeconds: 42,
				remoteMetadata: {
					instanceId: "inst-1",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					tokenUsage: 7500,
				},
			});
			await store.appendEvent({
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "provision_timeout",
				fromState: "provisioning",
				toState: "failed",
				timestamp: new Date().toISOString(),
				triggerSource: "system",
			});

			await orch.processTask("task-1"); // failed -> teardown (reports usage)

			expect(governance.usageCalls).toHaveLength(1);
			const call = governance.usageCalls[0];
			expect(call?.taskId).toBe("task-1");
			expect(call?.executionId).toBe("exec-usage-1");
			expect(call?.terminalState).toBe("failed");
			expect(call?.durationSeconds).toBe(42);
			expect(call?.executionMode).toBe("cloud_agent");
			expect(call?.tokensIn).toBe(7500);
		});

		it("does not report usage when no governance client is configured", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

			await seedTaskToState(store, "task-1", "provisioning");
			await store.appendEvent({
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "provision_timeout",
				fromState: "provisioning",
				toState: "failed",
				timestamp: new Date().toISOString(),
				triggerSource: "system",
			});

			// Should not throw — just no usage event
			const result = await orch.processTask("task-1");
			expect(result).not.toBeNull();
			expect(result?.newState).toBe("teardown");
		});
	});

	// ---------------------------------------------------------------------------
	// Governance — audit event emission
	// ---------------------------------------------------------------------------

	describe("Orchestrator — governance audit events", () => {
		it("emits audit events on lifecycle transitions", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance = createMockGovernanceClient();
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			await seedTaskToState(store, "task-1", "queued");

			await orch.processTask("task-1"); // queued -> policy_check

			// Allow fire-and-forget audit promise to resolve
			await new Promise((r) => setTimeout(r, 10));

			expect(governance.auditCalls.length).toBeGreaterThanOrEqual(1);
			const auditCall = governance.auditCalls.find((c) => c.fromState === "queued" && c.toState === "policy_check");
			expect(auditCall).toBeTruthy();
			expect(auditCall?.taskId).toBe("task-1");
		});

		it("audit failures do not block transitions", async () => {
			const store = createMockStore();
			const client = createMockClient();
			const invoker = createMockRunInvoker();
			const governance: MockGovernanceClient = {
				...createMockGovernanceClient(),
				async reportAudit() {
					throw new Error("Audit service down");
				},
			};
			const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG, undefined, null, governance);

			await seedTaskToState(store, "task-1", "queued");
			const result = await orch.processTask("task-1");

			// Transition succeeds despite audit failure
			expect(result).not.toBeNull();
			expect(result?.success).toBe(true);
			expect(result?.newState).toBe("policy_check");
		});
	});
});

// ===========================================================================
// Execution Identity Fidelity — deriveWorktreePath
// ===========================================================================

describe("deriveWorktreePath", () => {
	it("produces deterministic path from taskId + attemptNumber", () => {
		expect(deriveWorktreePath("task-abc", 1)).toBe("task-abc/attempt-1");
		expect(deriveWorktreePath("task-abc", 2)).toBe("task-abc/attempt-2");
		expect(deriveWorktreePath("task-abc", 3)).toBe("task-abc/attempt-3");
	});

	it("is consistent across calls", () => {
		const a = deriveWorktreePath("task-xyz", 5);
		const b = deriveWorktreePath("task-xyz", 5);
		expect(a).toBe(b);
	});

	it("differs for different attempt numbers", () => {
		const a = deriveWorktreePath("task-001", 1);
		const b = deriveWorktreePath("task-001", 2);
		expect(a).not.toBe(b);
	});

	it("differs for different task IDs", () => {
		const a = deriveWorktreePath("task-a", 1);
		const b = deriveWorktreePath("task-b", 1);
		expect(a).not.toBe(b);
	});
});

// ===========================================================================
// Execution Identity Fidelity — validateExecutionIdentityFidelity
// ===========================================================================

function makeExecForFidelity(overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: randomUUID(),
		taskId: "task-fidelity-001",
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		remoteMetadata: {
			instanceId: "inst-src",
			repoUrl: "https://github.com/cline/kanban.git",
			baseBranch: "main",
			featureBranch: "task/fidelity-001",
			worktreePath: "task-fidelity-001/attempt-1",
		},
		...overrides,
	};
}
describe("validateExecutionIdentityFidelity", () => {
	it("returns valid when all canonical fields match for retry", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			branchIntent: "reuse_branch",
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "pending-provisioning",
				worktreePath: "task-fidelity-001/attempt-2",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("detects repoUrl drift as error", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "pending-provisioning",
				repoUrl: "https://github.com/other/repo.git",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(false);
		const v = result.violations.find((v) => v.field === "repoUrl");
		expect(v).toBeDefined();
		expect(v?.severity).toBe("error");
		expect(v?.expected).toBe("https://github.com/cline/kanban.git");
		expect(v?.actual).toBe("https://github.com/other/repo.git");
	});

	it("detects baseBranch drift as error", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			remoteMetadata: { ...(source.remoteMetadata ?? {}), instanceId: "p", baseBranch: "develop" },
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(false);
		expect(result.violations.find((v) => v.field === "baseBranch")?.severity).toBe("error");
	});

	it("detects featureBranch drift on reuse_branch as error", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			branchIntent: "reuse_branch",
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "p",
				featureBranch: "task/different-branch",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(false);
		expect(result.violations.find((v) => v.field === "featureBranch")?.severity).toBe("error");
	});

	it("fresh_branch with undefined featureBranch is valid", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			branchIntent: "fresh_branch",
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "p",
				featureBranch: undefined,
				worktreePath: "task-fidelity-001/attempt-2",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(true);
		expect(result.violations.filter((v) => v.field === "featureBranch")).toHaveLength(0);
	});

	it("detects attemptNumber not incrementing as error", () => {
		const source = makeExecForFidelity({ attemptNumber: 2 });
		const newExec = makeExecForFidelity({ attemptNumber: 1 });
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(false);
		expect(result.violations.find((v) => v.field === "attemptNumber")?.severity).toBe("error");
	});

	it("detects worktreePath not matching deterministic derivation as warning", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			branchIntent: "fresh_branch",
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "p",
				featureBranch: undefined,
				worktreePath: "/some/random/path",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.valid).toBe(true); // warning, not error
		const v = result.violations.find((v) => v.field === "worktreePath");
		expect(v).toBeDefined();
		expect(v?.severity).toBe("warning");
		expect(v?.expected).toBe("task-fidelity-001/attempt-2");
	});

	it("validates correctly for replay flow", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			branchIntent: "fresh_branch",
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "p",
				featureBranch: undefined,
				worktreePath: "task-fidelity-001/attempt-2",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "replay");
		expect(result.valid).toBe(true);
		expect(result.flowType).toBe("replay");
	});

	it("validates correctly for rerun_snapshot flow", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 3,
			branchIntent: "fresh_branch",
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "p",
				featureBranch: undefined,
				worktreePath: "task-fidelity-001/attempt-3",
			},
		});
		const result = validateExecutionIdentityFidelity(newExec, source, "rerun_snapshot");
		expect(result.valid).toBe(true);
		expect(result.flowType).toBe("rerun_snapshot");
	});

	it("logs violations when logger is provided", () => {
		const logged: Array<{ msg: string }> = [];
		const logger = {
			info: () => {},
			warn: () => {},
			error: (msg: string) => {
				logged.push({ msg });
			},
		};
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({
			attemptNumber: 2,
			remoteMetadata: {
				...(source.remoteMetadata ?? {}),
				instanceId: "p",
				repoUrl: "https://other.example.com",
			},
		});
		validateExecutionIdentityFidelity(newExec, source, "retry", logger);
		expect(logged.length).toBeGreaterThan(0);
		expect(logged[0]?.msg).toContain("repoUrl");
	});

	it("returns taskId and executionId in result", () => {
		const source = makeExecForFidelity({ attemptNumber: 1 });
		const newExec = makeExecForFidelity({ attemptNumber: 2 });
		const result = validateExecutionIdentityFidelity(newExec, source, "retry");
		expect(result.taskId).toBe("task-fidelity-001");
		expect(result.executionId).toBe(newExec.executionId);
	});
});

// ===========================================================================
// Canonical Identity Preservation — Retry Flow
// ===========================================================================

describe("Canonical Identity Preservation — Retry", () => {
	const CANONICAL_REPO = "https://github.com/cline/kanban.git";
	const CANONICAL_BASE = "main";
	const CANONICAL_FEATURE = "task/canon-001";
	const TASK_ID = "task-canon-001";

	function makeCanonicalExecution(attempt: number): PersistedTaskExecution {
		return {
			executionId: `exec-canon-${attempt}`,
			taskId: TASK_ID,
			attemptNumber: attempt,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			terminalState: attempt === 1 ? "failed" : undefined,
			remoteMetadata: {
				instanceId: attempt === 1 ? "inst-1" : "pending-provisioning",
				repoUrl: CANONICAL_REPO,
				baseBranch: CANONICAL_BASE,
				featureBranch: CANONICAL_FEATURE,
				worktreePath: deriveWorktreePath(TASK_ID, attempt),
			},
		};
	}

	it("retry preserves repoUrl from failed execution", async () => {
		const store = createMockStore();
		await seedTaskToState(store, TASK_ID, "provisioning");
		const source = makeCanonicalExecution(1);
		await store.createExecution(source);

		// Use the orchestrator to drive provisioning
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await orch.processTask(TASK_ID);

		// Verify createInstance was called with canonical repoUrl
		expect(client.createCalls).toHaveLength(1);
		expect(client.createCalls[0]?.repoUrl).toBe(CANONICAL_REPO);
	});

	it("retry preserves baseBranch from failed execution", async () => {
		const store = createMockStore();
		await seedTaskToState(store, TASK_ID, "provisioning");
		await store.createExecution(makeCanonicalExecution(1));

		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await orch.processTask(TASK_ID);

		expect(client.createCalls[0]?.baseBranch).toBe(CANONICAL_BASE);
	});

	it("retry preserves featureBranch from failed execution", async () => {
		const store = createMockStore();
		await seedTaskToState(store, TASK_ID, "provisioning");
		await store.createExecution(makeCanonicalExecution(1));

		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);
		await orch.processTask(TASK_ID);

		expect(client.createCalls[0]?.featureBranch).toBe(CANONICAL_FEATURE);
	});
});

// ===========================================================================
// Canonical Identity Preservation — Worktree + Attempt Context
// ===========================================================================

describe("Canonical Identity Preservation — Worktree + Attempt", () => {
	it("worktree path is deterministic for each attempt", () => {
		const task = "task-wt-001";
		expect(deriveWorktreePath(task, 1)).toBe("task-wt-001/attempt-1");
		expect(deriveWorktreePath(task, 2)).toBe("task-wt-001/attempt-2");
		expect(deriveWorktreePath(task, 10)).toBe("task-wt-001/attempt-10");
	});

	it("validateExecutionIdentityFidelity passes for properly chained retries", () => {
		const source = makeExecForFidelity({
			taskId: "task-chain",
			attemptNumber: 1,
			remoteMetadata: {
				instanceId: "inst-1",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
				featureBranch: "task/chain",
				worktreePath: deriveWorktreePath("task-chain", 1),
			},
		});
		const retry = makeExecForFidelity({
			taskId: "task-chain",
			attemptNumber: 2,
			branchIntent: "reuse_branch",
			remoteMetadata: {
				instanceId: "pending-provisioning",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
				featureBranch: "task/chain",
				worktreePath: deriveWorktreePath("task-chain", 2),
			},
		});
		const result = validateExecutionIdentityFidelity(retry, source, "retry");
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("validateExecutionIdentityFidelity catches multi-field drift", () => {
		const source = makeExecForFidelity({
			taskId: "task-drift",
			attemptNumber: 1,
			remoteMetadata: {
				instanceId: "inst-1",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
			},
		});
		const drifted = makeExecForFidelity({
			taskId: "task-drift",
			attemptNumber: 2,
			remoteMetadata: {
				instanceId: "p",
				repoUrl: "https://github.com/other/repo.git",
				baseBranch: "develop",
			},
		});
		const result = validateExecutionIdentityFidelity(drifted, source, "retry");
		expect(result.valid).toBe(false);
		expect(result.violations.length).toBeGreaterThanOrEqual(2);
		const fields = result.violations.map((v) => v.field);
		expect(fields).toContain("repoUrl");
		expect(fields).toContain("baseBranch");
	});
});

// ===========================================================================
// Canonical Identity Preservation — Rerun-from-Snapshot
// ===========================================================================

describe("Canonical Identity Preservation — Rerun Snapshot", () => {
	it("rerun preserves repoUrl and baseBranch from snapshot", () => {
		const source = makeExecForFidelity({
			attemptNumber: 1,
			remoteMetadata: {
				instanceId: "inst-1",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "feature-base",
				featureBranch: "task/snap-001",
				worktreePath: deriveWorktreePath("task-fidelity-001", 1),
			},
		});
		const rerun = makeExecForFidelity({
			attemptNumber: 3,
			branchIntent: "fresh_branch",
			remoteMetadata: {
				instanceId: "pending-provisioning",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "feature-base",
				featureBranch: undefined,
				worktreePath: deriveWorktreePath("task-fidelity-001", 3),
			},
		});
		const result = validateExecutionIdentityFidelity(rerun, source, "rerun_snapshot");
		expect(result.valid).toBe(true);
	});

	it("rerun fresh_branch clears featureBranch from snapshot", () => {
		const source = makeExecForFidelity({
			attemptNumber: 1,
			remoteMetadata: {
				instanceId: "i",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
				featureBranch: "task/original",
			},
		});
		const rerun = makeExecForFidelity({
			attemptNumber: 2,
			branchIntent: "fresh_branch",
			remoteMetadata: {
				instanceId: "p",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
				featureBranch: undefined,
				worktreePath: deriveWorktreePath("task-fidelity-001", 2),
			},
		});
		const result = validateExecutionIdentityFidelity(rerun, source, "rerun_snapshot");
		expect(result.valid).toBe(true);
		// No featureBranch violation because fresh_branch allows undefined
		expect(result.violations.filter((v) => v.field === "featureBranch")).toHaveLength(0);
	});
});
