// ---------------------------------------------------------------------------
// Cloud Execution Rerun-from-Snapshot — P3-2
// @phase Phase3
// @prd-section 10, 15.13, 15.14
// ---------------------------------------------------------------------------
//
// Implements rerun-from-snapshot: re-execution using a specific combination
// of (commit SHA + prompt version + execution config), creating a reproducible
// execution from a prior attempt's snapshot.
//
// Key difference from retry/replay:
//   - retry:            fresh execution from latest attempt (clean state)
//   - replay:           re-execution from latest attempt with optional overrides
//   - rerun_snapshot:   re-execution from a SPECIFIC prior attempt number
//                       with explicit, unambiguous branch/worktree context
//
// Architecture rules (PRD Section 10 Phase 4, Section 15.13, Section 15.14):
//   - Rerun must never create ambiguous execution context
//   - Snapshot context is read-only; rerun creates a new attempt
//   - Branch/worktree decisions must be explicit at rerun time
//   - Kanban remains source of truth for snapshot and rerun attempt data
//   - Rerun respects concurrency limits (P2-4)
//   - Rerun goes through full lifecycle: queued -> policy_check -> provisioning
//     -> running -> terminal
//
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { CloudExecutionState } from "./cloud-execution-lifecycle";
import { deriveWorktreePath } from "./cloud-execution-orchestrator";
import type {
	CloudExecutionStore,
	PersistedTaskExecution,
	RemoteExecutionMetadata,
} from "./cloud-execution-persistence";
import { isRetryableState } from "./cloud-execution-retry-replay";

// ---------------------------------------------------------------------------
// Snapshot — immutable capture of a prior attempt's execution context
// ---------------------------------------------------------------------------

/**
 * ExecutionSnapshot captures the exact context of a specific prior attempt.
 *
 * This is the read-only record used to seed a rerun. The snapshot is never
 * modified — rerun creates a new execution attempt from the snapshot data.
 *
 * Captures per PRD Section 10 Phase 4 requirements:
 *   - commit_sha from the source attempt
 *   - prompt_hash and prompt_version from the source attempt
 *   - execution config (timeouts, debug-preserve, etc.)
 *   - branch_intent and worktree_intent from the source attempt
 */
export const executionSnapshotSchema = z.object({
	/** Task this snapshot belongs to. */
	taskId: z.string().min(1),
	/** The attempt number this snapshot was captured from. */
	sourceAttemptNumber: z.number().int().positive(),
	/** The execution ID of the source attempt. */
	sourceExecutionId: z.string().min(1),
	/** Terminal state of the source attempt at snapshot time. */
	sourceTerminalState: z.string().optional(),
	/** Git commit SHA at the start of the source attempt. */
	commitSha: z.string().optional(),
	/** Prompt hash for the source attempt. */
	promptHash: z.string().optional(),
	/** Prompt version for the source attempt. */
	promptVersion: z.string().optional(),
	/** Branch intent from the source attempt. */
	branchIntent: z.string().optional(),
	/** Worktree intent from the source attempt. */
	worktreeIntent: z.string().optional(),
	/** Repository URL from the source attempt. */
	repoUrl: z.string().optional(),
	/** Base branch from the source attempt. */
	baseBranch: z.string().optional(),
	/** Feature branch from source attempt (only present with reuse_branch). */
	featureBranch: z.string().optional(),
	/** Debug-preserve flag from the source attempt. */
	debugPreserve: z.boolean().optional(),
	/** Execution mode from the source attempt. */
	executionMode: z.string().optional(),
	/** Timestamp when this snapshot was captured. */
	capturedAt: z.string().min(1),
});
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Branch Intent — explicit branch/worktree decision for rerun
// ---------------------------------------------------------------------------

/**
 * Branch intent for rerun-from-snapshot.
 *
 * Per PRD Section 15.13 (Remote worktree rule):
 * - `fresh_branch`: Create a new feature branch from the snapshot commit.
 *   **This is the default for rerun.** Provides clean context from the
 *   exact commit that was used in the source attempt.
 * - `reuse_branch`: Continue on the same feature branch from the source
 *   attempt (pick up from previous state).
 *
 * Never: silently inherit ambiguous branch state.
 */
