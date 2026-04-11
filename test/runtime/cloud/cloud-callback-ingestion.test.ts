import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	buildCanonicalSigningInput,
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
		taskId: "task-1",
		attemptNumber: 1,
		prUrl: "https://github.com/org/repo/pull/42",
		taskOutput: "Task completed successfully.",
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
		resolveTaskIdByInstanceId: overrides.resolveTaskIdByInstanceId,
	};
}

function toRawBody(payload: CallbackPayload): string {
	return JSON.stringify(payload);
}

/**
 * Compute HMAC-SHA256 signature over the canonical signing input
 * (`timestamp.eventId.body`) — matches cloud-platform's signing format.
 */
function computeCanonicalHmac(
	secret: string,
	body: string,
	timestamp: string | null = null,
	eventId: string | null = null,
): string {
	const canonicalInput = buildCanonicalSigningInput(timestamp, eventId, body);
	return createHmac("sha256", secret).update(canonicalInput).digest("hex");
}

// ---------------------------------------------------------------------------
// callbackPayloadSchema
// ---------------------------------------------------------------------------

describe("callbackPayloadSchema", () => {
	it("accepts a valid full payload (camelCase)", () => {
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

	it("accepts snake_case fields and normalises to camelCase", () => {
		const result = callbackPayloadSchema.safeParse({
			instance_id: "inst_snake",
			status: "success",
			task_id: "task-s",
			attempt_number: 2,
			pr_url: "https://pr",
			task_output: "out",
			duration_seconds: 10,
			tokens_used: 500,
			idempotency_key: "idem-s",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.instanceId).toBe("inst_snake");
			expect(result.data.taskId).toBe("task-s");
			expect(result.data.attemptNumber).toBe(2);
			expect(result.data.prUrl).toBe("https://pr");
			expect(result.data.taskOutput).toBe("out");
			expect(result.data.durationSeconds).toBe(10);
			expect(result.data.tokensUsed).toBe(500);
			expect(result.data.idempotencyKey).toBe("idem-s");
		}
	});

	it("accepts instance_id when instanceId is absent", () => {
		const result = callbackPayloadSchema.safeParse({
			instance_id: "inst_from_snake",
			status: "success",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.instanceId).toBe("inst_from_snake");
		}
	});

	it("prefers camelCase over snake_case when both present", () => {
		const result = callbackPayloadSchema.safeParse({
			instanceId: "camel",
			instance_id: "snake",
			status: "success",
			taskId: "camelTask",
			task_id: "snakeTask",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.instanceId).toBe("camel");
			expect(result.data.taskId).toBe("camelTask");
		}
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
	it("extracts all three headers (x-cline-* primary)", () => {
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

	it("falls back to x-callback-timestamp", () => {
		const headers = extractCallbackHeaders({
			"x-callback-timestamp": "1718000000",
		});
		expect(headers.timestamp).toBe("1718000000");
	});

	it("falls back to x-callback-signature", () => {
		const headers = extractCallbackHeaders({
			"x-callback-signature": "hmac-sha256=abc",
		});
		expect(headers.signature).toBe("hmac-sha256=abc");
	});

	it("falls back to x-request-id for eventId", () => {
		const headers = extractCallbackHeaders({
			"x-request-id": "req-uuid",
		});
		expect(headers.eventId).toBe("req-uuid");
	});

	it("falls back to x-request-timestamp", () => {
		const headers = extractCallbackHeaders({
			"x-request-timestamp": "2026-04-10T00:00:00Z",
		});
		expect(headers.timestamp).toBe("2026-04-10T00:00:00Z");
	});

	it("falls back to x-idempotency-key for eventId", () => {
		const headers = extractCallbackHeaders({
			"x-idempotency-key": "idem-123",
		});
		expect(headers.eventId).toBe("idem-123");
	});

	it("prefers x-cline-* over x-callback-* when both present", () => {
		const headers = extractCallbackHeaders({
			"x-cline-signature": "cline-sig",
			"x-callback-signature": "callback-sig",
			"x-cline-timestamp": "cline-ts",
			"x-callback-timestamp": "callback-ts",
		});
		expect(headers.signature).toBe("cline-sig");
		expect(headers.timestamp).toBe("cline-ts");
	});
});

// ---------------------------------------------------------------------------
// verifyCallbackSignature
// ---------------------------------------------------------------------------

describe("buildCanonicalSigningInput", () => {
	it("builds three-segment canonical string with all fields", () => {
		expect(buildCanonicalSigningInput("2026-04-09T12:00:00Z", "evt-1", '{"ok":true}')).toBe(
			'2026-04-09T12:00:00Z.evt-1.{"ok":true}',
		);
	});

	it("uses empty strings for null timestamp and eventId", () => {
		expect(buildCanonicalSigningInput(null, null, "body")).toBe("..body");
	});

	it("uses empty string for null eventId only", () => {
		expect(buildCanonicalSigningInput("ts", null, "body")).toBe("ts..body");
	});

	it("uses empty string for null timestamp only", () => {
		expect(buildCanonicalSigningInput(null, "evt", "body")).toBe(".evt.body");
	});
});

describe("verifyCallbackSignature", () => {
	const ts = "2026-04-09T12:00:00Z";
	const evtId = "evt-abc";

	it("accepts any callback when no secret is configured (MVP stub)", () => {
		const result = verifyCallbackSignature("body", null, null);
		expect(result.valid).toBe(true);
	});

	it("accepts valid HMAC-SHA256 over canonical input (timestamp.eventId.body)", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const sig = computeCanonicalHmac(secret, body, ts, evtId);
		const result = verifyCallbackSignature(body, sig, secret, ts, evtId);
		expect(result.valid).toBe(true);
	});

	it("accepts valid signature with 'sha256=' prefix", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const hmacHex = computeCanonicalHmac(secret, body, ts, evtId);
		const result = verifyCallbackSignature(body, `sha256=${hmacHex}`, secret, ts, evtId);
		expect(result.valid).toBe(true);
	});

	it("accepts valid signature with 'hmac-sha256=' prefix", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const hmacHex = computeCanonicalHmac(secret, body, ts, evtId);
		const result = verifyCallbackSignature(body, `hmac-sha256=${hmacHex}`, secret, ts, evtId);
		expect(result.valid).toBe(true);
	});

	it("strips 'sha256=' prefix before comparison", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const hmacHex = computeCanonicalHmac(secret, body, ts, evtId);
		const withPrefix = verifyCallbackSignature(body, `sha256=${hmacHex}`, secret, ts, evtId);
		const withoutPrefix = verifyCallbackSignature(body, hmacHex, secret, ts, evtId);
		expect(withPrefix.valid).toBe(true);
		expect(withoutPrefix.valid).toBe(true);
	});

	it("rejects the old concatenation-based hash format", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const oldSig = createHash("sha256").update(`${secret}:${body}`).digest("hex");
		const result = verifyCallbackSignature(body, oldSig, secret, ts, evtId);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Invalid callback signature");
	});

	it("rejects HMAC computed over body-only (without timestamp/eventId)", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const bodyOnlySig = createHmac("sha256", secret).update(body).digest("hex");
		const result = verifyCallbackSignature(body, bodyOnlySig, secret, ts, evtId);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Invalid callback signature");
	});

	it("rejects missing signature when secret is configured", () => {
		const result = verifyCallbackSignature("body", null, "secret", ts, evtId);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Missing X-Cline-Signature");
	});

	it("rejects missing timestamp when secret is configured", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const sig = computeCanonicalHmac(secret, body, null, evtId);
		const result = verifyCallbackSignature(body, sig, secret, null, evtId);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Missing X-Cline-Timestamp");
	});

	it("rejects wrong signature", () => {
		const result = verifyCallbackSignature("body", "wrong-sig", "secret", ts, evtId);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Invalid callback signature");
	});

	it("rejects signature when timestamp differs (timestamp is in HMAC)", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const sig = computeCanonicalHmac(secret, body, "2026-04-09T12:00:00Z", evtId);
		const result = verifyCallbackSignature(body, sig, secret, "2026-04-09T13:00:00Z", evtId);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Invalid callback signature");
	});

	it("rejects signature when eventId (nonce) differs", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const sig = computeCanonicalHmac(secret, body, ts, "evt-1");
		const result = verifyCallbackSignature(body, sig, secret, ts, "evt-2");
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Invalid callback signature");
	});

	it("accepts signature when eventId is null", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const sig = computeCanonicalHmac(secret, body, ts, null);
		const result = verifyCallbackSignature(body, sig, secret, ts, null);
		expect(result.valid).toBe(true);
	});

	it("rejects sig computed with null eventId when actual eventId present", () => {
		const body = '{"test": true}';
		const secret = "my-signing-secret";
		const sig = computeCanonicalHmac(secret, body, ts, null);
		const result = verifyCallbackSignature(body, sig, secret, ts, "evt-injected");
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toContain("Invalid callback signature");
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
			expect(result.payload.prUrl).toBe("https://github.com/org/repo/pull/42");
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
		const payload = createBasePayload({ taskId: "payload-task" });
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

	it("falls back to payload taskId when route identity has none", async () => {
		const payload = createBasePayload({ taskId: "payload-task" });
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

		const result1 = await ingestTerminalCallback(body, headers, {}, ctx);
		expect(result1.accepted).toBe(true);

		const result2 = await ingestTerminalCallback(body, headers, {}, ctx);
		expect(result2.accepted).toBe(false);
		if (result2.accepted === false) {
			expect(result2.duplicate).toBe(true);
			expect(result2.httpStatus).toBe(200);
		}
	});

	it("rejects duplicate via idempotencyKey", async () => {
		const dedupeStore = new InMemoryCallbackDedupeStore();
		const ctx = createFakeContext({
			taskStates: { "task-1": "running", "task-2": "running" },
			hasProcessedCallback: async (key) => dedupeStore.has(key),
			recordProcessedCallback: async (key) => dedupeStore.add(key),
		});

		const payload1 = createBasePayload({ idempotencyKey: "idem-1" });
		const result1 = await ingestTerminalCallback(toRawBody(payload1), createBaseHeaders(), {}, ctx);
		expect(result1.accepted).toBe(true);

		const payload2 = createBasePayload({
			taskId: "task-2",
			instanceId: "inst_different",
			idempotencyKey: "idem-1",
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

	it("rejects when taskId is missing from both route and payload", async () => {
		const ctx = createFakeContext();
		const result = await ingestTerminalCallback(
			JSON.stringify({ instanceId: "inst_abc", status: "success" }),
			createBaseHeaders(),
			{},
			ctx,
		);

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
		const payload = createBasePayload({ taskId: "nonexistent" });
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
	const recentTs = new Date(Date.now() - 10_000).toISOString();
	const evtId = "evt-integ";

	it("rejects callback with invalid signature when secret is set", async () => {
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: "test-secret" });
		const payload = createBasePayload();
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ signature: "bad-sig", timestamp: recentTs, eventId: evtId }),
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
		const result = await ingestTerminalCallback(
			toRawBody(payload),
			createBaseHeaders({ timestamp: recentTs }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(401);
			expect(result.reason).toContain("Missing X-Cline-Signature");
		}
	});

	it("rejects callback with missing timestamp when secret is set", async () => {
		const secret = "test-secret";
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: secret });
		const payload = createBasePayload();
		const body = toRawBody(payload);
		const sig = computeCanonicalHmac(secret, body, null, evtId);
		const result = await ingestTerminalCallback(body, createBaseHeaders({ signature: sig, eventId: evtId }), {}, ctx);
		expect(result.accepted).toBe(false);
		if (result.accepted === false) {
			expect(result.httpStatus).toBe(401);
			expect(result.reason).toContain("Missing X-Cline-Timestamp");
		}
	});

	it("accepts callback with correct canonical HMAC-SHA256 signature", async () => {
		const secret = "test-secret";
		const payload = createBasePayload();
		const body = toRawBody(payload);
		const sig = computeCanonicalHmac(secret, body, recentTs, evtId);
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: secret });
		const result = await ingestTerminalCallback(
			body,
			createBaseHeaders({ signature: sig, timestamp: recentTs, eventId: evtId }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(true);
	});

	it("accepts callback with 'sha256=' prefixed canonical signature", async () => {
		const secret = "test-secret";
		const payload = createBasePayload();
		const body = toRawBody(payload);
		const sig = `sha256=${computeCanonicalHmac(secret, body, recentTs, evtId)}`;
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: secret });
		const result = await ingestTerminalCallback(
			body,
			createBaseHeaders({ signature: sig, timestamp: recentTs, eventId: evtId }),
			{},
			ctx,
		);
		expect(result.accepted).toBe(true);
	});

	it("accepts callback with 'hmac-sha256=' prefixed canonical signature", async () => {
		const secret = "test-secret";
		const payload = createBasePayload();
		const body = toRawBody(payload);
		const sig = `hmac-sha256=${computeCanonicalHmac(secret, body, recentTs, evtId)}`;
		const ctx = createFakeContext({ taskStates: { "task-1": "running" }, signingSecret: secret });
		const result = await ingestTerminalCallback(
			body,
			createBaseHeaders({ signature: sig, timestamp: recentTs, eventId: evtId }),
			{},
			ctx,
		);
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
			taskOutput: "Partial output before crash",
		});
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.payload.error).toBe(errorOutput);
			expect(result.payload.taskOutput).toBe("Partial output before crash");
		}
	});

	it("preserves empty error string without discarding", async () => {
		const payload = createBasePayload({ status: "failed", error: "", taskOutput: "" });
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.payload.error).toBe("");
			expect(result.payload.taskOutput).toBe("");
		}
	});

	it("preserves metadata fields (duration, tokens, PR URL)", async () => {
		const payload = createBasePayload({
			status: "success",
			prUrl: "https://github.com/org/repo/pull/99",
			durationSeconds: 120,
			tokensUsed: 5000,
		});
		const ctx = createFakeContext({ taskStates: { "task-1": "running" } });
		const result = await ingestTerminalCallback(toRawBody(payload), createBaseHeaders(), {}, ctx);
		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.payload.prUrl).toBe("https://github.com/org/repo/pull/99");
			expect(result.payload.durationSeconds).toBe(120);
			expect(result.payload.tokensUsed).toBe(5000);
		}
	});
});

