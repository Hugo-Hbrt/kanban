import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { CloudExecutionState } from "./cloud-execution-lifecycle";
import type {
	CloudExecutionStore,
	PersistedTaskExecution,
	RemoteExecutionMetadata,
} from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Branch Intent — explicit branch/worktree decision for retry/replay
// ---------------------------------------------------------------------------

/**
 * Branch intent for retry/replay execution.
 *
 * Per PRD Section 15.13 (Remote worktree rule):
 * - `reuse_branch`: Continue on the same feature branch (picks up where
 *   the previous attempt stopped). Option A.
 * - `fresh_branch`: Create a fresh feature branch from base (clean retry).
 *   Option B. **This is the default.**
 */
export const branchIntentSchema = z.enum(["reuse_branch", "fresh_branch"]);
export type BranchIntent = z.infer<typeof branchIntentSchema>;

/** Default branch intent: fresh_branch (clean retry) per requirements. */
export const DEFAULT_BRANCH_INTENT: BranchIntent = "fresh_branch";

// ---------------------------------------------------------------------------
// Retry / Replay Configuration
// ---------------------------------------------------------------------------

/** Default maximum number of retry attempts per task (configurable, default 2). */
export const DEFAULT_MAX_RETRY_COUNT = 2;

// ---------------------------------------------------------------------------
// States that allow retry/replay
// ---------------------------------------------------------------------------

const RETRYABLE_STATES: ReadonlySet<CloudExecutionState> = new Set<CloudExecutionState>([
	"completed",
	"failed",
	"canceled",
	"teardown",
	"archived",
]);

