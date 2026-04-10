// ---------------------------------------------------------------------------
// Cloud Callback Ingestion — B2
// @phase MVP
// @prd-section 5, 15.8
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
	type CloudExecutionState,
	type CloudExecutionTrigger,
	isTerminalState,
	validateCloudExecutionTransition,
} from "./cloud-execution-lifecycle";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age (in milliseconds) for a callback timestamp to be accepted.
 * Callbacks older than this window are rejected as potential replay attacks.
 * PRD Section 1: "Include request timestamps on all callback deliveries."
 * @default 300_000 (5 minutes)
 */
export const DEFAULT_REPLAY_WINDOW_MS = 300_000;

// ---------------------------------------------------------------------------
// Callback Terminal Status
// ---------------------------------------------------------------------------

/**
 * Terminal status values sent by the task-runner in the callback body.
 * Current code-grounded values from PRD Section 15.3:
 *   - `success`  → task completed successfully
 *   - `failed`   → task execution failed
 *   - `canceled` → task was canceled
 */
export const callbackTerminalStatusSchema = z.enum(["success", "failed", "canceled"]);
export type CallbackTerminalStatus = z.infer<typeof callbackTerminalStatusSchema>;

// ---------------------------------------------------------------------------
// Callback Payload Schema
// ---------------------------------------------------------------------------

/**
 * Schema for the terminal callback body posted by the task-runner.
 * Matches the currently implemented callback body shape in
 * `cloud-platform/apps/task-runner/runner/main.go` (PRD Section 15.3.C).
 */
export const callbackPayloadSchema = z.object({
	instanceId: z.string().min(1, "instanceId is required"),
	status: callbackTerminalStatusSchema,
	task_id: z.string().min(1).optional(),
	attempt_number: z.number().int().positive().optional(),
	pr_url: z.string().optional(),
	task_output: z.string().optional(),
	error: z.string().optional(),
	duration_seconds: z.number().nonnegative().optional(),
	tokens_used: z.number().int().nonnegative().optional(),
	idempotency_key: z.string().optional(),
});
export type CallbackPayload = z.infer<typeof callbackPayloadSchema>;

// ---------------------------------------------------------------------------
// Callback Headers
// ---------------------------------------------------------------------------

/**
 * Expected callback headers for signature verification and replay protection.
 * PRD Section 15.3 recommended future headers:
 *   - X-Cline-Timestamp, X-Cline-Signature, X-Cline-Event-Id
 * For MVP, signature verification is stubbed (C1 not yet complete).
 */
export interface CallbackHeaders {
	readonly timestamp: string | null;
	readonly signature: string | null;
	readonly eventId: string | null;
}

export function extractCallbackHeaders(rawHeaders: Record<string, string | string[] | undefined>): CallbackHeaders {
	const getHeader = (name: string): string | null => {
		const value = rawHeaders[name] ?? rawHeaders[name.toLowerCase()];
		if (Array.isArray(value)) return value[0] ?? null;
		return typeof value === "string" ? value : null;
	};
	return {
		timestamp: getHeader("x-cline-timestamp"),
		signature: getHeader("x-cline-signature"),
		eventId: getHeader("x-cline-event-id"),
	};
}

// ---------------------------------------------------------------------------
// Composite Dedupe Key
// ---------------------------------------------------------------------------

/**
 * Build a composite deduplication key from the callback identity fields.
 * Format: `{instance_id}:{task_id}:{attempt_number}:{status}`
 */
export function buildDedupeKey(
	instanceId: string,
	taskId: string,
	attemptNumber: number,
	status: CallbackTerminalStatus,
): string {
	return `${instanceId}:${taskId}:${attemptNumber}:${status}`;
}

// ---------------------------------------------------------------------------
// Terminal Status → Lifecycle Trigger Mapping
// ---------------------------------------------------------------------------

export function mapCallbackStatusToTrigger(status: CallbackTerminalStatus): CloudExecutionTrigger {
	switch (status) {
		case "success":
			return "execution_done";
		case "failed":
			return "execution_error";
		case "canceled":
			return "user_cancel";
	}
}

export function mapCallbackStatusToTerminalState(status: CallbackTerminalStatus): CloudExecutionState {
	switch (status) {
		case "success":
			return "completing";
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
	}
}

// ---------------------------------------------------------------------------
// Signature Verification (MVP stub for C1)
// ---------------------------------------------------------------------------

/**
 * Build the canonical signing input that cloud-platform uses when producing
 * HMAC-SHA256 callback signatures.
 *
 * Format: `<timestamp>.<eventId>.<body>`
 *
 * When a component is absent the empty string is used so that the canonical
 * structure is always three dot-separated segments. This prevents an attacker
 * from shuffling content between segments.
 */
