import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import type {
	CloudExecutionStoreInterface,
	OrchestratorConfig,
} from "../../../src/cloud/cloud-execution-orchestrator";
import {
	CloudExecutionOrchestrator,
	DEFAULT_ORCHESTRATOR_CONFIG,
	deriveWorktreePath,
	validateExecutionIdentityFidelity,
} from "../../../src/cloud/cloud-execution-orchestrator";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import type { CloudPlatformExecutionClient } from "../../../src/cloud/cloud-platform-execution-client";
import type {
	ExecutionCreateRequest,
	ExecutionCreateResponse,
	ExecutionStatusResponse,
} from "../../../src/cloud/cloud-execution-contracts";

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
		async readExecutionsForTask(taskId: string) {
			return executions.filter((e) => e.taskId === taskId);
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
		_events: events,
		_executions: executions,
	} as MockStore;
}

// ---------------------------------------------------------------------------
// Mock CloudPlatformExecutionClient
// ---------------------------------------------------------------------------

function createMockExecutionClient(opts?: {
	failCreate?: boolean;
	failGetStatus?: boolean;
	executionStatus?: ExecutionStatusResponse["status"];
	result?: ExecutionStatusResponse["result"];
	error?: ExecutionStatusResponse["error"];
}): CloudPlatformExecutionClient & { createCalls: ExecutionCreateRequest[]; cancelCalls: string[] } {
	const state = {
		createCalls: [] as ExecutionCreateRequest[],
		cancelCalls: [] as string[],
	};
	return {
		get createCalls() { return state.createCalls; },
		get cancelCalls() { return state.cancelCalls; },
		async createExecution(request: ExecutionCreateRequest): Promise<ExecutionCreateResponse> {
			if (opts?.failCreate) throw new Error("Create execution failed");
			state.createCalls.push(request);
			return {
				executionId: `exec-${request.taskId}`,
				status: "queued",
				taskId: request.taskId,
				attemptNumber: request.attemptNumber,
				createdAt: new Date().toISOString(),
			};
		},
		async getExecutionStatus(executionId: string): Promise<ExecutionStatusResponse> {
			if (opts?.failGetStatus) throw new Error("Get status failed");
			return {
				executionId,
				status: opts?.executionStatus ?? "running",
				taskId: "task-1",
				attemptNumber: 1,
				requestedByUserId: "test-user",
				orgId: "test-org",
				projectId: "test-project",
				startedAt: new Date().toISOString(),
				finishedAt: opts?.executionStatus === "succeeded" || opts?.executionStatus === "failed"
					? new Date().toISOString()
					: null,
				result: opts?.result ?? null,
				error: opts?.error ?? null,
			};
		},
		async cancelExecution(executionId: string): Promise<void> {
			state.cancelCalls.push(executionId);
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const FAST_CONFIG: OrchestratorConfig = {
	tickIntervalMs: 10,
	pollingConfig: {
		pollIntervalMs: 10,
		maxPollDurationMs: 60_000,
		maxConsecutiveErrors: 3,
	},
	orgId: "test-org",
	userId: "test-user",
	projectId: "test-project",
};

// ===========================================================================
// Tests
// ===========================================================================

describe("DEFAULT_ORCHESTRATOR_CONFIG", () => {
	it("has a 5-second tick interval", () => {
		expect(DEFAULT_ORCHESTRATOR_CONFIG.tickIntervalMs).toBe(5_000);
	});

	it("has polling config from DEFAULT_EXECUTION_POLLING_CONFIG", () => {
		expect(DEFAULT_ORCHESTRATOR_CONFIG.pollingConfig.pollIntervalMs).toBe(5_000);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.pollingConfig.maxPollDurationMs).toBe(3_600_000);
	});
});

// ---------------------------------------------------------------------------
// queued -> policy_check -> provisioning -> running (happy path)
// ---------------------------------------------------------------------------

describe("Orchestrator — happy path: queued to running", () => {
	it("advances a queued task to policy_check via dequeue", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("queued");
		expect(result?.newState).toBe("policy_check");
		expect(result?.trigger).toBe("dequeue");
	});

	it("advances policy_check to provisioning via authorized", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "policy_check");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("policy_check");
		expect(result?.newState).toBe("provisioning");
		expect(result?.trigger).toBe("authorized");
	});

	it("advances provisioning to running by creating execution on cloud-platform", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("provisioning");
		expect(result?.newState).toBe("running");
		expect(result?.trigger).toBe("sandbox_ready");
		expect(client.createCalls).toHaveLength(1);
		expect(client.createCalls[0]?.taskId).toBe("task-1");
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle via processTick
// ---------------------------------------------------------------------------

describe("Orchestrator — full lifecycle via processTick", () => {
	it("drives task from queued through provisioning to running in multiple ticks", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");

		// Tick 1: queued -> policy_check
		const tick1 = await orch.processTick();
		expect(tick1).toHaveLength(1);
		expect(tick1[0]?.newState).toBe("policy_check");

		// Tick 2: policy_check -> provisioning
		const tick2 = await orch.processTick();
		expect(tick2).toHaveLength(1);
		expect(tick2[0]?.newState).toBe("provisioning");

		// Tick 3: provisioning -> running (creates execution on cloud-platform)
		const tick3 = await orch.processTick();
		expect(tick3).toHaveLength(1);
		expect(tick3[0]?.newState).toBe("running");

		const finalState = await store.deriveTaskState("task-1");
		expect(finalState).toBe("running");
	});

	it("processes multiple tasks concurrently", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-a", "queued");
		await seedTaskToState(store, "task-b", "policy_check");

		const results = await orch.processTick();

		expect(results).toHaveLength(2);

		const stateA = await store.deriveTaskState("task-a");
		const stateB = await store.deriveTaskState("task-b");
		expect(stateA).toBe("policy_check");
		expect(stateB).toBe("provisioning");
	});
});