// ---------------------------------------------------------------------------
// ingestTerminalCallback — cloud-platform contract test
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — cloud-platform contract", () => {
	it("accepts a callback exactly as cloud-platform task-runner sends it", async () => {
		const secret = "test-callback-signing-key";
		const timestamp = new Date(Date.now() - 5_000).toISOString();
		const eventId = "4f3c2a1b9e8d7c6f5a4b3c2d1e0f9a8b";

		// Cloud-platform sends ALL camelCase JSON (after cf03b6d)
		const cloudPlatformBody = JSON.stringify({
			instanceId: "inst_gcp_abc123",
			taskId: "task-42",
			attemptNumber: 1,
			status: "success",
			featureBranch: "feat/my-feature",
			prUrl: "https://github.com/org/repo/pull/99",
			taskOutput: "All tests passed. PR created.",
			error: "",
		});

		const sig = computeCanonicalHmac(secret, cloudPlatformBody, timestamp, eventId);

		// Cloud-platform sends X-Cline-* headers (after 5ee9418) with sha256= prefix
		const rawHeaders: Record<string, string> = {
			"x-cline-signature": `sha256=${sig}`,
			"x-cline-timestamp": timestamp,
			"x-cline-event-id": eventId,
			"content-type": "application/json",
		};

		const headers = extractCallbackHeaders(rawHeaders);
		const ctx = createFakeContext({
			taskStates: { "task-42": "running" },
			signingSecret: secret,
		});

		const result = await ingestTerminalCallback(cloudPlatformBody, headers, {}, ctx);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.taskId).toBe("task-42");
			expect(result.instanceId).toBe("inst_gcp_abc123");
			expect(result.trigger).toBe("execution_done");
			expect(result.payload.prUrl).toBe("https://github.com/org/repo/pull/99");
			expect(result.payload.taskOutput).toBe("All tests passed. PR created.");
			expect(result.payload.attemptNumber).toBe(1);
		}
	});

	it("accepts a callback with legacy snake_case body and x-callback-* headers", async () => {
		const secret = "legacy-key";
		const timestamp = new Date(Date.now() - 5_000).toISOString();
		const eventId = "nonce-legacy-abc";

		// Legacy snake_case JSON
		const legacyBody = JSON.stringify({
			instance_id: "inst_legacy_001",
			task_id: "task-legacy",
			attempt_number: 2,
			status: "failed",
			pr_url: "",
			task_output: "",
			error: "OOM killed",
		});

		const sig = computeCanonicalHmac(secret, legacyBody, timestamp, eventId);

		// Legacy x-callback-* headers with hmac-sha256= prefix
		const rawHeaders: Record<string, string> = {
			"x-callback-signature": `hmac-sha256=${sig}`,
			"x-callback-timestamp": timestamp,
			"x-request-id": eventId,
		};

		const headers = extractCallbackHeaders(rawHeaders);
		const ctx = createFakeContext({
			taskStates: { "task-legacy": "running" },
			signingSecret: secret,
		});

		const result = await ingestTerminalCallback(legacyBody, headers, {}, ctx);

		expect(result.accepted).toBe(true);
		if (result.accepted === true) {
			expect(result.taskId).toBe("task-legacy");
			expect(result.instanceId).toBe("inst_legacy_001");
			expect(result.trigger).toBe("execution_error");
			expect(result.toState).toBe("failed");
			expect(result.payload.error).toBe("OOM killed");
			expect(result.payload.attemptNumber).toBe(2);
		}
	});
});

