import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	buildDedupeKey,
	type CallbackHeaders,
	type CallbackIngestionContext,
	type CallbackPayload,
	callbackPayloadSchema,
	DEFAULT_REPLAY_WINDOW_MS,
	extractCallbackHeaders,
	InMemoryCallbackDedupeStore,
	ingestTerminalCallback,
	mapCallbackStatusToTerminalState,
	mapCallbackStatusToTrigger,
	validateCallbackTimestamp,
	verifyCallbackSignature,
} from "../../../src/cloud/cloud-callback-ingestion";
import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createBasePayload(overrides: Partial<CallbackPayload> = {}): CallbackPayload {
	return {
		instanceId: "inst_abc",
		status: "success",
		task_id: "task-1",
		attempt_number: 1,
		pr_url: "https://github.com/org/repo/pull/42",
		task_output: "Task completed successfully.",
		error: "",
		...overrides,
	};
}

function createBaseHeaders(overrides: Partial<CallbackHeaders> = {}): CallbackHeaders {
	return {
		timestamp: null,
		signature: null,
		eventId: null,
		...overrides,
	};
}

function createFakeContext(
	overrides: Partial<CallbackIngestionContext> & {
		taskStates?: Record<string, CloudExecutionState>;
	} = {},
): CallbackIngestionContext {
	const dedupeStore = new InMemoryCallbackDedupeStore();
	const taskStates = overrides.taskStates ?? { "task-1": "running" };

	return {
		getTaskExecutionState: overrides.getTaskExecutionState ?? (async (taskId) => taskStates[taskId] ?? null),
		hasProcessedCallback: overrides.hasProcessedCallback ?? (async (key) => dedupeStore.has(key)),
		recordProcessedCallback: overrides.recordProcessedCallback ?? (async (key) => dedupeStore.add(key)),
		signingSecret: overrides.signingSecret ?? null,
		nowMs: overrides.nowMs,
		replayWindowMs: overrides.replayWindowMs,
	};
}

