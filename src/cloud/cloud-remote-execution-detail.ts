// ---------------------------------------------------------------------------
// Cloud Remote Execution Detail — Task-level metadata aggregation — P3-1
// @phase Phase3
// @prd-section 7, 12, 15.7, 16
// ---------------------------------------------------------------------------
//
// Assembles remote execution metadata from task_executions and task_events
// (A2/B5) into a single queryable shape for task detail/inspection APIs.
//
// Architecture rules (PRD Section 12, Section 16 Task E2):
//   - Metadata is internal/runtime detail, not user-facing board state
//   - Visible board columns (backlog/in_progress/review/trash) are unchanged
//   - Metadata is structured for programmatic consumption
//   - This is the data layer that E3 (streamed logs) and E4 (debug-preserve)
//     build on top of
//
// PRD: Section 7, Section 15.7, Section 16 Task E2
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cloudExecutionStateSchema } from "./cloud-execution-lifecycle";
import {
	type CloudExecutionStore,
	executionModeSchema,
	type PersistedTaskExecution,
	type RemoteExecutionMetadata,
	remoteExecutionMetadataSchema,
} from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Attempt History Entry
// ---------------------------------------------------------------------------

export const attemptHistoryEntrySchema = z.object({
	executionId: z.string().min(1),
	attemptNumber: z.number().int().positive(),
	executionMode: executionModeSchema,
	createdAt: z.string().min(1),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	terminalState: cloudExecutionStateSchema.optional(),
	resultSummary: z.string().optional(),
	instanceId: z.string().optional(),
	remoteMetadata: remoteExecutionMetadataSchema.optional(),
});
export type AttemptHistoryEntry = z.infer<typeof attemptHistoryEntrySchema>;

// ---------------------------------------------------------------------------
// Task Remote Execution Detail
// ---------------------------------------------------------------------------

export const taskRemoteExecutionDetailSchema = z.object({
	taskId: z.string().min(1),
	cloudExecutionState: cloudExecutionStateSchema,
	executionMode: executionModeSchema.optional(),
	instanceId: z.string().optional(),
	instanceHostname: z.string().optional(),
	attemptNumber: z.number().int().positive().optional(),
	attemptHistory: z.array(attemptHistoryEntrySchema),
	promptHash: z.string().optional(),
	promptVersion: z.string().optional(),
	repoUrl: z.string().optional(),
	baseBranch: z.string().optional(),
	featureBranch: z.string().optional(),
	worktreePath: z.string().optional(),
	callbackReceived: z.boolean(),
	callbackReceivedAt: z.string().optional(),
	terminalState: cloudExecutionStateSchema.optional(),
	resultSummary: z.string().optional(),
	executionDurationSeconds: z.number().nonnegative().optional(),
	tokenUsage: z.number().int().nonnegative().optional(),
	debugPreserve: z.boolean().optional(),
	eventCount: z.number().int().nonnegative(),
});
export type TaskRemoteExecutionDetail = z.infer<typeof taskRemoteExecutionDetailSchema>;

// ---------------------------------------------------------------------------
// Request / Response Schemas
// ---------------------------------------------------------------------------

export const taskRemoteExecutionDetailRequestSchema = z.object({
	taskId: z.string().min(1),
});
export type TaskRemoteExecutionDetailRequest = z.infer<typeof taskRemoteExecutionDetailRequestSchema>;

export const taskRemoteExecutionDetailResponseSchema = z.object({
	found: z.boolean(),
	detail: taskRemoteExecutionDetailSchema.nullable(),
});
export type TaskRemoteExecutionDetailResponse = z.infer<typeof taskRemoteExecutionDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Assembly Logic
// ---------------------------------------------------------------------------

function buildAttemptHistoryEntry(execution: PersistedTaskExecution): AttemptHistoryEntry {
	return {
		executionId: execution.executionId,
		attemptNumber: execution.attemptNumber,
		executionMode: execution.executionMode,
		createdAt: execution.createdAt,
		startedAt: execution.startedAt,
		completedAt: execution.completedAt,
		terminalState: execution.terminalState,
		resultSummary: execution.resultSummary,
		instanceId: execution.instanceId,
		remoteMetadata: execution.remoteMetadata,
	};
}

function extractLatestRemoteMetadata(
	executions: readonly PersistedTaskExecution[],
): RemoteExecutionMetadata | undefined {
	for (let i = executions.length - 1; i >= 0; i--) {
		const execution = executions[i];
		if (execution?.remoteMetadata) {
			return execution.remoteMetadata;
		}
	}
	return undefined;
}

/**
 * Assemble a complete TaskRemoteExecutionDetail from the cloud execution store.
 *
 * Returns `null` if the task has no executions AND no events (i.e., the task
 * has never been through the cloud execution path).
 */
export async function assembleTaskRemoteExecutionDetail(
	store: Pick<CloudExecutionStore, "readEventsForTask" | "readExecutionsForTask" | "deriveTaskState">,
	taskId: string,
): Promise<TaskRemoteExecutionDetail | null> {
	const [events, executions, cloudExecutionState] = await Promise.all([
		store.readEventsForTask(taskId),
		store.readExecutionsForTask(taskId),
		store.deriveTaskState(taskId),
	]);

	if (events.length === 0 && executions.length === 0) {
		return null;
	}

	const latestExecution = executions[executions.length - 1];
	const latestMetadata = extractLatestRemoteMetadata(executions);
	const attemptHistory = executions.map(buildAttemptHistoryEntry);
	const callbackReceivedAt = latestMetadata?.callbackReceivedAt ?? undefined;

	return {
		taskId,
		cloudExecutionState,
		executionMode: latestExecution?.executionMode,
		instanceId: latestMetadata?.instanceId ?? latestExecution?.instanceId,
		instanceHostname: latestMetadata?.instanceHostname,
		attemptNumber: latestExecution?.attemptNumber,
		attemptHistory,
		promptHash: latestMetadata?.promptHash,
		promptVersion: latestMetadata?.promptVersion,
		repoUrl: latestMetadata?.repoUrl,
		baseBranch: latestMetadata?.baseBranch,
		featureBranch: latestMetadata?.featureBranch,
		worktreePath: latestMetadata?.worktreePath,
		callbackReceived: !!callbackReceivedAt,
		callbackReceivedAt,
		terminalState: latestExecution?.terminalState,
		resultSummary: latestExecution?.resultSummary,
		executionDurationSeconds: latestMetadata?.executionDurationSeconds,
		tokenUsage: latestMetadata?.tokenUsage,
		debugPreserve: latestMetadata?.debugPreserve,
		eventCount: events.length,
	};
}
