import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import type {
	CloudExecutionStoreInterface,
	CloudInstanceFullClient,
	CloudRunInvoker,
	CreateInstanceRequest,
	InvokeRunRequest,
	OrchestratorConfig,
	TeardownConfig,
} from "../../../src/cloud/cloud-execution-orchestrator";
import { CloudExecutionOrchestrator, DEFAULT_TEARDOWN_CONFIG } from "../../../src/cloud/cloud-execution-orchestrator";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import type { CloudInstanceResponse } from "../../../src/cloud/cloud-instance-client";
import { CloudInstanceClientError } from "../../../src/cloud/cloud-instance-client";

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
			const te = events.filter((e) => e.taskId === taskId);
			if (te.length === 0) return "draft" as CloudExecutionState;
			return te[te.length - 1]?.toState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			if (events.some((e) => e.eventId === event.eventId)) throw new Error(`Dup: ${event.eventId}`);
			events.push({ ...event });
		},
		async appendEvents(ne: readonly PersistedTaskEvent[]) {
			for (const e of ne) {
				if (events.some((x) => x.eventId === e.eventId)) throw new Error(`Dup`);
				events.push({ ...e });
			}
		},
		async readExecutions() {
			return [...executions];
		},
		async readExecutionsForTask(taskId: string) {
			return executions.filter((e) => e.taskId === taskId);
		},
		async readExecution(eid: string) {
			return executions.find((e) => e.executionId === eid) ?? null;
		},
		async createExecution(ex: PersistedTaskExecution) {
			executions.push({ ...ex });
		},
		async updateExecution(eid: string, upd: Partial<PersistedTaskExecution>) {
			const i = executions.findIndex((e) => e.executionId === eid);
			if (i === -1) return false;
			const ex = executions[i];
			if (ex) executions[i] = { ...ex, ...upd };
			return true;
		},
		_events: events,
		_executions: executions,
	} as MockStore;
}

// ---------------------------------------------------------------------------
// Mock cloud instance client
// ---------------------------------------------------------------------------

function createMockClient(opts?: {
	deleteFailCount?: number;
	deleteFailError?: Error;
}): CloudInstanceFullClient & { deleteCalls: string[] } {
	let deleteCallCount = 0;
	const deleteCalls: string[] = [];
	return {
		get deleteCalls() {
			return deleteCalls;
		},
		async createInstance(req: CreateInstanceRequest): Promise<CloudInstanceResponse> {
			return {
				instance_id: `inst-${req.taskId}`,
				user_id: "test-user",
				namespace: "test-ns",
				state: "ready",
				hostname: `${req.taskId}.runner.test`,
			};
		},
		async getInstance(id: string): Promise<CloudInstanceResponse> {
			return {
				instance_id: id,
				user_id: "test-user",
				namespace: "test-ns",
				state: "ready",
				hostname: `${id}.runner.test`,
			};
		},
		async deleteInstance(id: string): Promise<void> {
			deleteCallCount++;
			if (opts?.deleteFailCount && deleteCallCount <= opts.deleteFailCount) {
				throw opts?.deleteFailError ?? new Error("Delete failed");
			}
			deleteCalls.push(id);
		},
	};
}

function createMockRunInvoker(): CloudRunInvoker {
	return {
		async composePrompt(taskId: string) {
			return `Execute ${taskId}`;
		},
		async invokeRun(req: InvokeRunRequest) {
			return { accepted: true, runId: `run-${req.taskId}` };
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAST_TEARDOWN: TeardownConfig = {
	maxRetries: 3,
	baseDelayMs: 1,
	maxDelayMs: 5,
	delay: async () => {},
};

const FAST_CONFIG: OrchestratorConfig = {
	tickIntervalMs: 10,
	pollerConfig: {
		pollIntervalMs: 10,
		provisionTimeoutMs: 5_000,
		maxConsecutiveErrors: 3,
		backoffMultiplier: 1,
		maxBackoffMs: 50,
	},
	teardownConfig: FAST_TEARDOWN,
};

async function seedTaskToState(store: CloudExecutionStoreInterface, taskId: string, target: CloudExecutionState) {
	const tr: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
		["running", "execution_done", "completing"],
		["completing", "finalize_success", "completed"],
	];
	for (const [from, trigger, to] of tr) {
		if (target === from) break;
		await store.appendEvent({
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: from,
			toState: to,
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		if (target === to) break;
	}
}

async function seedToTerminal(
	store: MockStore,
	taskId: string,
	terminal: "completed" | "failed" | "canceled",
	opts?: { instanceId?: string; debugPreserve?: boolean },
) {
	if (terminal === "completed") {
		await seedTaskToState(store, taskId, "completed");
	} else if (terminal === "failed") {
		await seedTaskToState(store, taskId, "running");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId,
			trigger: "execution_error",
			fromState: "running",
			toState: "failed",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
	} else {
		await seedTaskToState(store, taskId, "running");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId,
			trigger: "user_cancel",
			fromState: "running",
			toState: "canceled",
			timestamp: new Date().toISOString(),
			triggerSource: "user",
		});
	}
	await store.createExecution({
		executionId: `exec-${taskId}`,
		taskId,
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		instanceId: opts?.instanceId ?? `inst-${taskId}`,
		terminalState: terminal,
		remoteMetadata: {
			instanceId: opts?.instanceId ?? `inst-${taskId}`,
			instanceHostname: `${taskId}.runner.test`,
			repoUrl: "https://github.com/test/repo",
			baseBranch: "main",
			debugPreserve: opts?.debugPreserve,
		},
	});
}

// ===========================================================================
// Tests — Terminal -> Teardown transition
// ===========================================================================

describe("Teardown — terminal to teardown transition", () => {
	it("completed -> teardown via auto_teardown", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		const result = await orch.processTask("task-1");
		expect(result?.success).toBe(true);
		expect(result?.previousState).toBe("completed");
		expect(result?.newState).toBe("teardown");
		expect(result?.trigger).toBe("auto_teardown");
	});

	it("failed -> teardown via auto_teardown", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "failed");
		const result = await orch.processTask("task-1");
		expect(result?.previousState).toBe("failed");
		expect(result?.newState).toBe("teardown");
		expect(result?.trigger).toBe("auto_teardown");
	});

	it("canceled -> teardown via auto_teardown", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "canceled");
		const result = await orch.processTask("task-1");
		expect(result?.previousState).toBe("canceled");
		expect(result?.newState).toBe("teardown");
		expect(result?.trigger).toBe("auto_teardown");
	});
});

