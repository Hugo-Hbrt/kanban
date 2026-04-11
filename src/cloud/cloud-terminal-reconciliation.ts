// ---------------------------------------------------------------------------
// Cloud Terminal Reconciliation — B4
// @phase MVP
// @prd-section 6, 15.8
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { CallbackIngestionResult, CallbackPayload } from "./cloud-callback-ingestion";
import type { CloudExecutionState } from "./cloud-execution-lifecycle";
import { isTerminalState, validateCloudExecutionTransition } from "./cloud-execution-lifecycle";
import {
	canonicalFieldsSnapshot,
	detectCanonicalFieldDrift,
	type EventTriggerSource,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
} from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Terminal Reconciliation Result
// ---------------------------------------------------------------------------

export type TerminalReconciliationResult =
	| {
			readonly reconciled: true;
			readonly taskId: string;
			readonly terminalState: CloudExecutionState;
			readonly teardownTriggered: boolean;
			readonly teardownState: CloudExecutionState | null;
			readonly eventsAppended: number;
			readonly executionUpdated: boolean;
	  }
	| {
			readonly reconciled: false;
			readonly reason: string;
			readonly idempotentNoOp: boolean;
	  };

// ---------------------------------------------------------------------------
// Reconciliation Context (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Interface for the dependencies required by terminal reconciliation.
 *
 * Follows the same DI pattern as {@link CallbackIngestionContext} from B4,
 * allowing reconciliation logic to be tested without real persistence.
 */
export interface TerminalReconciliationContext {
	deriveTaskState(taskId: string): Promise<CloudExecutionState>;
	appendEvent(event: PersistedTaskEvent): Promise<void>;
	appendEvents(events: readonly PersistedTaskEvent[]): Promise<void>;
	readExecutionsForTask(taskId: string): Promise<readonly PersistedTaskExecution[]>;
	updateExecution(
		executionId: string,
		updates: Partial<
			Pick<
				PersistedTaskExecution,
				"instanceId" | "startedAt" | "completedAt" | "terminalState" | "resultSummary" | "remoteMetadata"
			>
		>,
	): Promise<boolean>;
	/**
	 * Check whether a task has been trashed on the board.
	 * Returns `null` if unknown, `"trash"` if trashed, or column id otherwise.
	 */
	getTaskBoardColumn?(taskId: string): Promise<string | null>;
	/** Optional clock override for deterministic testing. */
	now?(): string;
	/**
	 * Optional callback invoked when canonical field drift is detected
	 * during reconciliation. This is a safety-net notification — drift
	 * should never occur in correct code paths.
	 *
	 * **Invariant: Kanban is the source of truth for execution intent.**
	 * Canonical fields are read-only after dispatch.
	 */
	onCanonicalFieldDrift?(taskId: string, executionId: string, driftedFields: readonly string[]): void;
}

// ---------------------------------------------------------------------------
// Build Result Summary
// ---------------------------------------------------------------------------

/**
 * Build a human-readable result summary from the callback payload.
 *
 * **Failure preservation (PRD 15.11):** Error output is always included
 * in the summary for failed callbacks. It is never silently discarded.
 */
export function buildResultSummary(payload: CallbackPayload): string {
	const parts: string[] = [];
	parts.push(`status=${payload.status}`);
	if (payload.prUrl) parts.push(`pr=${payload.prUrl}`);
	if (payload.durationSeconds !== undefined) parts.push(`duration=${payload.durationSeconds}s`);
	if (payload.tokensUsed !== undefined) parts.push(`tokens=${payload.tokensUsed}`);
	if (payload.error) parts.push(`error=${payload.error}`);
	if (payload.taskOutput) parts.push(`output=${payload.taskOutput}`);
	return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Build Terminal Event Metadata
// ---------------------------------------------------------------------------

/**
 * Extract execution metadata fields from a callback payload.
 * These are recorded in `task_events` metadata for auditability.
 */
export function buildTerminalEventMetadata(
	payload: CallbackPayload,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		instanceId: payload.instanceId,
		callbackStatus: payload.status,
	};
	if (payload.prUrl !== undefined) metadata.prUrl = payload.prUrl;
	if (payload.taskOutput !== undefined) metadata.taskOutput = payload.taskOutput;
	if (payload.error !== undefined) metadata.error = payload.error;
	if (payload.durationSeconds !== undefined) metadata.durationSeconds = payload.durationSeconds;
	if (payload.tokensUsed !== undefined) metadata.tokensUsed = payload.tokensUsed;
	if (payload.attemptNumber !== undefined) metadata.attemptNumber = payload.attemptNumber;
	if (payload.idempotencyKey !== undefined) metadata.idempotencyKey = payload.idempotencyKey;
	if (extra) Object.assign(metadata, extra);
	return metadata;
}