export function buildCanonicalSigningInput(timestamp: string | null, eventId: string | null, body: string): string {
	return `${timestamp ?? ""}.${eventId ?? ""}.${body}`;
}

/**
 * Verify the callback signature using HMAC-SHA256 over the canonical
 * signing input (`timestamp.eventId.body`).
 *
 * For MVP (before C1 lands), returns `{ valid: true }` when no signing
 * secret is configured. Once C1 is implemented, the signing secret should
 * always be present and unsigned callbacks should be rejected.
 *
 * When a signing secret **is** configured the timestamp header is
 * security-critical because it is part of the signed payload. A missing
 * timestamp is therefore rejected.
 */
export function verifyCallbackSignature(
	body: string,
	signature: string | null,
	secret: string | null,
	timestamp: string | null = null,
	eventId: string | null = null,
): { valid: true } | { valid: false; reason: string } {
	if (!secret) {
		return { valid: true };
	}
	if (!signature) {
		return { valid: false, reason: "Missing X-Cline-Signature header." };
	}
	if (!timestamp) {
		return { valid: false, reason: "Missing X-Cline-Timestamp header — required for signature verification." };
	}
	// Strip optional 'sha256=' prefix (PRD Section 5.3 format) for forward compatibility.
	const rawSignature = signature.startsWith("sha256=") ? signature.slice(7) : signature;
	const canonicalInput = buildCanonicalSigningInput(timestamp, eventId, body);
	const expectedSignature = createHmac("sha256", secret).update(canonicalInput).digest("hex");
	const sigBuffer = Buffer.from(rawSignature, "utf8");
	const expectedBuffer = Buffer.from(expectedSignature, "utf8");
	if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
		return { valid: false, reason: "Invalid callback signature." };
	}
	return { valid: true };
}

// ---------------------------------------------------------------------------
// Replay Protection
// ---------------------------------------------------------------------------

/**
 * Validate that a callback timestamp is within the acceptable replay window.
 */
export function validateCallbackTimestamp(
	timestamp: string | null,
	nowMs: number = Date.now(),
	windowMs: number = DEFAULT_REPLAY_WINDOW_MS,
): { valid: true } | { valid: false; reason: string } {
	if (!timestamp) {
		return { valid: true };
	}
	const parsedMs = Date.parse(timestamp);
	if (Number.isNaN(parsedMs)) {
		return { valid: false, reason: "Invalid X-Cline-Timestamp format." };
	}
	const ageMs = nowMs - parsedMs;
	if (ageMs < -60_000) {
		return { valid: false, reason: "Callback timestamp is in the future." };
	}
	if (ageMs > windowMs) {
		return {
			valid: false,
			reason: `Callback timestamp is too old (${Math.round(ageMs / 1000)}s > ${Math.round(windowMs / 1000)}s window).`,
		};
	}
	return { valid: true };
}
// ---------------------------------------------------------------------------
// Ingestion Context (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Interface for the dependencies required by callback ingestion.
 * Allows the ingestion logic to be tested without real persistence,
 * following the same DI pattern used throughout the codebase.
 */