/** Returns `true` if the given state allows retry/replay. */
export function isRetryableState(state: CloudExecutionState): boolean {
	return RETRYABLE_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Retry Trigger Metadata
// ---------------------------------------------------------------------------

/** Captures who triggered the retry/replay and why. */
export const retryTriggerMetadataSchema = z.object({
	triggeredBy: z.string().min(1),
	reason: z.string().optional(),
	type: z.enum(["retry", "replay"]),
	triggeredAt: z.string().min(1),
	sourceState: z.string().min(1),
	previousExecutionId: z.string().optional(),
	previousAttemptNumber: z.number().int().positive().optional(),
	branchIntent: branchIntentSchema,
	pinnedCommitSha: z.string().optional(),
	pinnedPromptVersion: z.string().optional(),
});
export type RetryTriggerMetadata = z.infer<typeof retryTriggerMetadataSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RetryTaskOptions {
	readonly taskId: string;
	readonly triggeredBy: string;
	readonly reason?: string;
	readonly branchIntent?: BranchIntent;
	readonly maxRetryCount?: number;
}

export interface ReplayTaskOptions {
	readonly taskId: string;
	readonly triggeredBy: string;
	readonly reason?: string;
	readonly startingCommitSha?: string;
	readonly promptVersion?: string;
	readonly branchIntent?: BranchIntent;
	readonly maxRetryCount?: number;
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface RetryReplaySuccess {
	readonly success: true;
	readonly taskId: string;
	readonly newExecutionId: string;
	readonly newAttemptNumber: number;
	readonly branchIntent: BranchIntent;
	readonly triggerMetadata: RetryTriggerMetadata;
	readonly execution: PersistedTaskExecution;
}

export interface RetryReplayFailure {
	readonly success: false;
	readonly taskId: string;
	readonly reason: string;
	readonly code:
		| "invalid_state"
		| "retry_limit_exceeded"
		| "no_previous_execution"
		| "task_not_found"
		| "persistence_error";
}

export type RetryReplayResult = RetryReplaySuccess | RetryReplayFailure;

// ---------------------------------------------------------------------------
// Retry Limit Error
// ---------------------------------------------------------------------------

export class RetryLimitExceededError extends Error {
	readonly taskId: string;
	readonly currentAttemptCount: number;
	readonly maxRetryCount: number;

	constructor(taskId: string, currentAttemptCount: number, maxRetryCount: number) {
		super(
			`Retry limit exceeded for task "${taskId}": ` +
				`${currentAttemptCount} attempts already exist, ` +
				`maximum allowed is ${maxRetryCount + 1} (initial + ${maxRetryCount} retries).`,
		);
		this.name = "RetryLimitExceededError";
		this.taskId = taskId;
		this.currentAttemptCount = currentAttemptCount;
		this.maxRetryCount = maxRetryCount;
	}
}

// ---------------------------------------------------------------------------
// Core Validation
// ---------------------------------------------------------------------------

/**
 * Validate whether a task can be retried/replayed.
 * Returns a failure result if validation fails, or `null` if valid.
 */
export async function validateRetryReplay(
	store: CloudExecutionStore,
	taskId: string,
	maxRetryCount: number,
): Promise<RetryReplayFailure | null> {
	const currentState = await store.deriveTaskState(taskId);

	if (!isRetryableState(currentState)) {
		return {
			success: false,
			taskId,
			reason:
				`Task "${taskId}" is in state "${currentState}" which does not allow retry/replay. ` +
				`Retry is only allowed from: ${Array.from(RETRYABLE_STATES).join(", ")}.`,
			code: "invalid_state",
		};
	}

	const executions = await store.readExecutionsForTask(taskId);
	if (executions.length === 0) {
		return {
			success: false,
			taskId,
			reason: `No previous execution found for task "${taskId}". Cannot retry a task that has never been executed.`,
			code: "no_previous_execution",
		};
	}

	if (executions.length > maxRetryCount) {
		return {
			success: false,
			taskId,
			reason:
				`Retry limit exceeded for task "${taskId}": ` +
				`${executions.length} attempts already exist, ` +
				`maximum allowed is ${maxRetryCount + 1} (initial + ${maxRetryCount} retries).`,
			code: "retry_limit_exceeded",
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// Build New Execution Record
// ---------------------------------------------------------------------------

function buildRetryReplayExecution(
	taskId: string,
	previousExecution: PersistedTaskExecution,
	branchIntent: BranchIntent,
	overrides: { startingCommitSha?: string; promptVersion?: string } = {},
): { execution: PersistedTaskExecution; newAttemptNumber: number; newExecutionId: string } {
	const newAttemptNumber = previousExecution.attemptNumber + 1;
	const newExecutionId = randomUUID();

	let remoteMetadata: RemoteExecutionMetadata | undefined;
	if (previousExecution.remoteMetadata) {
		const prev = previousExecution.remoteMetadata;
		remoteMetadata = {
			instanceId: "pending-provisioning",
			repoUrl: prev.repoUrl,
			baseBranch: prev.baseBranch,
			featureBranch: branchIntent === "reuse_branch" ? prev.featureBranch : undefined,
			worktreePath: prev.worktreePath,
			startingCommitSha: overrides.startingCommitSha ?? prev.startingCommitSha,
			promptVersion: overrides.promptVersion ?? prev.promptVersion,
			promptHash: undefined,
			instanceHostname: undefined,
			instanceStatus: undefined,
			callbackUrl: undefined,
			callbackReceivedAt: undefined,
			debugPreserve: prev.debugPreserve,
			executionDurationSeconds: undefined,
			tokenUsage: undefined,
		};
	}

	const execution: PersistedTaskExecution = {
		executionId: newExecutionId,
		taskId,
		attemptNumber: newAttemptNumber,
		instanceId: undefined,
		executionMode: previousExecution.executionMode,
		createdAt: new Date().toISOString(),
		startedAt: undefined,
		completedAt: undefined,
		terminalState: undefined,
		resultSummary: undefined,
		remoteMetadata,
	};

	return { execution, newAttemptNumber, newExecutionId };
}

// ---------------------------------------------------------------------------
// Retry Task
// ---------------------------------------------------------------------------

/**
 * Retry a task that has reached a terminal state.
 *
 * Creates a new execution attempt with:
 * - Incremented attempt number
 * - Fresh instance (never reuses terminated instance)
 * - Explicit branch intent (default: fresh_branch)
 * - Full trigger metadata for auditability
 */
export async function retryTask(store: CloudExecutionStore, options: RetryTaskOptions): Promise<RetryReplayResult> {
	const {
		taskId,
		triggeredBy,
		reason,
		branchIntent = DEFAULT_BRANCH_INTENT,
		maxRetryCount = DEFAULT_MAX_RETRY_COUNT,
	} = options;

	const validationFailure = await validateRetryReplay(store, taskId, maxRetryCount);
	if (validationFailure) {
		return validationFailure;
	}

	const executions = await store.readExecutionsForTask(taskId);
	const latestExecution = executions[executions.length - 1];
	if (!latestExecution) {
		return { success: false, taskId, reason: "No execution found (unexpected).", code: "no_previous_execution" };
	}
	const currentState = await store.deriveTaskState(taskId);

	const { execution, newAttemptNumber, newExecutionId } = buildRetryReplayExecution(
		taskId,
		latestExecution,
		branchIntent,
	);

	const triggerMetadata: RetryTriggerMetadata = {
		triggeredBy,
		reason,
		type: "retry",
		triggeredAt: new Date().toISOString(),
		sourceState: currentState,
		previousExecutionId: latestExecution.executionId,
		previousAttemptNumber: latestExecution.attemptNumber,
		branchIntent,
	};

	try {
		await store.createExecution(execution);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			success: false,
			taskId,
			reason: `Failed to persist retry execution: ${msg}`,
			code: "persistence_error",
		};
	}

	return {
		success: true,
		taskId,
		newExecutionId,
		newAttemptNumber,
		branchIntent,
		triggerMetadata,
		execution,
	};
}

// ---------------------------------------------------------------------------
// Replay Task
// ---------------------------------------------------------------------------

/**
 * Replay a task with specific snapshot context for debugging/reproducibility.
 *
 * Like retry, but allows pinning to a specific commit SHA and/or prompt version.
 * Determinism guarantee: same snapshot + same prompt = same behavior.
 */
export async function replayTask(store: CloudExecutionStore, options: ReplayTaskOptions): Promise<RetryReplayResult> {
	const {
		taskId,
		triggeredBy,
		reason,
		startingCommitSha,
		promptVersion,
		branchIntent = DEFAULT_BRANCH_INTENT,
		maxRetryCount = DEFAULT_MAX_RETRY_COUNT,
	} = options;

	const validationFailure = await validateRetryReplay(store, taskId, maxRetryCount);
	if (validationFailure) {
		return validationFailure;
	}

	const executions = await store.readExecutionsForTask(taskId);
	const latestExecution = executions[executions.length - 1];
	if (!latestExecution) {
		return { success: false, taskId, reason: "No execution found (unexpected).", code: "no_previous_execution" };
	}
	const currentState = await store.deriveTaskState(taskId);

	const { execution, newAttemptNumber, newExecutionId } = buildRetryReplayExecution(
		taskId,
		latestExecution,
		branchIntent,
		{ startingCommitSha, promptVersion },
	);

	const triggerMetadata: RetryTriggerMetadata = {
		triggeredBy,
		reason,
		type: "replay",
		triggeredAt: new Date().toISOString(),
		sourceState: currentState,
		previousExecutionId: latestExecution.executionId,
		previousAttemptNumber: latestExecution.attemptNumber,
		branchIntent,
		pinnedCommitSha: startingCommitSha,
		pinnedPromptVersion: promptVersion,
	};

	try {
		await store.createExecution(execution);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			success: false,
			taskId,
			reason: `Failed to persist replay execution: ${msg}`,
			code: "persistence_error",
		};
	}

	return {
		success: true,
		taskId,
		newExecutionId,
		newAttemptNumber,
		branchIntent,
		triggerMetadata,
		execution,
	};
}

// ---------------------------------------------------------------------------
// Attempt History Query Helpers
// ---------------------------------------------------------------------------

/**
 * Get the full attempt history for a task.
 * Returns all execution records sorted by attempt number (ascending).
 */
export async function getAttemptHistory(
	store: CloudExecutionStore,
	taskId: string,
): Promise<readonly PersistedTaskExecution[]> {
	return store.readExecutionsForTask(taskId);
}

/**
 * Get the current retry count for a task (attempts minus 1).
 */
export async function getRetryCount(store: CloudExecutionStore, taskId: string): Promise<number> {
	const executions = await store.readExecutionsForTask(taskId);
	return Math.max(0, executions.length - 1);
}

/**
 * Check whether a task can be retried given its current state and history.
 */
export async function canRetry(
	store: CloudExecutionStore,
	taskId: string,
	maxRetryCount: number = DEFAULT_MAX_RETRY_COUNT,
): Promise<{ allowed: boolean; reason?: string }> {
	const failure = await validateRetryReplay(store, taskId, maxRetryCount);
	if (failure) {
		return { allowed: false, reason: failure.reason };
	}
	return { allowed: true };
}