// ===========================================================================
// Tests — Teardown -> Archived (instance deletion)
// ===========================================================================

describe("Teardown — teardown to archived (happy path)", () => {
	it("completed -> teardown -> archived with instance deletion", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1"); // completed -> teardown
		const result = await orch.processTask("task-1"); // teardown -> archived
		expect(result?.newState).toBe("archived");
		expect(result?.trigger).toBe("sandbox_terminated");
		expect(client.deleteCalls).toContain("inst-task-1");
	});

	it("failed -> teardown -> archived with instance deletion", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "failed");
		await orch.processTask("task-1");
		const result = await orch.processTask("task-1");
		expect(result?.newState).toBe("archived");
		expect(client.deleteCalls).toContain("inst-task-1");
	});

	it("canceled -> teardown -> archived with instance deletion", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "canceled");
		await orch.processTask("task-1");
		const result = await orch.processTask("task-1");
		expect(result?.newState).toBe("archived");
		expect(client.deleteCalls).toContain("inst-task-1");
	});

	it("transitions to archived even without instance ID", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		// Seed to teardown without execution records
		await seedTaskToState(store, "task-1", "running");
		await store.appendEvent({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "execution_error",
			fromState: "running",
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
		const result = await orch.processTask("task-1");
		expect(result?.newState).toBe("archived");
		expect(client.deleteCalls).toHaveLength(0);
	});
});

// ===========================================================================
// Tests — Debug-preserve mode (PRD Section 15.11)
// ===========================================================================

describe("Teardown — debug-preserve mode", () => {
	it("skips instance deletion for failed tasks with debug-preserve", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "failed", { debugPreserve: true });
		await orch.processTask("task-1"); // failed -> teardown
		const result = await orch.processTask("task-1"); // teardown -> archived (skip delete)
		expect(result?.newState).toBe("archived");
		expect(client.deleteCalls).toHaveLength(0);
	});

	it("records teardown-skipped metadata in event", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "failed", { debugPreserve: true, instanceId: "inst-debug-123" });
		await orch.processTask("task-1");
		await orch.processTask("task-1");
		const evt = store._events.find((e) => e.taskId === "task-1" && e.trigger === "sandbox_terminated");
		expect(evt).toBeDefined();
		const meta = evt?.metadata as Record<string, unknown>;
		expect(meta?.teardownSkipped).toBe(true);
		expect(meta?.debugPreserve).toBe(true);
		expect(meta?.instanceId).toBe("inst-debug-123");
	});

	it("does NOT skip deletion for completed tasks even with debugPreserve", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		if (store._executions[0]?.remoteMetadata) {
			(store._executions[0] as any).remoteMetadata.debugPreserve = true;
		}
		await orch.processTask("task-1");
		await orch.processTask("task-1");
		expect(client.deleteCalls).toHaveLength(1);
	});

	it("does NOT skip deletion for canceled tasks even with debugPreserve", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "canceled");
		if (store._executions[0]?.remoteMetadata) {
			(store._executions[0] as any).remoteMetadata.debugPreserve = true;
		}
		await orch.processTask("task-1");
		await orch.processTask("task-1");
		expect(client.deleteCalls).toHaveLength(1);
	});
});

// ===========================================================================
// Tests — Retry with backoff
// ===========================================================================

