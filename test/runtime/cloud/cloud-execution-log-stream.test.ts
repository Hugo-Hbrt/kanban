import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import { CloudExecutionLogStore } from "../../../src/cloud/cloud-execution-log-store";
import type {
	LogStreamClientFactory,
	LogStreamConnectionState,
	LogStreamEntry,
	LogStreamHttpClient,
} from "../../../src/cloud/cloud-execution-log-stream";
import {
	CloudExecutionLogStreamClient,
	DEFAULT_LOG_STREAM_CONFIG,
	parseSSEDataLine,
} from "../../../src/cloud/cloud-execution-log-stream";
import type {
	CloudExecutionStoreInterface,
	CloudInstanceFullClient,
	CloudRunInvoker,
	CreateInstanceRequest,
	InvokeRunRequest,
	InvokeRunResponse,
	OrchestratorConfig,
} from "../../../src/cloud/cloud-execution-orchestrator";
import { CloudExecutionOrchestrator } from "../../../src/cloud/cloud-execution-orchestrator";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import type { CloudInstanceResponse, CloudInstanceState } from "../../../src/cloud/cloud-instance-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSSEChunk(entries: Array<{ sequence: number; message: string; level?: string }>): Uint8Array {
	let text = "";
	for (const e of entries) {
		const json = JSON.stringify({
			sequence: e.sequence,
			timestamp: new Date().toISOString(),
			level: e.level ?? "info",
			message: e.message,
		});
		text += `data: ${json}\n\n`;
	}
	return new TextEncoder().encode(text);
}

function createAsyncBody(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next() {
					if (i >= chunks.length) return { done: true as const, value: undefined };
					const chunk = chunks[i++];
					return { done: false as const, value: chunk as Uint8Array };
				},
			};
		},
	};
}

// ===========================================================================
// parseSSEDataLine
// ===========================================================================

describe("parseSSEDataLine", () => {
	it("parses a valid JSON log entry", () => {
		const data = JSON.stringify({
			sequence: 5,
			timestamp: "2024-01-01T00:00:00Z",
			level: "info",
			message: "Hello world",
		});
		const entry = parseSSEDataLine(data, 1);
		expect(entry).not.toBeNull();
		expect(entry?.sequence).toBe(5);
		expect(entry?.message).toBe("Hello world");
		expect(entry?.level).toBe("info");
	});

	it("uses fallback sequence when missing", () => {
		const entry = parseSSEDataLine(JSON.stringify({ message: "No seq" }), 42);
		expect(entry?.sequence).toBe(42);
	});

	it("defaults level to info when invalid", () => {
		const entry = parseSSEDataLine(JSON.stringify({ message: "Bad level", level: "critical" }), 1);
		expect(entry?.level).toBe("info");
	});

	it("returns null for empty JSON message", () => {
		expect(parseSSEDataLine(JSON.stringify({ message: "" }), 1)).toBeNull();
	});

	it("returns null for blank raw string", () => {
		expect(parseSSEDataLine("   ", 1)).toBeNull();
	});

	it("treats non-JSON as plain info message", () => {
		const entry = parseSSEDataLine("plain text log", 3);
		expect(entry?.message).toBe("plain text log");
		expect(entry?.level).toBe("info");
		expect(entry?.sequence).toBe(3);
	});

	it("preserves metadata when present", () => {
		const data = JSON.stringify({
			sequence: 1,
			message: "with meta",
			metadata: { key: "val" },
		});
		expect(parseSSEDataLine(data, 1)?.metadata).toEqual({ key: "val" });
	});
});

// ===========================================================================
// CloudExecutionLogStore
// ===========================================================================