// ---------------------------------------------------------------------------
// Debug-Preserve Check
// ---------------------------------------------------------------------------

/**
 * Determine whether debug-preserve is enabled for a failed task.
 *
 * Per PRD 15.11: failed sandbox/worktree is preserved only when a debug
 * flag is enabled. The debug-preserve decision is stored as execution
 * metadata so teardown behavior is deterministic.
 *
 * For non-failed terminal states (completed, canceled), always returns false.
 */
async function shouldDebugPreserve(
	taskId: string,
	terminalState: CloudExecutionState,
	ctx: TerminalReconciliationContext,
): Promise<boolean> {
	if (terminalState !== "failed") {
		return false;
	}
	const executions = await ctx.readExecutionsForTask(taskId);
	const latestExecution = executions[executions.length - 1];
	return latestExecution?.remoteMetadata?.debugPreserve === true;
}

// ---------------------------------------------------------------------------
// Main Reconciliation Function
// ---------------------------------------------------------------------------

/**
 * Reconcile a terminal callback result into the task lifecycle.
 *
 * This function is the bridge between callback ingestion (B4) and the
 * lifecycle state machine (A1) / execution persistence (A2).
 *
 * On a valid accepted callback result, it:
 * 1. Records the terminal event in `task_events` (append-only).
 * 2. Updates `task_executions` with terminal state, completion time,
 *    result summary, and execution metadata.
 * 3. Triggers automatic transition to `teardown` (unless debug-preserve
 *    is enabled for failed tasks).
 *
 * **Architecture invariants:**
 * - Idempotent: re-reconciling an already-terminal task is a safe no-op.
 * - All transitions go through the lifecycle validator (A1).
 * - Failure information is never silently discarded (PRD 15.11).
 * - State is recoverable after restart (persisted before return).
 */