function toRawBody(payload: CallbackPayload): string {
	return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// callbackPayloadSchema
// ---------------------------------------------------------------------------

describe("callbackPayloadSchema", () => {
	it("accepts a valid full payload", () => {
		const result = callbackPayloadSchema.safeParse(createBasePayload());
		expect(result.success).toBe(true);
	});

	it("accepts a minimal payload", () => {
		const result = callbackPayloadSchema.safeParse({
			instanceId: "inst_1",
			status: "failed",
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing instanceId", () => {
		const result = callbackPayloadSchema.safeParse({ status: "success" });
		expect(result.success).toBe(false);
	});

	it("rejects invalid status", () => {
		const result = callbackPayloadSchema.safeParse({
			instanceId: "inst_1",
			status: "in_progress",
		});
		expect(result.success).toBe(false);
	});

	it("rejects empty instanceId", () => {
		const result = callbackPayloadSchema.safeParse({
			instanceId: "",
			status: "success",
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildDedupeKey
// ---------------------------------------------------------------------------

describe("buildDedupeKey", () => {
	it("builds composite key from identity fields", () => {
		const key = buildDedupeKey("inst_abc", "task-1", 1, "success");
		expect(key).toBe("inst_abc:task-1:1:success");
	});

	it("produces different keys for different statuses", () => {
		const key1 = buildDedupeKey("inst_abc", "task-1", 1, "success");
		const key2 = buildDedupeKey("inst_abc", "task-1", 1, "failed");
		expect(key1).not.toBe(key2);
	});

	it("produces different keys for different attempt numbers", () => {
		const key1 = buildDedupeKey("inst_abc", "task-1", 1, "success");
		const key2 = buildDedupeKey("inst_abc", "task-1", 2, "success");
		expect(key1).not.toBe(key2);
	});
});

// ---------------------------------------------------------------------------
// mapCallbackStatusToTrigger
// ---------------------------------------------------------------------------

describe("mapCallbackStatusToTrigger", () => {
	it("maps success to execution_done", () => {
		expect(mapCallbackStatusToTrigger("success")).toBe("execution_done");
	});

	it("maps failed to execution_error", () => {
		expect(mapCallbackStatusToTrigger("failed")).toBe("execution_error");
	});

	it("maps canceled to user_cancel", () => {
		expect(mapCallbackStatusToTrigger("canceled")).toBe("user_cancel");
	});
});

// ---------------------------------------------------------------------------
// mapCallbackStatusToTerminalState
// ---------------------------------------------------------------------------

describe("mapCallbackStatusToTerminalState", () => {
	it("maps success to completing", () => {
		expect(mapCallbackStatusToTerminalState("success")).toBe("completing");
	});

	it("maps failed to failed", () => {
		expect(mapCallbackStatusToTerminalState("failed")).toBe("failed");
	});

	it("maps canceled to canceled", () => {
		expect(mapCallbackStatusToTerminalState("canceled")).toBe("canceled");
	});
});

// ---------------------------------------------------------------------------
// extractCallbackHeaders
// ---------------------------------------------------------------------------

describe("extractCallbackHeaders", () => {
	it("extracts all three headers", () => {
		const headers = extractCallbackHeaders({
			"x-cline-timestamp": "2026-04-09T12:00:00Z",
			"x-cline-signature": "abc123",
			"x-cline-event-id": "evt-1",
		});
		expect(headers.timestamp).toBe("2026-04-09T12:00:00Z");
		expect(headers.signature).toBe("abc123");
		expect(headers.eventId).toBe("evt-1");
	});

	it("returns null for missing headers", () => {
		const headers = extractCallbackHeaders({});
		expect(headers.timestamp).toBeNull();
		expect(headers.signature).toBeNull();
		expect(headers.eventId).toBeNull();
	});

	it("handles array header values", () => {
		const headers = extractCallbackHeaders({
			"x-cline-event-id": ["evt-first", "evt-second"],
		});
		expect(headers.eventId).toBe("evt-first");
	});
});

// ---------------------------------------------------------------------------
// verifyCallbackSignature
// ---------------------------------------------------------------------------

describe("verifyCallbackSignature", () => {
	it("accepts any callback when no secret is configured (MVP stub)", () => {
		const result = verifyCallbackSignature("body", null, null);
		expect(result.valid).toBe(true);
	});

	it("accepts valid signature when secret is configured", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const expectedSig = createHash("sha256").update(`${secret}:${body}`).digest("hex");
		const result = verifyCallbackSignature(body, expectedSig, secret);
		expect(result.valid).toBe(true);
	});

	it("rejects missing signature when secret is configured", () => {
		const result = verifyCallbackSignature("body", null, "secret");
		expect(result.valid).toBe(false);
		if (result.valid === false) {
			expect(result.reason).toContain("Missing X-Cline-Signature");
		}
	});

	it("rejects wrong signature", () => {
		const result = verifyCallbackSignature("body", "wrong-sig", "secret");
		expect(result.valid).toBe(false);
		if (result.valid === false) {
			expect(result.reason).toContain("Invalid callback signature");
		}
	});
});

// ---------------------------------------------------------------------------
// validateCallbackTimestamp
// ---------------------------------------------------------------------------

describe("validateCallbackTimestamp", () => {
	const now = Date.parse("2026-04-09T12:00:00Z");

	it("accepts null timestamp (MVP compatibility)", () => {
		const result = validateCallbackTimestamp(null, now);
		expect(result.valid).toBe(true);
	});

	it("accepts a recent timestamp", () => {
		const recent = new Date(now - 60_000).toISOString();
		const result = validateCallbackTimestamp(recent, now);
		expect(result.valid).toBe(true);
	});

	it("rejects a timestamp too old", () => {
		const old = new Date(now - DEFAULT_REPLAY_WINDOW_MS - 10_000).toISOString();
		const result = validateCallbackTimestamp(old, now);
		expect(result.valid).toBe(false);
		if (result.valid === false) {
			expect(result.reason).toContain("too old");
		}
	});

	it("rejects a timestamp far in the future", () => {
		const future = new Date(now + 120_000).toISOString();
		const result = validateCallbackTimestamp(future, now);
		expect(result.valid).toBe(false);
		if (result.valid === false) {
			expect(result.reason).toContain("future");
		}
	});

	it("accepts a timestamp slightly in the future (clock skew)", () => {
		const slightFuture = new Date(now + 30_000).toISOString();
		const result = validateCallbackTimestamp(slightFuture, now);
		expect(result.valid).toBe(true);
	});

	it("rejects invalid timestamp format", () => {
		const result = validateCallbackTimestamp("not-a-date", now);
		expect(result.valid).toBe(false);
		if (result.valid === false) {
			expect(result.reason).toContain("Invalid X-Cline-Timestamp");
		}
	});

	it("respects custom replay window", () => {
		const twoMinAgo = new Date(now - 120_000).toISOString();
		// 60s window → should reject 120s-old timestamp
		const result = validateCallbackTimestamp(twoMinAgo, now, 60_000);
		expect(result.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — success path
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — success", () => {
	it("accepts a valid success callback for a running task", async () => {
		const payload = createBasePayload({ status: "success" });
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.taskId).toBe("task-1");
			expect(result.instanceId).toBe("inst_abc");
			expect(result.trigger).toBe("execution_done");
			expect(result.fromState).toBe("running");
			expect(result.toState).toBe("completing");
			expect(result.payload.pr_url).toBe("https://github.com/org/repo/pull/42");
		}
	});

	it("accepts a valid failed callback for a running task", async () => {
		const payload = createBasePayload({ status: "failed", error: "OOM killed" });
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.trigger).toBe("execution_error");
			expect(result.toState).toBe("failed");
			// PRD 15.11: failure output must be preserved
			expect(result.payload.error).toBe("OOM killed");
		}
	});

	it("accepts a valid canceled callback for a running task", async () => {
		const payload = createBasePayload({ status: "canceled" });
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.trigger).toBe("user_cancel");
			expect(result.toState).toBe("canceled");
		}
	});

	it("uses task_id from route identity over payload", async () => {
		const payload = createBasePayload({ task_id: "payload-task" });
		const ctx = createFakeContext({ taskStates: { "route-task": "running" } });
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders(),
			{ taskId: "route-task" },
			ctx,
		);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.taskId).toBe("route-task");
		}
	});

	it("falls back to payload task_id when route identity has none", async () => {
		const payload = createBasePayload({ task_id: "payload-task" });
		const ctx = createFakeContext({ taskStates: { "payload-task": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.taskId).toBe("payload-task");
		}
	});

	it("preserves event-id from headers in result", async () => {
		const payload = createBasePayload();
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ eventId: "evt-xyz" }),
			{},
			ctx,
		);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.eventId).toBe("evt-xyz");
		}
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — duplicate detection
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — duplicate detection", () => {
	it("rejects duplicate callback with same composite key", async () => {
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createFakeContext({
			taskStates: { "task-1": "running" },
			hasProcessedCallback: async (key) => dedupeStore.has(key),
			recordProcessedCallback: async (key) => dedupeStore.add(key),
		});
		const payload = createBasePayload();
		const body = toRawBody(payload);
		const headers = createBaseHeaders();

		// First call should succeed.
		const result1 = await ingestTerminalCallback(body, headers, {}, ctx);
		expect(result1.accepted).toBe(true);

		// Second call with same payload should be duplicate.
		const result2 = await ingestTerminalCallback(body, headers, {}, ctx);
		expect(result2.accepted).toBe(false);
		if (result2.accepted === false) {
			expect(result2.duplicate).toBe(true);
			expect(result2.httpStatus).toBe(200);
		}
	});

	it("rejects duplicate via idempotency_key", async () => {
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createFakeContext({
			taskStates: { "task-1": "running", "task-2": "running" },
			hasProcessedCallback: async (key) => dedupeStore.has(key),
			recordProcessedCallback: async (key) => dedupeStore.add(key),
		});

		const payload1 = createBasePayload({ idempotency_key: "idem-1" });
		const result1 = await ingestTerminalCallback(toRawBody(payload1), createBaseHeaders(), {}, ctx);
		expect(result1.accepted).toBe(true);

		// Different payload but same idempotency_key
		const payload2 = createBasePayload({
			task_id: "task-2",
			instanceId: "inst_different",
			idempotency_key: "idem-1",
		});
		const result2 = await ingestTerminalCallback(toRawBody(payload2), createBaseHeaders(), {}, ctx);
		expect(result2.accepted).toBe(false);
		if (result2.accepted === false) {
			expect(result2.duplicate).toBe(true);
		}
	});

	it("treats callback for already-terminal task as duplicate", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "completed" } });
		const payload = createBasePayload({ status: "success" });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.duplicate).toBe(true);
			expect(result.httpStatus).toBe(200);
			expect(result.reason).toContain("terminal state");
		}
	});

	it("treats callback for failed task as duplicate", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "failed" } });
		const payload = createBasePayload({ status: "failed" });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.duplicate).toBe(true);
		}
	});

	it("treats callback for canceled task as duplicate", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "canceled" } });
		const payload = createBasePayload({ status: "canceled" });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.duplicate).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — invalid payloads
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — invalid payloads", () => {
	it("rejects invalid JSON body", async () => {
		const ctx = createFakeContext();
		const result = await ingestTerminalCallback("not json{", createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(400);
			expect(result.reason).toContain("Invalid JSON");
		}
	});

	it("rejects payload with missing required fields", async () => {
		const ctx = createFakeContext();
		const result = await ingestTerminalCallback(JSON.stringify({ status: "success" }), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(400);
			expect(result.reason).toContain("Invalid callback payload");
		}
	});

	it("rejects payload with invalid status value", async () => {
		const ctx = createFakeContext();
		const result = await ingestTerminalCallback(
			JSON.stringify({ instanceId: "inst_1", status: "pending" }),
			createBaseHeaders(),
			{},
			ctx,
		);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(400);
		}
	});

	it("rejects when task_id is missing from both route and payload", async () => {
		const ctx = createFakeContext();
		const payload = createBasePayload();
		delete (payload as Record<string, unknown>).task_id;
		const result = await ingestTerminalCallback(JSON.stringify(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(400);
			expect(result.reason).toContain("Missing task_id");
		}
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — unknown task rejection
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — unknown task", () => {
	it("rejects callback for unknown task_id", async () => {
		const ctx = createFakeContext({ taskStates: {} });
		const payload = createBasePayload({ task_id: "nonexistent" });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(404);
			expect(result.reason).toContain("Unknown task");
		}
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — invalid state transitions
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — invalid state transitions", () => {
	it("rejects callback for task in draft state", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "draft" } });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.duplicate).toBe(false);
			expect(result.httpStatus).toBe(409);
			expect(result.reason).toContain("Invalid state transition");
		}
	});

	it("rejects callback for task in provisioning state", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "provisioning" } });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(409);
		}
	});

	it("rejects callback for task in teardown state", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "teardown" } });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(409);
		}
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — replay protection
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — replay protection", () => {
	it("rejects callback with stale timestamp", async () => {
		const now = Date.parse("2026-04-09T12:00:00Z");
		const staleTimestamp = new Date(now - DEFAULT_REPLAY_WINDOW_MS - 60_000).toISOString();
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, nowMs: now });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ timestamp: staleTimestamp }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(401);
			expect(result.reason).toContain("too old");
		}
	});

	it("rejects callback with future timestamp", async () => {
		const now = Date.parse("2026-04-09T12:00:00Z");
		const futureTimestamp = new Date(now + 120_000).toISOString();
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, nowMs: now });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ timestamp: futureTimestamp }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(401);
			expect(result.reason).toContain("future");
		}
	});

	it("accepts callback with valid recent timestamp", async () => {
		const now = Date.parse("2026-04-09T12:00:00Z");
		const recentTimestamp = new Date(now - 30_000).toISOString();
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, nowMs: now });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ timestamp: recentTimestamp }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — signature verification
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — signature verification", () => {
	it("rejects callback with invalid signature when secret is set", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: "test-secret" });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ signature: "bad-sig" }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(401);
			expect(result.reason).toContain("Invalid callback signature");
		}
	});

	it("rejects callback with missing signature when secret is set", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: "test-secret" });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(401);
			expect(result.reason).toContain("Missing X-Cline-Signature");
		}
	});

	it("accepts callback with correct signature", async () => {
		const secret = "test-secret";
		const payload = createBasePayload();
		const body = toRawBody(payload);
		const validSig = createHash("sha256").update(`${secret}:${body}`).digest("hex");
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: secret });
		const result = await ingestTerminalCallback(body, createBaseHeaders({ signature: validSig }), {}, ctx);
		expect(result.accepted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — failure preservation (PRD 15.11)
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — failure preservation (PRD 15.11)", () => {
	it("preserves error output in accepted result payload", async () => {
		const errorOutput = "Execution failed: segmentation fault at 0x00000001";
		const payload = createBasePayload({
			status: "failed",
			error: errorOutput,
			task_output: "Partial output before crash",
		});
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.payload.error).toBe(errorOutput);
			expect(result.payload.task_output).toBe("Partial output before crash");
		}
	});

	it("preserves empty error string without discarding", async () => {
		const payload = createBasePayload({ status: "failed", error: "", task_output: "" });
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.payload.error).toBe("");
			expect(result.payload.task_output).toBe("");
		}
	});

	it("preserves metadata fields (duration, tokens, PR URL)", async () => {
		const payload = createBasePayload({
			status: "success",
			pr_url: "https://github.com/org/repo/pull/99",
			duration_seconds: 120,
			tokens_used: 5000,
		});
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.payload.pr_url).toBe("https://github.com/org/repo/pull/99");
			expect(result.payload.duration_seconds).toBe(120);
			expect(result.payload.tokens_used).toBe(5000);
		}
	});
});

// ---------------------------------------------------------------------------
// InMemoryCallbackDedupeStore
// ---------------------------------------------------------------------------

describe("InMemoryCallbackDedupeStore", () => {
	it("tracks added keys", () => {
		const store = new InMemoryCallbackDedupeStore();
		store.add("key-1");
		expect(store.has("key-1")).toBe(true);
		expect(store.has("key-2")).toBe(false);
	});

	it("reports correct size", () => {
		const store = new InMemoryCallbackDedupeStore();
		expect(store.size).toBe(0);
		store.add("a");
		store.add("b");
		expect(store.size).toBe(2);
	});

	it("evicts oldest entry when at capacity", () => {
		const store = new InMemoryCallbackDedupeStore(3);
		store.add("a");
		store.add("b");
		store.add("c");
		expect(store.size).toBe(3);
		store.add("d");
		expect(store.size).toBe(3);
		expect(store.has("a")).toBe(false);
		expect(store.has("d")).toBe(true);
	});

	it("clears all entries", () => {
		const store = new InMemoryCallbackDedupeStore();
		store.add("x");
		store.add("y");
		store.clear();
		expect(store.size).toBe(0);
		expect(store.has("x")).toBe(false);
	});
});