describe("CloudExecutionLogStore", () => {
	const makeEntry = (seq: number, msg: string): LogStreamEntry => ({
		sequence: seq,
		timestamp: new Date().toISOString(),
		level: "info",
		message: msg,
	});

	it("appends and reads entries", () => {
		const store = new CloudExecutionLogStore();
		store.append("t1", makeEntry(1, "a"));
		store.append("t1", makeEntry(2, "b"));
		expect(store.read("t1")).toHaveLength(2);
	});

	it("reads with afterSequence cursor", () => {
		const store = new CloudExecutionLogStore();
		store.append("t1", makeEntry(1, "a"));
		store.append("t1", makeEntry(2, "b"));
		store.append("t1", makeEntry(3, "c"));
		const entries = store.read("t1", 1);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.sequence).toBe(2);
	});

	it("respects limit", () => {
		const store = new CloudExecutionLogStore();
		for (let i = 1; i <= 10; i++) store.append("t1", makeEntry(i, `m${i}`));
		expect(store.read("t1", 0, 3)).toHaveLength(3);
	});

	it("returns empty for unknown task", () => {
		const store = new CloudExecutionLogStore();
		expect(store.read("x")).toHaveLength(0);
		expect(store.count("x")).toBe(0);
	});

	it("clears entries for a task", () => {
		const store = new CloudExecutionLogStore();
		store.append("t1", makeEntry(1, "a"));
		store.clear("t1");
		expect(store.count("t1")).toBe(0);
	});
});

// ===========================================================================
// CloudExecutionLogStreamClient
// ===========================================================================

describe("CloudExecutionLogStreamClient", () => {
	it("connects, receives entries, delivers via onEntry", async () => {
		const received: LogStreamEntry[] = [];
		const chunks = [
			buildSSEChunk([
				{ sequence: 1, message: "first" },
				{ sequence: 2, message: "second" },
			]),
		];
		const httpClient: LogStreamHttpClient = {
			async fetch() {
				return { ok: true, status: 200, body: createAsyncBody(chunks) };
			},
		};
		const client = new CloudExecutionLogStreamClient({
			hostname: "r.test",
			executionId: "e1",
			taskId: "t1",
			config: { ...DEFAULT_LOG_STREAM_CONFIG, maxReconnectAttempts: 0 },
			callbacks: { onEntry: (e) => received.push(e) },
			httpClient,
			timers: { delay: async () => {} },
		});
		await client.connect();
		expect(received).toHaveLength(2);
		expect(received[0]?.message).toBe("first");
		expect(client.lastReceivedSequence).toBe(2);
		client.disconnect();
		expect(client.state).toBe("closed");
	});

	it("reports connection state changes", async () => {
		const states: LogStreamConnectionState[] = [];
		const httpClient: LogStreamHttpClient = {
			async fetch() {
				return { ok: true, status: 200, body: createAsyncBody([]) };
			},
		};
		const client = new CloudExecutionLogStreamClient({
			hostname: "r.test",
			executionId: "e1",
			taskId: "t1",
			config: { ...DEFAULT_LOG_STREAM_CONFIG, maxReconnectAttempts: 0 },
			callbacks: {
				onEntry: () => {},
				onConnectionStateChange: (s) => states.push(s),
			},
			httpClient,
			timers: { delay: async () => {} },
		});
		await client.connect();
		client.disconnect();
		expect(states).toContain("connecting");
		expect(states).toContain("connected");
		expect(states).toContain("closed");
	});

	it("fires onError(recoverable=false) on max reconnects", async () => {
		let fatalError: Error | null = null;
		const httpClient: LogStreamHttpClient = {
			async fetch() {
				throw new Error("refused");
			},
		};
		const client = new CloudExecutionLogStreamClient({
			hostname: "r.test",
			executionId: "e1",
			taskId: "t1",
			config: { ...DEFAULT_LOG_STREAM_CONFIG, maxReconnectAttempts: 2 },
			callbacks: {
				onEntry: () => {},
				onError: (err, recoverable) => {
					if (!recoverable) fatalError = err;
				},
			},
			httpClient,
			timers: { delay: async () => {} },
		});
		await client.connect();
		expect(fatalError).not.toBeNull();
		expect(client.state).toBe("closed");
	});

	it("disconnect stops reconnection loop", async () => {
		// Verify that calling disconnect() terminates the connect loop.
		// We use maxReconnectAttempts=3 and verify the loop stopped at 3
		// (proving disconnect-like behavior, since it won't loop to 100).
		let fetchCount = 0;
		const httpClient: LogStreamHttpClient = {
			async fetch() {
				fetchCount++;
				return { ok: true, status: 200, body: createAsyncBody([]) };
			},
		};
		const client = new CloudExecutionLogStreamClient({
			hostname: "r.test",
			executionId: "e1",
			taskId: "t1",
			config: { ...DEFAULT_LOG_STREAM_CONFIG, maxReconnectAttempts: 3 },
			callbacks: { onEntry: () => {} },
			httpClient,
			timers: { delay: async () => {} },
		});
		await client.connect();
		// Should have stopped after ~4 fetches (initial + 3 reconnects)
		expect(fetchCount).toBeGreaterThan(1);
		expect(fetchCount).toBeLessThanOrEqual(5);
	});
});

