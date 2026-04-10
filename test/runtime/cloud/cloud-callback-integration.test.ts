import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLOUD_CALLBACK_PATH, handleCloudCallback } from "../../../src/cloud/cloud-callback-handler";
import {
	buildCanonicalSigningInput,
	type CallbackHeaders,
	type CallbackIngestionContext,
	type CallbackPayload,
	InMemoryCallbackDedupeStore,
	ingestTerminalCallback,
} from "../../../src/cloud/cloud-callback-ingestion";
import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import {
	CloudExecutionStore,
	type EventTriggerSource,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
	type RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import {
	reconcileTerminalCallback,
	type TerminalReconciliationContext,
} from "../../../src/cloud/cloud-terminal-reconciliation";
import { createTempDir } from "../../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

let tempDir: { path: string; cleanup: () => void };
let store: CloudExecutionStore;

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	return {
		eventId: randomUUID(),
		taskId: "task-001",
		trigger: "submit",
		fromState: "draft",
		toState: "queued",
		timestamp: new Date().toISOString(),
		triggerSource: "system" as EventTriggerSource,
		...overrides,
	};
}

function makeExecution(overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId: "task-001",
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeRemoteMetadata(overrides: Partial<RemoteExecutionMetadata> = {}): RemoteExecutionMetadata {
	return {
		instanceId: "inst-abc123",
		repoUrl: "https://github.com/cline/kanban.git",
		baseBranch: "main",
		debugPreserve: false,
		...overrides,
	};
}

function createBasePayload(overrides: Partial<CallbackPayload> = {}): CallbackPayload {
	return {
		instanceId: "inst-abc123",
		status: "success",
		task_id: "task-001",
		attempt_number: 1,
		pr_url: "https://github.com/org/repo/pull/42",
		task_output: "All tests passed.",
		...overrides,
	};
}

function createBaseHeaders(overrides: Partial<CallbackHeaders> = {}): CallbackHeaders {
	return { timestamp: null, signature: null, eventId: null, ...overrides };
}

function createIngestionContext(
	storeRef: CloudExecutionStore,
	dedupeStore: InMemoryCallbackDedupeStore,
	overrides: Partial<CallbackIngestionContext> = {},
): CallbackIngestionContext {
	return {
		getTaskExecutionState: async (taskId: string): Promise<CloudExecutionState | null> => {
			try {
				return await storeRef.deriveTaskState(taskId);
			} catch {
				return null;
			}
		},
		hasProcessedCallback: async (key: string) => dedupeStore.has(key),
		recordProcessedCallback: async (key: string) => {
			dedupeStore.add(key);
		},
		signingSecret: overrides.signingSecret ?? null,
		...overrides,
	};
}

function createReconciliationContext(storeRef: CloudExecutionStore): TerminalReconciliationContext {
	return {
		deriveTaskState: (taskId) => storeRef.deriveTaskState(taskId),
		appendEvent: (event) => storeRef.appendEvent(event),
		appendEvents: (events) => storeRef.appendEvents(events),
		readExecutionsForTask: (taskId) => storeRef.readExecutionsForTask(taskId),
		updateExecution: (executionId, updates) => storeRef.updateExecution(executionId, updates),
	};
}

async function seedTaskToRunning(storeRef: CloudExecutionStore, taskId: string, instanceId: string): Promise<void> {
	const events: PersistedTaskEvent[] = [
		makeEvent({ taskId, trigger: "submit", fromState: "draft", toState: "queued", triggerSource: "user" }),
		makeEvent({ taskId, trigger: "dequeue", fromState: "queued", toState: "policy_check", triggerSource: "system" }),
		makeEvent({
			taskId,
			trigger: "authorized",
			fromState: "policy_check",
			toState: "provisioning",
			triggerSource: "system",
		}),
		makeEvent({
			taskId,
			trigger: "sandbox_ready",
			fromState: "provisioning",
			toState: "running",
			triggerSource: "callback",
		}),
	];
	await storeRef.appendEvents(events);
	await storeRef.createExecution(
		makeExecution({ taskId, instanceId, remoteMetadata: makeRemoteMetadata({ instanceId }) }),
	);
}

beforeEach(() => {
	tempDir = createTempDir("kanban-cloud-callback-integration-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("cloud callback integration — real persistence round-trip", () => {
	it("ingests a success callback, reconciles state, and updates the execution record", async () => {
		const taskId = "task-001";
		const instanceId = "inst-abc123";
		await seedTaskToRunning(store, taskId, instanceId);
		expect(await store.deriveTaskState(taskId)).toBe("running");

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);
		const payload = createBasePayload({
			instanceId,
			status: "success",
			task_id: taskId,
			pr_url: "https://github.com/org/repo/pull/42",
			duration_seconds: 120,
			tokens_used: 5000,
		});
		const ingestionResult = await ingestTerminalCallback(
			JSON.stringify(payload),
			createBaseHeaders({ eventId: "evt-cb" }),
			{},
			ctx,
		);
		expect(ingestionResult.accepted).toBe(true);
		if (!ingestionResult.accepted) throw new Error("Expected accepted");
		expect(ingestionResult.trigger).toBe("execution_done");
		expect(ingestionResult.fromState).toBe("running");
		expect(ingestionResult.toState).toBe("completing");

		const reconResult = await reconcileTerminalCallback(ingestionResult, createReconciliationContext(store));
		expect(reconResult.reconciled).toBe(true);
		if (!reconResult.reconciled) throw new Error("Expected reconciled");
		expect(reconResult.executionUpdated).toBe(true);

		expect(["completing", "teardown"]).toContain(await store.deriveTaskState(taskId));
		const executions = await store.readExecutionsForTask(taskId);
		expect(executions).toHaveLength(1);
		expect(executions[0]?.terminalState).toBe("completing");
		expect(executions[0]?.completedAt).toBeTruthy();
		expect(executions[0]?.resultSummary).toContain("status=success");
		expect(executions[0]?.resultSummary).toContain("duration=120s");
		expect(executions[0]?.resultSummary).toContain("tokens=5000");
	});

	it("preserves error output through ingestion + reconciliation (PRD 15.11)", async () => {
		const taskId = "task-fail";
		const instanceId = "inst-fail";
		await seedTaskToRunning(store, taskId, instanceId);

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);
		const payload = createBasePayload({ instanceId, status: "failed", task_id: taskId, error: "OOM killed" });
		const result = await ingestTerminalCallback(JSON.stringify(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (!result.accepted) throw new Error("Expected accepted");
		expect(result.payload.error).toBe("OOM killed");

		await reconcileTerminalCallback(result, createReconciliationContext(store));
		const executions = await store.readExecutionsForTask(taskId);
		expect(executions[0]?.resultSummary).toContain("error=OOM killed");
		expect(executions[0]?.terminalState).toBe("failed");
	});

	it("deduplicates replayed callbacks using the in-memory dedupe store", async () => {
		const taskId = "task-dedup";
		const instanceId = "inst-dedup";
		await seedTaskToRunning(store, taskId, instanceId);

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);
		const body = JSON.stringify(createBasePayload({ instanceId, status: "success", task_id: taskId }));

		const result1 = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);
		expect(result1.accepted).toBe(true);

		const result2 = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);
		expect(result2.accepted).toBe(false);
		if (!result2.accepted) {
			expect(result2.duplicate).toBe(true);
			expect(result2.httpStatus).toBe(200);
		}
	});

	it("deduplicates via idempotency_key across different payloads", async () => {
		const taskId1 = "task-idem-1";
		const taskId2 = "task-idem-2";
		await seedTaskToRunning(store, taskId1, "inst-idem");
		await seedTaskToRunning(store, taskId2, "inst-idem");

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);

		const p1 = createBasePayload({
			instanceId: "inst-idem",
			status: "success",
			task_id: taskId1,
			idempotency_key: "idem-key",
		});
		expect((await ingestTerminalCallback(JSON.stringify(p1), createBaseHeaders(), {}, ctx)).accepted).toBe(true);

		const p2 = createBasePayload({
			instanceId: "inst-other",
			status: "success",
			task_id: taskId2,
			idempotency_key: "idem-key",
		});
		const result2 = await ingestTerminalCallback(JSON.stringify(p2), createBaseHeaders(), {}, ctx);
		expect(result2.accepted).toBe(false);
		if (!result2.accepted) expect(result2.duplicate).toBe(true);
	});

	it("enforces signature verification when signingSecret is configured", async () => {
		const taskId = "task-sig";
		const secret = "test-signing-secret-42";
		await seedTaskToRunning(store, taskId, "inst-sig");

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore, { signingSecret: secret });
		const body = JSON.stringify(createBasePayload({ instanceId: "inst-sig", status: "success", task_id: taskId }));
		const ts = new Date().toISOString();
		const evtId = "evt-sig-test";

		// No signature → 401
		const r1 = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);
		expect(r1.accepted).toBe(false);
		if (!r1.accepted) expect(r1.httpStatus).toBe(401);

		// Wrong signature → 401
		const r2 = await ingestTerminalCallback(
			body,
			createBaseHeaders({ signature: "wrong", timestamp: ts, eventId: evtId }),
			{},
			ctx,
		);
		expect(r2.accepted).toBe(false);
		if (!r2.accepted) expect(r2.httpStatus).toBe(401);

		// Correct canonical HMAC-SHA256 signature → accepted
		const canonicalInput = buildCanonicalSigningInput(ts, evtId, body);
		const sig = createHmac("sha256", secret).update(canonicalInput).digest("hex");
		const r3 = await ingestTerminalCallback(
			body,
			createBaseHeaders({ signature: sig, timestamp: ts, eventId: evtId }),
			{},
			ctx,
		);
		expect(r3.accepted).toBe(true);
	});

	it("persists events through reconciliation and survives store restart", async () => {
		const taskId = "task-persist";
		await seedTaskToRunning(store, taskId, "inst-persist");

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);
		const payload = createBasePayload({ instanceId: "inst-persist", status: "success", task_id: taskId });
		const result = await ingestTerminalCallback(JSON.stringify(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (!result.accepted) throw new Error("Expected accepted");

		await reconcileTerminalCallback(result, createReconciliationContext(store));

		// "Restart" — new store instance from same path
		const recovered = new CloudExecutionStore(tempDir.path);
		expect(["completing", "teardown"]).toContain(await recovered.deriveTaskState(taskId));
		expect((await recovered.readEventsForTask(taskId)).length).toBeGreaterThanOrEqual(5);
		const executions = await recovered.readExecutionsForTask(taskId);
		expect(executions[0]?.terminalState).toBe("completing");
		expect(executions[0]?.resultSummary).toContain("status=success");
	});

	it("reconciliation is idempotent — re-reconciling a failed task is a safe no-op", async () => {
		const taskId = "task-idempotent";
		await seedTaskToRunning(store, taskId, "inst-idempotent");

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);
		// Use "failed" status — "failed" is a terminal state, so auto_teardown fires
		// and the second reconciliation finds the task in teardown (idempotent no-op).
		const payload = createBasePayload({
			instanceId: "inst-idempotent",
			status: "failed",
			task_id: taskId,
			error: "test",
		});
		const result = await ingestTerminalCallback(JSON.stringify(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (!result.accepted) throw new Error("Expected accepted");

		const reconCtx = createReconciliationContext(store);
		const r1 = await reconcileTerminalCallback(result, reconCtx);
		expect(r1.reconciled).toBe(true);

		// After reconciliation, state should be "teardown" (failed → auto_teardown)
		expect(await store.deriveTaskState(taskId)).toBe("teardown");

		// Second reconciliation should be idempotent no-op
		const r2 = await reconcileTerminalCallback(result, reconCtx);
		expect(r2.reconciled).toBe(false);
		if (!r2.reconciled) expect(r2.idempotentNoOp).toBe(true);
	});

	it("full canceled lifecycle: callback → reconcile → teardown", async () => {
		const taskId = "task-cancel";
		await seedTaskToRunning(store, taskId, "inst-cancel");

		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createIngestionContext(store, dedupeStore);
		const payload = createBasePayload({ instanceId: "inst-cancel", status: "canceled", task_id: taskId });
		const result = await ingestTerminalCallback(JSON.stringify(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (!result.accepted) throw new Error("Expected accepted");
		expect(result.trigger).toBe("user_cancel");
		expect(result.toState).toBe("canceled");

		const recon = await reconcileTerminalCallback(result, createReconciliationContext(store));
		expect(recon.reconciled).toBe(true);
		if (!recon.reconciled) throw new Error("Expected reconciled");
		expect(recon.teardownTriggered).toBe(true);
		expect(await store.deriveTaskState(taskId)).toBe("teardown");

		const executions = await store.readExecutionsForTask(taskId);
		expect(executions[0]?.terminalState).toBe("canceled");
		expect(executions[0]?.resultSummary).toContain("status=canceled");
	});

	it("rejects callback for task with no events in the store (unknown task)", async () => {
		const ctx: CallbackIngestionContext = {
			getTaskExecutionState: async () => null,
			hasProcessedCallback: async () => false,
			recordProcessedCallback: async () => {},
			signingSecret: null,
		};
		const payload = createBasePayload({ task_id: "nonexistent" });
		const result = await ingestTerminalCallback(JSON.stringify(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(false);
		if (!result.accepted) {
			expect(result.httpStatus).toBe(404);
			expect(result.reason).toContain("Unknown task");
		}
	});
});

// ---------------------------------------------------------------------------
// HTTP Handler Integration Tests (handleCloudCallback)
// ---------------------------------------------------------------------------

function createMockRequest(
	body: string,
	method = "POST",
	url = CLOUD_CALLBACK_PATH,
	headers: Record<string, string> = {},
): IncomingMessage {
	const readable = new Readable({
		read() {
			this.push(Buffer.from(body, "utf8"));
			this.push(null);
		},
	});
	(readable as unknown as Record<string, unknown>).method = method;
	(readable as unknown as Record<string, unknown>).url = url;
	(readable as unknown as Record<string, unknown>).headers = {
		"content-type": "application/json",
		...headers,
	} as IncomingHttpHeaders;
	return readable as unknown as IncomingMessage;
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getBody: () => string;
} {
	let status = 0;
	let body = "";
	const res = new EventEmitter() as unknown as ServerResponse;
	(res as unknown as Record<string, unknown>).headersSent = false;
	res.writeHead = ((statusCode: number, _headers?: Record<string, string>) => {
		status = statusCode;
		(res as unknown as Record<string, unknown>).headersSent = true;
		return res;
	}) as ServerResponse["writeHead"];
	res.end = ((chunk?: string) => {
		if (chunk) body += chunk;
		return res;
	}) as ServerResponse["end"];
	return { res, getStatus: () => status, getBody: () => body };
}

function computeCanonicalHmac(
	secret: string,
	body: string,
	timestamp: string | null = null,
	eventId: string | null = null,
): string {
	const input = buildCanonicalSigningInput(timestamp, eventId, body);
	return createHmac("sha256", secret).update(input).digest("hex");
}

function createHandlerCtx(
	taskStates: Record<string, CloudExecutionState>,
	dedupeStore: InMemoryCallbackDedupeStore,
	signingSecret: string | null = null,
): CallbackIngestionContext {
	return {
		getTaskExecutionState: async (taskId) => taskStates[taskId] ?? null,
		hasProcessedCallback: async (key) => dedupeStore.has(key),
		recordProcessedCallback: async (key) => {
			dedupeStore.add(key);
		},
		signingSecret,
	};
}

describe("cloud callback HTTP handler — handleCloudCallback", () => {
	it("callback with valid HMAC returns 200 and updates execution state", async () => {
		const secret = "test-handler-secret";
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createHandlerCtx({ "task-http-1": "running" }, dedupeStore, secret);

		const payload = createBasePayload({ task_id: "task-http-1", status: "success" });
		const body = JSON.stringify(payload);
		const ts = new Date().toISOString();
		const evtId = "evt-handler-1";
		const sig = computeCanonicalHmac(secret, body, ts, evtId);

		const req = createMockRequest(body, "POST", CLOUD_CALLBACK_PATH, {
			"x-cline-timestamp": ts,
			"x-cline-signature": sig,
			"x-cline-event-id": evtId,
		});
		const requestUrl = new URL(CLOUD_CALLBACK_PATH, "http://localhost");
		const { res, getStatus, getBody } = createMockResponse();

		let acceptedResult: unknown = null;
		const handled = await handleCloudCallback(req, res, requestUrl, ctx, async (result) => {
			acceptedResult = result;
		});

		expect(handled).toBe(true);
		expect(getStatus()).toBe(200);
		const parsed = JSON.parse(getBody());
		expect(parsed.ok).toBe(true);
		expect(parsed.taskId).toBe("task-http-1");
		expect(parsed.toState).toBe("completing");
		expect(acceptedResult).not.toBeNull();
	});

	it("duplicate callback returns 200 with duplicate:true", async () => {
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createHandlerCtx({ "task-dup": "running" }, dedupeStore);
		const payload = createBasePayload({ task_id: "task-dup", status: "success" });
		const body = JSON.stringify(payload);

		// First request — accepted
		const req1 = createMockRequest(body);
		const mock1 = createMockResponse();
		await handleCloudCallback(req1, mock1.res, new URL(CLOUD_CALLBACK_PATH, "http://localhost"), ctx);
		expect(mock1.getStatus()).toBe(200);
		expect(JSON.parse(mock1.getBody()).ok).toBe(true);

		// Second request — duplicate
		const req2 = createMockRequest(body);
		const mock2 = createMockResponse();
		await handleCloudCallback(req2, mock2.res, new URL(CLOUD_CALLBACK_PATH, "http://localhost"), ctx);

		expect(mock2.getStatus()).toBe(200);
		const parsed = JSON.parse(mock2.getBody());
		expect(parsed.ok).toBe(true);
		expect(parsed.duplicate).toBe(true);
	});

	it("callback for unknown task returns 404", async () => {
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createHandlerCtx({}, dedupeStore);
		const body = JSON.stringify(createBasePayload({ task_id: "nonexistent-task" }));

		const req = createMockRequest(body);
		const { res, getStatus, getBody } = createMockResponse();
		await handleCloudCallback(req, res, new URL(CLOUD_CALLBACK_PATH, "http://localhost"), ctx);

		expect(getStatus()).toBe(404);
		expect(JSON.parse(getBody()).error).toContain("Unknown task");
	});
	it("callback with invalid signature returns 401", async () => {
		const secret = "handler-signing-secret";
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createHandlerCtx({ "task-sig": "running" }, dedupeStore, secret);

		const body = JSON.stringify(createBasePayload({ task_id: "task-sig", status: "success" }));
		const ts = new Date().toISOString();
		const req = createMockRequest(body, "POST", CLOUD_CALLBACK_PATH, {
			"x-cline-timestamp": ts,
			"x-cline-signature": "invalid-signature-value",
			"x-cline-event-id": "evt-bad",
		});
		const { res, getStatus, getBody } = createMockResponse();
		await handleCloudCallback(req, res, new URL(CLOUD_CALLBACK_PATH, "http://localhost"), ctx);

		expect(getStatus()).toBe(401);
		expect(JSON.parse(getBody()).error).toContain("Invalid callback signature");
	});

	it("oversized body returns 400", async () => {
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createHandlerCtx({ "task-big": "running" }, dedupeStore);

		// 65 KB exceeds the 64 KB MAX_CALLBACK_BODY_BYTES limit
		const oversizedBody = "x".repeat(65 * 1024);
		const req = createMockRequest(oversizedBody);
		const { res, getStatus, getBody } = createMockResponse();
		await handleCloudCallback(req, res, new URL(CLOUD_CALLBACK_PATH, "http://localhost"), ctx);

		expect(getStatus()).toBe(400);
		expect(JSON.parse(getBody()).error).toContain("oversized");
	});
});