export const rerunBranchIntentSchema = z.enum(["fresh_branch", "reuse_branch"]);
export type RerunBranchIntent = z.infer<typeof rerunBranchIntentSchema>;

/** Default branch intent for rerun: fresh_branch from snapshot commit. */
export const DEFAULT_RERUN_BRANCH_INTENT: RerunBranchIntent = "fresh_branch";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for rerun-from-snapshot.
 *
 * The source attempt is identified by taskId + attemptNumber.
 * Override options allow replacing specific context fields from the snapshot.
 * If no overrides: reuse exact context from the source attempt.
 */
export interface RerunFromSnapshotOptions {
	/** Task to rerun. */
	readonly taskId: string;
	/** Attempt number to use as the source snapshot. */
	readonly sourceAttemptNumber: number;
	/** Who triggered the rerun. */
	readonly triggeredBy: string;
	/** Optional reason for the rerun. */
	readonly reason?: string;
	/**
	 * Override commit SHA.
	 * If omitted, uses the commit SHA from the source attempt.
	 */
	readonly commitSha?: string;
	/**
	 * Override prompt version.
	 * If omitted, uses the prompt version from the source attempt.
	 */
	readonly promptVersion?: string;
	/**
	 * Branch intent for the rerun execution.
	 * Default: `fresh_branch` (create new branch from snapshot commit).
	 * Option: `reuse_branch` (pick up from source attempt's feature branch).
	 * Never silently inherited.
	 */
	readonly branchIntent?: RerunBranchIntent;
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface RerunFromSnapshotSuccess {
	readonly success: true;
	readonly taskId: string;
	readonly newExecutionId: string;
	readonly newAttemptNumber: number;
	readonly branchIntent: RerunBranchIntent;
	readonly snapshot: ExecutionSnapshot;
	readonly execution: PersistedTaskExecution;
}

export interface RerunFromSnapshotFailure {
	readonly success: false;
	readonly taskId: string;
	readonly reason: string;
	readonly code:
		| "attempt_not_found"
		| "source_not_terminal"
		| "task_not_found"
		| "persistence_error"
		| "invalid_source_state";
}

export type RerunFromSnapshotResult = RerunFromSnapshotSuccess | RerunFromSnapshotFailure;

// ---------------------------------------------------------------------------
// Snapshot Extraction
// ---------------------------------------------------------------------------

/**
 * Extract an immutable snapshot from a specific prior attempt.
 *
 * The snapshot is read-only — rerun never modifies the source attempt record.
 */
export function extractSnapshotFromAttempt(execution: PersistedTaskExecution): ExecutionSnapshot {
	const meta = execution.remoteMetadata;

	return {
		taskId: execution.taskId,
		sourceAttemptNumber: execution.attemptNumber,
		sourceExecutionId: execution.executionId,
		sourceTerminalState: execution.terminalState,
		// Prefer top-level fields, then fall back to remoteMetadata
		commitSha: execution.startingCommitSha ?? meta?.startingCommitSha,
		promptHash: execution.promptHash ?? meta?.promptHash,
		promptVersion: execution.promptVersion ?? meta?.promptVersion,
		branchIntent: execution.branchIntent,
		worktreeIntent: execution.worktreeIntent,
		repoUrl: meta?.repoUrl,
		baseBranch: meta?.baseBranch,
		featureBranch: meta?.featureBranch,
		debugPreserve: meta?.debugPreserve,
		executionMode: execution.executionMode,
		capturedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Build New Execution Record from Snapshot
// ---------------------------------------------------------------------------

function buildRerunExecution(
	taskId: string,
	latestExecution: PersistedTaskExecution,
	snapshot: ExecutionSnapshot,
	branchIntent: RerunBranchIntent,
	overrides: { commitSha?: string; promptVersion?: string } = {},
): { execution: PersistedTaskExecution; newAttemptNumber: number; newExecutionId: string } {
	const newAttemptNumber = latestExecution.attemptNumber + 1;
	const newExecutionId = randomUUID();

	// Resolve final values: overrides take precedence over snapshot context
	const resolvedCommitSha = overrides.commitSha ?? snapshot.commitSha;
	const resolvedPromptVersion = overrides.promptVersion ?? snapshot.promptVersion;

	// Deterministic worktree path from taskId + attemptNumber
	const deterministicWorktreePath = deriveWorktreePath(taskId, newAttemptNumber);

	let remoteMetadata: RemoteExecutionMetadata | undefined;
	if (snapshot.repoUrl || latestExecution.remoteMetadata) {
		const prev = latestExecution.remoteMetadata;
		remoteMetadata = {
			instanceId: "pending-provisioning",
			repoUrl: snapshot.repoUrl ?? prev?.repoUrl ?? "",
			baseBranch: snapshot.baseBranch ?? prev?.baseBranch ?? "main",
			// Branch context is explicit: fresh_branch clears featureBranch,
			// reuse_branch carries forward source attempt's feature branch.
			// Never silently inherited per PRD Section 15.13.
			featureBranch: branchIntent === "reuse_branch" ? snapshot.featureBranch : undefined,
			worktreePath: deterministicWorktreePath,
			startingCommitSha: resolvedCommitSha,
			promptVersion: resolvedPromptVersion,
			promptHash: undefined,
			instanceHostname: undefined,
			instanceStatus: undefined,
			callbackUrl: undefined,
			callbackReceivedAt: undefined,
			debugPreserve: snapshot.debugPreserve,
			executionDurationSeconds: undefined,
			tokenUsage: undefined,
		};
	}

	const now = new Date().toISOString();
	const execution: PersistedTaskExecution = {
		executionId: newExecutionId,
		taskId,
		attemptNumber: newAttemptNumber,
		instanceId: undefined,
		executionMode: latestExecution.executionMode,
		createdAt: now,
		startedAt: undefined,
		completedAt: undefined,
		terminalState: undefined,
		resultSummary: undefined,
		remoteMetadata,
		trigger: "rerun_snapshot",
		// triggerMetadata is finalized by the caller with triggeredBy
		startingCommitSha: resolvedCommitSha,
		promptVersion: resolvedPromptVersion,
		promptHash: snapshot.promptHash,
		branchIntent,
		worktreeIntent:
			branchIntent === "reuse_branch"
				? (snapshot.worktreeIntent ?? deterministicWorktreePath)
				: deterministicWorktreePath,
	};

	return { execution, newAttemptNumber, newExecutionId };
}

// ---------------------------------------------------------------------------
// Validate Source Attempt for Rerun
// ---------------------------------------------------------------------------

function validateSourceAttemptForRerun(
	taskId: string,
	sourceAttemptNumber: number,
	executions: readonly PersistedTaskExecution[],
	currentState: CloudExecutionState,
): { failure: RerunFromSnapshotFailure } | { sourceExecution: PersistedTaskExecution } {
	const sourceExecution = executions.find((e) => e.attemptNumber === sourceAttemptNumber);

	if (!sourceExecution) {
		return {
			failure: {
				success: false,
				taskId,
				reason:
					`Attempt number ${sourceAttemptNumber} not found for task "${taskId}". ` +
					`Available attempts: ${executions.map((e) => e.attemptNumber).join(", ") || "none"}.`,
				code: "attempt_not_found",
			},
		};
	}

	if (!isRetryableState(currentState)) {
		return {
			failure: {
				success: false,
				taskId,
				reason:
					`Task "${taskId}" is currently in state "${currentState}" which does not allow rerun-from-snapshot. ` +
					`Rerun-from-snapshot requires a terminal or post-terminal state.`,
				code: "invalid_source_state",
			},
		};
	}

	return { sourceExecution };
}

// ---------------------------------------------------------------------------
// Rerun-from-Snapshot — Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Rerun a task from a specific prior attempt snapshot.
 *
 * Creates a new execution attempt with:
 * - trigger = `rerun_snapshot`
 * - Snapshot context from the specified source attempt
 * - Explicit branch/worktree intent (never silently inherited)
 * - Source attempt linked but immutable
 *
 * PRD Section 10 Phase 4, Section 15.13, Section 15.14.
 */
export async function rerunFromSnapshot(
	store: CloudExecutionStore,
	options: RerunFromSnapshotOptions,
): Promise<RerunFromSnapshotResult> {
	const {
		taskId,
		sourceAttemptNumber,
		triggeredBy,
		reason,
		commitSha,
		promptVersion,
		branchIntent = DEFAULT_RERUN_BRANCH_INTENT,
	} = options;

	const [currentState, executions] = await Promise.all([
		store.deriveTaskState(taskId),
		store.readExecutionsForTask(taskId),
	]);

	if (executions.length === 0) {
		return {
			success: false,
			taskId,
			reason: `No executions found for task "${taskId}". Cannot rerun a task that has never been executed.`,
			code: "task_not_found",
		};
	}

	const validation = validateSourceAttemptForRerun(taskId, sourceAttemptNumber, executions, currentState);
	if ("failure" in validation) {
		return validation.failure;
	}
	const { sourceExecution } = validation;

	// Extract immutable snapshot from source attempt (source is never modified)
	const snapshot = extractSnapshotFromAttempt(sourceExecution);

	// New attempt number = latest + 1 (sequential, not sourceAttemptNumber + 1)
	const latestExecution = executions[executions.length - 1];
	if (!latestExecution) {
		return {
			success: false,
			taskId,
			reason: `No execution found for task "${taskId}" (unexpected).`,
			code: "task_not_found",
		};
	}

	const { execution, newAttemptNumber, newExecutionId } = buildRerunExecution(
		taskId,
		latestExecution,
		snapshot,
		branchIntent,
		{ commitSha, promptVersion },
	);

	const resolvedCommitSha = commitSha ?? snapshot.commitSha;
	const resolvedPromptVersion = promptVersion ?? snapshot.promptVersion;
	const finalExecution: PersistedTaskExecution = {
		...execution,
		triggerMetadata: {
			triggeredBy,
			reason,
			triggeredAt: new Date().toISOString(),
			sourceState: snapshot.sourceTerminalState,
			previousExecutionId: snapshot.sourceExecutionId,
			previousAttemptNumber: snapshot.sourceAttemptNumber,
			branchIntent,
			pinnedCommitSha: resolvedCommitSha,
			pinnedPromptVersion: resolvedPromptVersion,
		},
	};

	// Persist new execution — source attempt record is never modified
	try {
		await store.createExecution(finalExecution);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			success: false,
			taskId,
			reason: `Failed to persist rerun execution: ${msg}`,
			code: "persistence_error",
		};
	}

	return {
		success: true,
		taskId,
		newExecutionId,
		newAttemptNumber,
		branchIntent,
		snapshot,
		execution: finalExecution,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a specific attempt's snapshot context for inspection.
 * Useful for previewing what a rerun would use without triggering one.
 *
 * Returns `null` if the attempt is not found.
 */
export async function getSnapshotForAttempt(
	store: CloudExecutionStore,
	taskId: string,
	attemptNumber: number,
): Promise<ExecutionSnapshot | null> {
	const executions = await store.readExecutionsForTask(taskId);
	const execution = executions.find((e) => e.attemptNumber === attemptNumber);
	if (!execution) return null;
	return extractSnapshotFromAttempt(execution);
}

/**
 * Check whether a task can be used for rerun-from-snapshot.
 */
export async function canRerunFromSnapshot(
	store: CloudExecutionStore,
	taskId: string,
): Promise<{ allowed: boolean; reason?: string; availableAttempts: number[] }> {
	const [currentState, executions] = await Promise.all([
		store.deriveTaskState(taskId),
		store.readExecutionsForTask(taskId),
	]);

	const availableAttempts = executions.map((e) => e.attemptNumber);

	if (executions.length === 0) {
		return {
			allowed: false,
			reason: `No executions found for task "${taskId}". Cannot rerun a task that has never been executed.`,
			availableAttempts: [],
		};
	}

	if (!isRetryableState(currentState)) {
		return {
			allowed: false,
			reason:
				`Task "${taskId}" is currently in state "${currentState}". ` +
				`Rerun-from-snapshot requires a terminal or post-terminal state.`,
			availableAttempts,
		};
	}

	return { allowed: true, availableAttempts };
}