// ---------------------------------------------------------------------------
// instanceId → taskId fallback resolution
// ---------------------------------------------------------------------------

describe("ingestTerminalCallback — instanceId → taskId fallback resolution", () => {
	it("resolves taskId via resolveTaskIdByInstanceId when not in route or payload", async () => {
		const ctx = createFakeContext({
			taskStates: { "resolved-task-42": "running" },
			resolveTaskIdByInstanceId: async (instanceId) => {
				if (instanceId === "inst_abc") return "resolved-task-42";
				return null;
			},
		});

		const body = JSON.stringify({ instance_id: "inst_abc", status: "success" });
		const result = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(true);
		if (!result.accepted) return;
		expect(result.taskId).toBe("resolved-task-42");
	});

	it("returns 400 when taskId not resolvable from any source", async () => {
		const ctx = createFakeContext({
			resolveTaskIdByInstanceId: async () => null,
		});

		const body = JSON.stringify({ instance_id: "inst_unknown", status: "success" });
		const result = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted) return;
		expect(result.httpStatus).toBe(400);
		expect(result.reason).toContain("Missing task_id");
	});

	it("returns 400 when no resolver is configured and taskId is missing", async () => {
		const ctx = createFakeContext();
		const body = JSON.stringify({ instance_id: "inst_abc", status: "success" });
		const result = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(false);
		if (result.accepted) return;
		expect(result.httpStatus).toBe(400);
		expect(result.reason).toContain("Missing task_id");
	});

	it("prefers route identity over instanceId resolver", async () => {
		const ctx = createFakeContext({
			taskStates: { "route-task": "running" },
			resolveTaskIdByInstanceId: async () => "should-not-use-this",
		});

		const body = JSON.stringify({ instance_id: "inst_abc", status: "success" });
		const result = await ingestTerminalCallback(body, createBaseHeaders(), { taskId: "route-task" }, ctx);

		expect(result.accepted).toBe(true);
		if (!result.accepted) return;
		expect(result.taskId).toBe("route-task");
	});

	it("prefers payload taskId over instanceId resolver", async () => {
		const ctx = createFakeContext({
			taskStates: { "payload-task": "running" },
			resolveTaskIdByInstanceId: async () => "should-not-use-this",
		});

		const body = JSON.stringify({ instance_id: "inst_abc", status: "success", task_id: "payload-task" });
		const result = await ingestTerminalCallback(body, createBaseHeaders(), {}, ctx);

		expect(result.accepted).toBe(true);
		if (!result.accepted) return;
		expect(result.taskId).toBe("payload-task");
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