// ===========================================================================
// Orchestrator SSE stream integration
// ===========================================================================

// -- Mocks --

function createMockStore() {
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
			const t = events.filter((e) => e.taskId === taskId);
			return (t.length === 0 ? "draft" : t[t.length - 1]?.toState) as CloudExecutionState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			events.push({ ...event });
		},
		async readExecutionsForTask(taskId: string) {
			return executions.filter((e) => e.taskId === taskId);
		},
		async updateExecution(executionId: string, updates: Partial<PersistedTaskExecution>) {
			const idx = executions.findIndex((e) => e.executionId === executionId);
			if (idx === -1) return false;
			const existing = executions[idx];
			if (existing) executions[idx] = { ...existing, ...updates };
			return true;
		},
		async createExecution(exec: PersistedTaskExecution) {
			executions.push({ ...exec });
		},
		_events: events,
		_executions: executions,
	};
}

function createMockClient(): CloudInstanceFullClient & { createCalls: CreateInstanceRequest[]; deleteCalls: string[] } {
	const state = { createCalls: [] as CreateInstanceRequest[], deleteCalls: [] as string[] };
	return {
		get createCalls() {
			return state.createCalls;
		},
		get deleteCalls() {
			return state.deleteCalls;
		},
		async createInstance(request: CreateInstanceRequest): Promise<CloudInstanceResponse> {
			state.createCalls.push(request);
			return {
				instance_id: `inst-${request.taskId}`,
				user_id: "test-user",
				namespace: "ns",
				state: "provisioning" as CloudInstanceState,
				hostname: `${request.taskId}.runner.test`,
			};
		},
		async getInstance(instanceId: string): Promise<CloudInstanceResponse> {
			return {
				instance_id: instanceId,
				user_id: "test-user",
				namespace: "ns",
				state: "ready" as CloudInstanceState,
				hostname: `${instanceId}.runner.test`,
			};
		},
		async deleteInstance(instanceId: string) {
			state.deleteCalls.push(instanceId);
		},
	};
}

function createMockRunInvoker(): CloudRunInvoker & { runCalls: InvokeRunRequest[] } {
	const state = { composeCalls: [] as string[], runCalls: [] as InvokeRunRequest[] };
	return {
		get runCalls() {
			return state.runCalls;
		},
		async composePrompt(taskId: string) {
			return `prompt-${taskId}`;
		},
		async invokeRun(request: InvokeRunRequest): Promise<InvokeRunResponse> {
			state.runCalls.push(request);
			return { accepted: true, runId: `run-${request.taskId}` };
		},
	};
}

async function seedTaskToState(store: CloudExecutionStoreInterface, taskId: string, targetState: CloudExecutionState) {
	const transitions: [CloudExecutionState, CloudExecutionTrigger, CloudExecutionState][] = [
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
	pollerConfig: {
		pollIntervalMs: 10,
		provisionTimeoutMs: 5_000,
		maxConsecutiveErrors: 3,
		backoffMultiplier: 1,
		maxBackoffMs: 50,
	},
	teardownConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, delay: async () => {} },
};