export interface CallbackIngestionContext {
	getTaskExecutionState(taskId: string): Promise<CloudExecutionState | null>;
	hasProcessedCallback(dedupeKey: string): Promise<boolean>;
	recordProcessedCallback(dedupeKey: string): Promise<void>;
	signingSecret: string | null;
	nowMs?: number;
	replayWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Ingestion Result
// ---------------------------------------------------------------------------

export type CallbackIngestionResult =
	| {
			readonly accepted: true;
			readonly taskId: string;
			readonly instanceId: string;
			readonly trigger: CloudExecutionTrigger;
			readonly fromState: CloudExecutionState;
			readonly toState: CloudExecutionState;
			readonly payload: CallbackPayload;
			readonly dedupeKey: string;
			readonly eventId: string | null;
	  }
	| {
			readonly accepted: false;
			readonly duplicate: boolean;
			readonly reason: string;
			readonly httpStatus: number;
	  };

// ---------------------------------------------------------------------------
// Main Ingestion Function
// ---------------------------------------------------------------------------

/**
 * Process an incoming terminal callback from a cloud task-runner.
 *
 * This is the central callback ingestion point. It validates, deduplicates,
 * and maps the callback to a lifecycle state transition.
 *
 * **Failure preservation (PRD 15.11):** Error output from failed callbacks
 * is always included in the accepted result payload. Callers MUST persist
 * the full payload before acknowledging the callback.
 */
export async function ingestTerminalCallback(
	rawBody: string,
	headers: CallbackHeaders,
	identity: { taskId?: string; attemptNumber?: number },
	ctx: CallbackIngestionContext,
): Promise<CallbackIngestionResult> {
	// 1. Parse and validate the payload.
	let payload: CallbackPayload;
	try {
		const parsed = JSON.parse(rawBody);
		const validated = callbackPayloadSchema.safeParse(parsed);
		if (!validated.success) {
			const issues = validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
			return { accepted: false, duplicate: false, reason: `Invalid callback payload: ${issues}`, httpStatus: 400 };
		}
		payload = validated.data;
	} catch {
		return { accepted: false, duplicate: false, reason: "Invalid JSON in callback body.", httpStatus: 400 };
	}

	// 2. Verify signature (MVP stub — accept if no secret configured).
	const sigResult = verifyCallbackSignature(
		rawBody,
		headers.signature,
		ctx.signingSecret,
		headers.timestamp,
		headers.eventId,
	);
	if (sigResult.valid === false) {
		return { accepted: false, duplicate: false, reason: sigResult.reason, httpStatus: 401 };
	}

	// 3. Validate timestamp for replay protection.
	const tsResult = validateCallbackTimestamp(
		headers.timestamp,
		ctx.nowMs ?? Date.now(),
		ctx.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS,
	);
	if (tsResult.valid === false) {
		return { accepted: false, duplicate: false, reason: tsResult.reason, httpStatus: 401 };
	}

	// 4. Resolve identity fields.
	const taskId = identity.taskId ?? payload.task_id;
	if (!taskId) {
		return {
			accepted: false,
			duplicate: false,
			reason: "Missing task_id: not provided in payload or route.",
			httpStatus: 400,
		};
	}
	const attemptNumber = identity.attemptNumber ?? payload.attempt_number ?? 1;

	// 5. Build composite dedupe key and check for duplicates.
	const dedupeKey = buildDedupeKey(payload.instanceId, taskId, attemptNumber, payload.status);
	if (await ctx.hasProcessedCallback(dedupeKey)) {
		return { accepted: false, duplicate: true, reason: `Duplicate callback ignored: ${dedupeKey}`, httpStatus: 200 };
	}
	if (payload.idempotency_key && (await ctx.hasProcessedCallback(payload.idempotency_key))) {
		return {
			accepted: false,
			duplicate: true,
			reason: `Duplicate callback ignored (idempotency_key): ${payload.idempotency_key}`,
			httpStatus: 200,
		};
	}

	// 6. Look up current task execution state.
	const currentState = await ctx.getTaskExecutionState(taskId);
	if (currentState === null) {
		return { accepted: false, duplicate: false, reason: `Unknown task: ${taskId}`, httpStatus: 404 };
	}

	// 7. Validate lifecycle transition.
	if (isTerminalState(currentState)) {
		return {
			accepted: false,
			duplicate: true,
			reason: `Task ${taskId} is already in terminal state "${currentState}". Callback ignored.`,
			httpStatus: 200,
		};
	}
	const trigger = mapCallbackStatusToTrigger(payload.status);
	const transitionResult = validateCloudExecutionTransition(currentState, trigger);
	if (transitionResult.valid === false) {
		return {
			accepted: false,
			duplicate: false,
			reason: `Invalid state transition for task ${taskId}: ${transitionResult.reason}`,
			httpStatus: 409,
		};
	}

	// 8. Record the dedupe key(s) BEFORE returning accepted.
	await ctx.recordProcessedCallback(dedupeKey);
	if (payload.idempotency_key) {
		await ctx.recordProcessedCallback(payload.idempotency_key);
	}

	// 9. Return accepted result.
	return {
		accepted: true,
		taskId,
		instanceId: payload.instanceId,
		trigger: transitionResult.trigger,
		fromState: transitionResult.from,
		toState: transitionResult.to,
		payload,
		dedupeKey,
		eventId: headers.eventId,
	};
}

// ---------------------------------------------------------------------------
// In-Memory Dedupe Store (for MVP / single-process Kanban)
// ---------------------------------------------------------------------------

/**
 * Simple in-memory dedupe store for callback processing.
 * Suitable for MVP single-process Kanban. For multi-process deployment,
 * replace with a persistent dedupe store (e.g. Redis, database).
 */
export class InMemoryCallbackDedupeStore {
	private readonly processedKeys = new Set<string>();
	private readonly maxSize: number;

	constructor(maxSize: number = 10_000) {
		this.maxSize = maxSize;
	}

	has(key: string): boolean {
		return this.processedKeys.has(key);
	}

	add(key: string): void {
		if (this.processedKeys.size >= this.maxSize) {
			const firstKey = this.processedKeys.values().next().value;
			if (firstKey !== undefined) {
				this.processedKeys.delete(firstKey);
			}
		}
		this.processedKeys.add(key);
	}

	get size(): number {
		return this.processedKeys.size;
	}

	clear(): void {
		this.processedKeys.clear();
	}
}