// ---------------------------------------------------------------------------
// Event persistence
// ---------------------------------------------------------------------------

describe("Orchestrator — event persistence", () => {
	it("persists an event for every transition", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");
		const initialCount = store._events.length;

		await orch.processTask("task-1");

		expect(store._events).toHaveLength(initialCount + 1);
		const lastEvent = store._events[store._events.length - 1];
		expect(lastEvent).toBeDefined();
		expect(lastEvent.taskId).toBe("task-1");
		expect(lastEvent.fromState).toBe("queued");
		expect(lastEvent.toState).toBe("policy_check");
		expect(lastEvent.trigger).toBe("dequeue");
		expect(lastEvent.triggerSource).toBe("system");
	});

	it("each event has a unique eventId", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

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
// Error paths
// ---------------------------------------------------------------------------

describe("Orchestrator — error paths", () => {
	it("transitions provisioning to failed on create execution failure", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient({ failCreate: true });
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "provisioning");

		const result = await orch.processTask("task-1");

		expect(result).not.toBeNull();
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("provision_timeout");
	});

	it("returns null when running task status is still running", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient({ executionStatus: "running" });
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "cloud-exec-1",
			remoteMetadata: {
				instanceId: "cloud-exec-1",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");
		expect(result).toBeNull();
	});

	it("transitions running to completing on succeeded status", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient({
			executionStatus: "succeeded",
			result: { outcome: "success", exitCode: 0, summary: "Task completed" },
		});
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "cloud-exec-1",
			remoteMetadata: {
				instanceId: "cloud-exec-1",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");
		expect(result).not.toBeNull();
		expect(result?.newState).toBe("completing");
		expect(result?.trigger).toBe("execution_done");
	});

	it("transitions running to failed on failed status", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient({
			executionStatus: "failed",
			error: { code: "TIMEOUT", message: "Execution timed out" },
		});
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "cloud-exec-1",
			remoteMetadata: {
				instanceId: "cloud-exec-1",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		const result = await orch.processTask("task-1");
		expect(result).not.toBeNull();
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("execution_error");
	});

	it("handles no cloud execution ID gracefully", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		// No execution record — should fail gracefully

		const result = await orch.processTask("task-1");
		expect(result).not.toBeNull();
		expect(result?.newState).toBe("failed");
		expect(result?.trigger).toBe("execution_error");
	});
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("Orchestrator — cancellation", () => {
	it("cancels a queued task", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "queued");
		orch.requestCancellation("task-1");

		const results = await orch.processTick();

		expect(results.some((r) => r.taskId === "task-1" && r.newState === "canceled")).toBe(true);
	});

	it("cancels a running task and calls cancelExecution on cloud-platform", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "cloud-exec-1",
			remoteMetadata: {
				instanceId: "cloud-exec-1",
				repoUrl: "https://github.com/test/repo",
				baseBranch: "main",
			},
		});

		orch.requestCancellation("task-1");
		const results = await orch.processTick();

		expect(results.some((r) => r.taskId === "task-1" && r.newState === "canceled")).toBe(true);
		expect(client.cancelCalls).toContain("cloud-exec-1");
	});
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("Orchestrator — teardown", () => {
	it("transitions terminal state to teardown then archived", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		// Seed to completed state
		await seedTaskToState(store, "task-1", "running");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "execution_done",
			fromState: "running",
			toState: "completing",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "finalize_success",
			fromState: "completing",
			toState: "completed",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});

		// Tick: completed -> teardown
		const tick1 = await orch.processTick();
		expect(tick1).toHaveLength(1);
		expect(tick1[0]?.newState).toBe("teardown");

		// Tick: teardown -> archived
		const tick2 = await orch.processTick();
		expect(tick2).toHaveLength(1);
		expect(tick2[0]?.newState).toBe("archived");
	});
});