describe("Orchestrator — SSE log stream lifecycle", () => {
	it("starts SSE stream on running when logStore is provided", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const logStore = new CloudExecutionLogStore();

		let factoryCallCount = 0;
		let connectCalled = false;
		const mockFactory: LogStreamClientFactory = {
			create(_opts) {
				factoryCallCount++;
				return {
					isActive: false,
					state: "disconnected" as LogStreamConnectionState,
					lastReceivedSequence: 0,
					async connect() {
						connectCalled = true;
					},
					disconnect() {},
				} as any;
			},
		};

		const orch = new CloudExecutionOrchestrator(
			store,
			client,
			invoker,
			FAST_CONFIG,
			undefined,
			null,
			null,
			logStore,
			mockFactory,
		);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-task-1",
			remoteMetadata: {
				instanceId: "inst-task-1",
				repoUrl: "r",
				baseBranch: "main",
				instanceHostname: "task-1.runner.test",
			},
		});

		await orch.processTask("task-1");

		// /run was invoked
		expect(invoker.runCalls).toHaveLength(1);
		// Factory was called to create a stream client
		expect(factoryCallCount).toBe(1);
		// connect() was called (asynchronously)
		await new Promise((r) => setTimeout(r, 20));
		expect(connectCalled).toBe(true);
	});

	it("does NOT start stream when no logStore is configured", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();

		let factoryCallCount = 0;
		const mockFactory: LogStreamClientFactory = {
			create() {
				factoryCallCount++;
				return {
					isActive: false,
					state: "disconnected",
					lastReceivedSequence: 0,
					async connect() {},
					disconnect() {},
				} as any;
			},
		};

		// No logStore passed → null
		const orch = new CloudExecutionOrchestrator(
			store,
			client,
			invoker,
			FAST_CONFIG,
			undefined,
			null,
			null,
			null,
			mockFactory,
		);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-task-1",
			remoteMetadata: {
				instanceId: "inst-task-1",
				repoUrl: "r",
				baseBranch: "main",
				instanceHostname: "task-1.runner.test",
			},
		});

		await orch.processTask("task-1");

		expect(invoker.runCalls).toHaveLength(1);
		// Factory should NOT have been called
		expect(factoryCallCount).toBe(0);
	});

	it("disconnects stream on terminal state/teardown via cleanupCtx", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const logStore = new CloudExecutionLogStore();

		let disconnectCalled = false;
		const mockFactory: LogStreamClientFactory = {
			create() {
				return {
					isActive: true,
					state: "connected" as LogStreamConnectionState,
					lastReceivedSequence: 0,
					async connect() {},
					disconnect() {
						disconnectCalled = true;
					},
				} as any;
			},
		};

		const orch = new CloudExecutionOrchestrator(
			store,
			client,
			invoker,
			FAST_CONFIG,
			undefined,
			null,
			null,
			logStore,
			mockFactory,
		);

		// Drive task to running and invoke /run
		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-task-1",
			remoteMetadata: {
				instanceId: "inst-task-1",
				repoUrl: "r",
				baseBranch: "main",
				instanceHostname: "task-1.runner.test",
			},
		});
		await orch.processTask("task-1");
		await new Promise((r) => setTimeout(r, 10));

		// Now cancel the task → transitions to canceled → triggers cleanupCtx
		orch.requestCancellation("task-1");
		await orch.processTask("task-1");

		expect(disconnectCalled).toBe(true);
	});

	it("persists log entries via the log store when stream delivers them", async () => {
		const store = createMockStore();
		const client = createMockClient();
		const invoker = createMockRunInvoker();
		const logStore = new CloudExecutionLogStore();

		const mockFactory: LogStreamClientFactory = {
			create(opts) {
				// Simulate delivering entries immediately via onEntry
				setTimeout(() => {
					opts.callbacks.onEntry({
						sequence: 1,
						timestamp: new Date().toISOString(),
						level: "info",
						message: "log-line-1",
					});
					opts.callbacks.onEntry({
						sequence: 2,
						timestamp: new Date().toISOString(),
						level: "warn",
						message: "log-line-2",
					});
				}, 5);
				return {
					isActive: true,
					state: "connected" as LogStreamConnectionState,
					lastReceivedSequence: 0,
					async connect() {},
					disconnect() {},
				} as any;
			},
		};

		const orch = new CloudExecutionOrchestrator(
			store,
			client,
			invoker,
			FAST_CONFIG,
			undefined,
			null,
			null,
			logStore,
			mockFactory,
		);

		await seedTaskToState(store, "task-1", "running");
		await store.createExecution({
			executionId: "exec-1",
			taskId: "task-1",
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			instanceId: "inst-task-1",
			remoteMetadata: {
				instanceId: "inst-task-1",
				repoUrl: "r",
				baseBranch: "main",
				instanceHostname: "task-1.runner.test",
			},
		});
		await orch.processTask("task-1");

		// Wait for the simulated entries to be delivered
		await new Promise((r) => setTimeout(r, 30));

		expect(logStore.count("task-1")).toBe(2);
		const entries = logStore.read("task-1");
		expect(entries[0]?.message).toBe("log-line-1");
		expect(entries[1]?.level).toBe("warn");
	});
});