describe("Teardown — retry with backoff", () => {
	it("retries instance deletion then succeeds", async () => {
		const store = createMockStore();
		const client = createMockClient({ deleteFailCount: 2 });
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		const result = await orch.processTask("task-1");
		expect(result?.newState).toBe("archived");
		expect(client.deleteCalls).toContain("inst-task-1");
	});

	it("proceeds to archived even when all retries exhausted", async () => {
		const store = createMockStore();
		const client = createMockClient({ deleteFailCount: 10 });
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		const result = await orch.processTask("task-1");
		expect(result?.newState).toBe("archived");
		expect(client.deleteCalls).toHaveLength(0);
	});

	it("treats 404 as successful teardown", async () => {
		const store = createMockStore();
		const err = new CloudInstanceClientError({ message: "Not found", statusCode: 404, retryable: false });
		const client = createMockClient({ deleteFailCount: 1, deleteFailError: err });
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		expect((await orch.processTask("task-1"))?.newState).toBe("archived");
	});

	it("treats 410 as successful teardown", async () => {
		const store = createMockStore();
		const err = new CloudInstanceClientError({ message: "Gone", statusCode: 410, retryable: false });
		const client = createMockClient({ deleteFailCount: 1, deleteFailError: err });
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		expect((await orch.processTask("task-1"))?.newState).toBe("archived");
	});

	it("uses exponential backoff between retries", async () => {
		const store = createMockStore();
		const client = createMockClient({ deleteFailCount: 10 });
		const delays: number[] = [];
		const cfg: OrchestratorConfig = {
			...FAST_CONFIG,
			teardownConfig: {
				maxRetries: 3,
				baseDelayMs: 100,
				maxDelayMs: 1000,
				delay: async (ms) => {
					delays.push(ms);
				},
			},
		};
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), cfg);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		await orch.processTask("task-1");
		expect(delays).toEqual([100, 200, 400]);
	});

	it("caps backoff delay at maxDelayMs", async () => {
		const store = createMockStore();
		const client = createMockClient({ deleteFailCount: 10 });
		const delays: number[] = [];
		const cfg: OrchestratorConfig = {
			...FAST_CONFIG,
			teardownConfig: {
				maxRetries: 3,
				baseDelayMs: 500,
				maxDelayMs: 600,
				delay: async (ms) => {
					delays.push(ms);
				},
			},
		};
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), cfg);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		await orch.processTask("task-1");
		expect(delays).toEqual([500, 600, 600]);
	});
});

// ===========================================================================
// Tests — Event persistence for teardown
// ===========================================================================

describe("Teardown — event persistence", () => {
	it("persists auto_teardown event", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		const before = store._events.length;
		await orch.processTask("task-1");
		expect(store._events.length).toBe(before + 1);
		const last = store._events[store._events.length - 1];
		expect(last.trigger).toBe("auto_teardown");
		expect(last.fromState).toBe("completed");
		expect(last.toState).toBe("teardown");
		expect(last.triggerSource).toBe("system");
	});

	it("persists sandbox_terminated event", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		const before = store._events.length;
		await orch.processTask("task-1");
		expect(store._events.length).toBe(before + 1);
		const last = store._events[store._events.length - 1];
		expect(last.trigger).toBe("sandbox_terminated");
		expect(last.fromState).toBe("teardown");
		expect(last.toState).toBe("archived");
	});

	it("each teardown event has a unique eventId", async () => {
		const store = createMockStore();
		const orch = new CloudExecutionOrchestrator(store, createMockClient(), createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		await orch.processTask("task-1");
		await orch.processTask("task-1");
		const ids = store._events.map((e) => e.eventId);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

// ===========================================================================
// Tests — Full lifecycle via processTick
// ===========================================================================

describe("Teardown — full lifecycle via processTick", () => {
	it("drives completed task through teardown to archived", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "task-1", "completed");
		const t1 = await orch.processTick();
		expect(t1).toHaveLength(1);
		expect(t1[0]?.newState).toBe("teardown");
		const t2 = await orch.processTick();
		expect(t2).toHaveLength(1);
		expect(t2[0]?.newState).toBe("archived");
		expect(await orch.processTick()).toHaveLength(0);
		expect(await store.deriveTaskState("task-1")).toBe("archived");
	});

	it("handles multiple terminal tasks concurrently", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const orch = new CloudExecutionOrchestrator(store, client, createMockRunInvoker(), FAST_CONFIG);
		await seedToTerminal(store, "a", "completed");
		await seedToTerminal(store, "b", "failed");
		await seedToTerminal(store, "c", "canceled");
		const t1 = await orch.processTick();
		expect(t1).toHaveLength(3);
		for (const r of t1) expect(r.newState).toBe("teardown");
		const t2 = await orch.processTick();
		expect(t2).toHaveLength(3);
		for (const r of t2) expect(r.newState).toBe("archived");
		expect(client.deleteCalls).toHaveLength(3);
	});
});

// ===========================================================================
// Tests — DEFAULT_TEARDOWN_CONFIG
// ===========================================================================

describe("DEFAULT_TEARDOWN_CONFIG", () => {
	it("has sensible defaults per PRD Section 15.6", () => {
		expect(DEFAULT_TEARDOWN_CONFIG.maxRetries).toBe(3);
		expect(DEFAULT_TEARDOWN_CONFIG.baseDelayMs).toBe(1_000);
		expect(DEFAULT_TEARDOWN_CONFIG.maxDelayMs).toBe(15_000);
	});
});