// ---------------------------------------------------------------------------
// policy_check auto-authorization (governance removed)
// ---------------------------------------------------------------------------

describe("Orchestrator — policy_check auto-authorization", () => {
	it("always auto-authorizes policy_check (governance layer removed)", async () => {
		const store = createMockStore();
		const client = createMockExecutionClient();
		const orch = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		await seedTaskToState(store, "task-1", "policy_check");

		const result = await orch.processTask("task-1");
		expect(result?.newState).toBe("provisioning");
		expect(result?.trigger).toBe("authorized");
	});
});

// ---------------------------------------------------------------------------
// deriveWorktreePath
// ---------------------------------------------------------------------------

describe("deriveWorktreePath", () => {
	it("produces taskId/attempt-N format", () => {
		expect(deriveWorktreePath("task-abc", 1)).toBe("task-abc/attempt-1");
		expect(deriveWorktreePath("task-abc", 3)).toBe("task-abc/attempt-3");
	});
});

// ---------------------------------------------------------------------------
// validateExecutionIdentityFidelity
// ---------------------------------------------------------------------------

describe("validateExecutionIdentityFidelity", () => {
	const baseExecution: PersistedTaskExecution = {
		executionId: "exec-1",
		taskId: "task-1",
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		remoteMetadata: {
			instanceId: "inst-1",
			repoUrl: "https://github.com/test/repo",
			baseBranch: "main",
			featureBranch: "feat-1",
			worktreePath: "task-1/attempt-1",
		},
	};

	it("valid when all fields match", () => {
		const newExec: PersistedTaskExecution = {
			...baseExecution,
			executionId: "exec-2",
			attemptNumber: 2,
			branchIntent: "reuse_branch",
			worktreeIntent: "task-1/attempt-2",
			remoteMetadata: {
				...baseExecution.remoteMetadata!,
				worktreePath: "task-1/attempt-2",
			},
		};
		const result = validateExecutionIdentityFidelity(newExec, baseExecution, "retry");
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("invalid when repoUrl drifts", () => {
		const newExec: PersistedTaskExecution = {
			...baseExecution,
			executionId: "exec-2",
			attemptNumber: 2,
			remoteMetadata: {
				...baseExecution.remoteMetadata!,
				repoUrl: "https://github.com/other/repo",
			},
		};
		const result = validateExecutionIdentityFidelity(newExec, baseExecution, "retry");
		expect(result.valid).toBe(false);
		expect(result.violations.some((v) => v.field === "repoUrl")).toBe(true);
	});
});
