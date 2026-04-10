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
} from "../../../src/cloud/cloud-execution-orchestrator";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
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
				state: opts?.readyImmediately ? "ready" : (opts?.instanceState ?? "provisioning"),
				hostname: opts?.hostname ?? `${request.taskId}.runner.test`,
			};
		},
		async getInstance(instanceId: string): Promise<CloudInstanceResponse> {
			if (opts?.failPoll) throw new Error("Poll failed");
			return {
				instance_id: instanceId,
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

describe("Orchestrator — cancellation", () => {
	it("cancels a queued task to failed via dequeue + denied", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");

		orch.requestCancellation("task-1");
		const results = await orch.processTick();

		// Should produce a result ending in failed
		const cancelResult = results.find((r) => r.taskId === "task-1");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.newState).toBe("failed");

		const finalState = await store.deriveTaskState("task-1");
		expect(finalState).toBe("failed");
	});

	it("cancels a policy_check task to failed via denied", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "policy_check");

		orch.requestCancellation("task-1");
		const results = await orch.processTick();

		const cancelResult = results.find((r) => r.taskId === "task-1");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.newState).toBe("failed");
		expect(cancelResult?.trigger).toBe("denied");
	});

	it("cancels a provisioning task to failed", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const orch = new CloudExecutionOrchestrator(store, client, invoker, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		orch.requestCancellation("task-1");
		const results = await orch.processTick();

		const cancelResult = results.find((r) => r.taskId === "task-1");
		expect(cancelResult).toBeTruthy();
		expect(cancelResult?.newState).toBe("failed");
		expect(cancelResult?.trigger).toBe("provision_timeout");
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

	it("is a no-op for already-terminal tasks", async () => {
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

		expect(results).toHaveLength(0);
		expect(store._events).toHaveLength(countBefore);
	});
});

// ---------------------------------------------------------------------------
// Idempotency and restart safety
// ---------------------------------------------------------------------------

describe("Orchestrator — idempotency and restart safety", () => {
	it("is idempotent: processing a terminal task is a no-op", async () => {
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
});