export async function reconcileTerminalCallback(
	ingestionResult: Extract<CallbackIngestionResult, { accepted: true }>,
	ctx: TerminalReconciliationContext,
): Promise<TerminalReconciliationResult> {
	const { taskId, payload, trigger, eventId, dedupeKey } = ingestionResult;
	const nowFn = ctx.now ?? (() => new Date().toISOString());
	const timestamp = nowFn();

	// 1. Re-derive current state from persistence (crash-safe)
	const currentState = await ctx.deriveTaskState(taskId);

	// Edge case: already in terminal or post-terminal state (idempotent no-op)
	if (isTerminalState(currentState) || currentState === "teardown" || currentState === "archived") {
		return {
			reconciled: false,
			reason: `Task ${taskId} is already in state "${currentState}". Terminal reconciliation skipped.`,
			idempotentNoOp: true,
		};
	}

	// Edge case: task has been trashed on the board
	if (ctx.getTaskBoardColumn) {
		const boardColumn = await ctx.getTaskBoardColumn(taskId);
		if (boardColumn === "trash") {
			return {
				reconciled: false,
				reason: `Task ${taskId} has been trashed. Terminal reconciliation safely rejected.`,
				idempotentNoOp: false,
			};
		}
	}

	// 2. Validate the terminal transition via lifecycle validator (A1)
	const transitionResult = validateCloudExecutionTransition(currentState, trigger);
	if (!transitionResult.valid) {
		return {
			reconciled: false,
			reason: `Invalid terminal transition for task ${taskId}: ${transitionResult.reason}`,
			idempotentNoOp: false,
		};
	}

	// 3. Build events to persist
	const events: PersistedTaskEvent[] = [];

	// 3a. Terminal state event
	const terminalEvent: PersistedTaskEvent = {
		eventId: eventId ?? randomUUID(),
		taskId,
		trigger,
		fromState: transitionResult.from,
		toState: transitionResult.to,
		timestamp,
		triggerSource: "callback" as EventTriggerSource,
		metadata: buildTerminalEventMetadata(payload, { dedupeKey }),
	};
	events.push(terminalEvent);

	// 3b. Determine if teardown should be triggered automatically
	let teardownTriggered = false;
	let teardownState: CloudExecutionState | null = null;
	const terminalState = transitionResult.to;

	if (isTerminalState(terminalState)) {
		const shouldPreserve = await shouldDebugPreserve(taskId, terminalState, ctx);
		if (!shouldPreserve) {
			const teardownTransition = validateCloudExecutionTransition(terminalState, "auto_teardown");
			if (teardownTransition.valid) {
				const teardownEvent: PersistedTaskEvent = {
					eventId: randomUUID(),
					taskId,
					trigger: "auto_teardown",
					fromState: teardownTransition.from,
					toState: teardownTransition.to,
					timestamp: nowFn(),
					triggerSource: "system" as EventTriggerSource,
					metadata: { autoTeardown: true, triggeredByTerminalState: terminalState },
				};
				events.push(teardownEvent);
				teardownTriggered = true;
				teardownState = teardownTransition.to;
			}
		}
	}

	// 4. Persist events atomically
	const firstEvent = events[0];
	if (events.length === 1 && firstEvent) {
		await ctx.appendEvent(firstEvent);
	} else {
		await ctx.appendEvents(events);
	}

	// 5. Update task_executions with terminal state and metadata
	let executionUpdated = false;
	const executions = await ctx.readExecutionsForTask(taskId);
	const latestExecution = executions[executions.length - 1];

	if (latestExecution) {
		// 5a. Capture canonical fields BEFORE any updates.
		// **Invariant: Kanban is the source of truth for execution intent.**
		// Canonical fields (repoUrl, baseBranch, featureBranch, worktreePath,
		// startingCommitSha, promptHash) must never be mutated by reconciliation.
		const canonicalBefore = canonicalFieldsSnapshot(latestExecution);

		const resultSummary = buildResultSummary(payload);
		const executionUpdates: Partial<
			Pick<
				PersistedTaskExecution,
				"instanceId" | "startedAt" | "completedAt" | "terminalState" | "resultSummary" | "remoteMetadata"
			>
		> = {
			terminalState,
			completedAt: timestamp,
			resultSummary,
		};

		if (latestExecution.remoteMetadata) {
			executionUpdates.remoteMetadata = {
				...latestExecution.remoteMetadata,
				callbackReceivedAt: timestamp,
			};
		}

		if (!latestExecution.instanceId && payload.instanceId) {
			executionUpdates.instanceId = payload.instanceId;
		}

		executionUpdated = await ctx.updateExecution(latestExecution.executionId, executionUpdates);

		// 5b. Verify canonical fields were NOT mutated by the update.
		// This is a defensive assertion — the code above intentionally only
		// writes callback-specific fields (completedAt, terminalState,
		// resultSummary, callbackReceivedAt). If drift is detected, it
		// indicates a bug in the update logic, not in the callback payload.
		if (executionUpdated && executionUpdates.remoteMetadata) {
			const projectedExecution: PersistedTaskExecution = {
				...latestExecution,
				...executionUpdates,
			} as PersistedTaskExecution;
			const canonicalAfter = canonicalFieldsSnapshot(projectedExecution);
			const driftedFields = detectCanonicalFieldDrift(canonicalBefore, canonicalAfter);
			if (driftedFields.length > 0) {
				// Log warning — canonical field drift detected during reconciliation.
				// This should never happen in correct code paths but is logged as
				// a safety net per the execution intent invariant.
				if (ctx.onCanonicalFieldDrift) {
					ctx.onCanonicalFieldDrift(taskId, latestExecution.executionId, driftedFields);
				}
			}
		}
	}

	return {
		reconciled: true,
		taskId,
		terminalState,
		teardownTriggered,
		teardownState,
		eventsAppended: events.length,
		executionUpdated,
	};
}
