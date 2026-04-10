// ---------------------------------------------------------------------------
// Cloud Execution Timeline — Rich execution history and timeline — P2-5
// @phase Phase2
// @prd-section 7, 10, 15.7, 20.1
// ---------------------------------------------------------------------------
//
// Provides queryable execution timeline, attempt comparison, and execution
// summary for cloud-agent tasks. This is the data foundation for Phase 3/4
// runtime views and artifact browsing.
//
// Architecture rules:
//   - Execution history is append-only; past events are immutable
//   - Each attempt is a complete record; no cross-attempt state leaking
//   - Timeline is ordered and correlatable to task_id + attempt_number
//   - History preserves branch/worktree fidelity for each attempt
//
// PRD: Section 7 (Data Model), Section 10 Phase 2/4, Section 15.7,
//      Section 20.1 (Tracker)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { type CloudExecutionState, cloudExecutionStateSchema } from "./cloud-execution-lifecycle";
import {
	type CloudExecutionStore,
	executionModeSchema,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
	teardownDecisionSchema,
} from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Timeline Entry Categories
// ---------------------------------------------------------------------------

/**
 * The category of a timeline entry, used to classify and filter events.
 */
export const timelineEntryCategorySchema = z.enum([
	"lifecycle",
	"reconciler",
	"cancel",
	"retry",
	"replay",
	"teardown",
	"callback",
]);
export type TimelineEntryCategory = z.infer<typeof timelineEntryCategorySchema>;

// ---------------------------------------------------------------------------
// Execution Timeline Entry
// ---------------------------------------------------------------------------

export const executionTimelineEntrySchema = z.object({
	eventId: z.string().min(1),
	taskId: z.string().min(1),
	attemptNumber: z.number().int().nonnegative(),
	category: timelineEntryCategorySchema,
	timestamp: z.string().min(1),
	fromState: cloudExecutionStateSchema.optional(),
	toState: cloudExecutionStateSchema.optional(),
	trigger: z.string().optional(),
	triggerSource: z.string().optional(),
	summary: z.string().min(1),
	metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ExecutionTimelineEntry = z.infer<typeof executionTimelineEntrySchema>;

// ---------------------------------------------------------------------------
// Timeline Query Result
// ---------------------------------------------------------------------------

export const executionTimelineSchema = z.object({
	taskId: z.string().min(1),
	totalEntries: z.number().int().nonnegative(),
	entries: z.array(executionTimelineEntrySchema),
});
export type ExecutionTimeline = z.infer<typeof executionTimelineSchema>;

// ---------------------------------------------------------------------------
// Attempt Comparison
// ---------------------------------------------------------------------------

export const attemptDiffFieldSchema = z.object({
	field: z.string().min(1),
	before: z.unknown().optional(),
	after: z.unknown().optional(),
});
export type AttemptDiffField = z.infer<typeof attemptDiffFieldSchema>;

export const attemptComparisonSchema = z.object({
	taskId: z.string().min(1),
	beforeAttempt: z.number().int().positive(),
	afterAttempt: z.number().int().positive(),
	diffs: z.array(attemptDiffFieldSchema),
	beforeOutcome: cloudExecutionStateSchema.optional(),
	afterOutcome: cloudExecutionStateSchema.optional(),
});
export type AttemptComparison = z.infer<typeof attemptComparisonSchema>;

// ---------------------------------------------------------------------------
// Execution Summary
// ---------------------------------------------------------------------------

export const executionSummarySchema = z.object({
	taskId: z.string().min(1),
	totalAttempts: z.number().int().nonnegative(),
	lastAttemptOutcome: cloudExecutionStateSchema.optional(),
	hasBeenRetried: z.boolean(),
	hasBeenReplayed: z.boolean(),
	currentState: cloudExecutionStateSchema,
	executionMode: executionModeSchema.optional(),
	outcomePattern: z.array(cloudExecutionStateSchema.optional()),
	timeInStates: z.record(z.string(), z.number().nonnegative()),
	totalDurationSeconds: z.number().nonnegative(),
	totalTokenUsage: z.number().int().nonnegative(),
	latestAttemptNumber: z.number().int().nonnegative(),
	latestExecutionId: z.string().optional(),
	currentInstanceId: z.string().optional(),
	teardownDecision: teardownDecisionSchema.optional(),
});
export type ExecutionSummary = z.infer<typeof executionSummarySchema>;

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

export type TimelineStore = Pick<
	CloudExecutionStore,
	"readEventsForTask" | "readExecutionsForTask" | "deriveTaskState"
>;

// ---------------------------------------------------------------------------
// Internal Helpers — Classification
// ---------------------------------------------------------------------------

function classifyEvent(event: PersistedTaskEvent): TimelineEntryCategory {
	const meta = event.metadata as Record<string, unknown> | undefined;

	if (meta?.reconcilerAction || meta?.staleRecovery) return "reconciler";
	if (event.trigger === "auto_teardown" || event.trigger === "sandbox_terminated") return "teardown";
	if (event.trigger === "user_cancel") return "cancel";
	if (event.triggerSource === "callback") return "callback";
	if (meta?.retryTrigger === true || meta?.type === "retry") return "retry";
	if (meta?.replayTrigger === true || meta?.type === "replay") return "replay";

	return "lifecycle";
}

function buildEventSummary(event: PersistedTaskEvent, category: TimelineEntryCategory): string {
	const meta = event.metadata as Record<string, unknown> | undefined;

	switch (category) {
		case "reconciler": {
			const reason = meta?.reason ?? meta?.reconcilerAction ?? "reconciler action";
			return `Reconciler: ${reason}`;
		}
		case "cancel":
			return `Canceled from ${event.fromState}`;
		case "teardown":
			if (event.trigger === "auto_teardown") return `Auto teardown from ${event.fromState}`;
			return `Sandbox terminated → ${event.toState}`;
		case "callback": {
			const status = meta?.callbackStatus ?? event.trigger;
			return `Callback received: ${status}`;
		}
		case "retry":
			return `Retry triggered from ${event.fromState}`;
		case "replay":
			return `Replay triggered from ${event.fromState}`;
		default:
			return `${event.fromState} → ${event.toState} (${event.trigger})`;
	}
}

function resolveAttemptNumber(event: PersistedTaskEvent, executions: readonly PersistedTaskExecution[]): number {
	const meta = event.metadata as Record<string, unknown> | undefined;
	if (meta?.attemptNumber && typeof meta.attemptNumber === "number") return meta.attemptNumber;
	if (executions.length === 0) return 0;
	if (executions.length === 1) return executions[0]?.attemptNumber ?? 1;

	const eventTs = Date.parse(event.timestamp);
	let bestMatch: PersistedTaskExecution | undefined;
	for (const exec of executions) {
		const createdTs = Date.parse(exec.createdAt);
		if (createdTs <= eventTs) {
			if (!bestMatch || exec.attemptNumber > bestMatch.attemptNumber) {
				bestMatch = exec;
			}
		}
	}
	return bestMatch?.attemptNumber ?? executions[0]?.attemptNumber ?? 0;
}

// ---------------------------------------------------------------------------
// Timeline Query
// ---------------------------------------------------------------------------

/**
 * Query the full execution timeline for a task.
 *
 * Returns an ordered list of all events across all attempts, classified
 * by category. Events are ordered by timestamp ascending (stable).
 */
export async function queryExecutionTimeline(store: TimelineStore, taskId: string): Promise<ExecutionTimeline> {
	const [events, executions] = await Promise.all([
		store.readEventsForTask(taskId),
		store.readExecutionsForTask(taskId),
	]);

	const entries: ExecutionTimelineEntry[] = events.map((event) => {
		const category = classifyEvent(event);
		const attemptNumber = resolveAttemptNumber(event, executions);
		return {
			eventId: event.eventId,
			taskId: event.taskId,
			attemptNumber,
			category,
			timestamp: event.timestamp,
			fromState: event.fromState as CloudExecutionState | undefined,
			toState: event.toState as CloudExecutionState | undefined,
			trigger: event.trigger,
			triggerSource: event.triggerSource,
			summary: buildEventSummary(event, category),
			metadata: event.metadata,
		};
	});

	entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

	return { taskId, totalEntries: entries.length, entries };
}

/**
 * Query timeline entries for a specific attempt only.
 */
export async function queryAttemptTimeline(
	store: TimelineStore,
	taskId: string,
	attemptNumber: number,
): Promise<ExecutionTimeline> {
	const full = await queryExecutionTimeline(store, taskId);
	const filtered = full.entries.filter((e) => e.attemptNumber === attemptNumber);
	return { taskId, totalEntries: filtered.length, entries: filtered };
}

/**
 * Query timeline entries by category.
 */
export async function queryTimelineByCategory(
	store: TimelineStore,
	taskId: string,
	category: TimelineEntryCategory,
): Promise<ExecutionTimeline> {
	const full = await queryExecutionTimeline(store, taskId);
	const filtered = full.entries.filter((e) => e.category === category);
	return { taskId, totalEntries: filtered.length, entries: filtered };
}

// ---------------------------------------------------------------------------
// Attempt Comparison
// ---------------------------------------------------------------------------

const COMPARISON_FIELDS: readonly (keyof PersistedTaskExecution)[] = [
	"branchIntent",
	"worktreeIntent",
	"startingCommitSha",
	"promptHash",
	"promptVersion",
	"hostname",
	"executionMode",
	"trigger",
];

/**
 * Compare two execution attempts and return the differences.
 * Returns `null` if either attempt is not found.
 */
export async function compareAttempts(
	store: TimelineStore,
	taskId: string,
	beforeAttemptNumber: number,
	afterAttemptNumber: number,
): Promise<AttemptComparison | null> {
	const executions = await store.readExecutionsForTask(taskId);
	const before = executions.find((e) => e.attemptNumber === beforeAttemptNumber);
	const after = executions.find((e) => e.attemptNumber === afterAttemptNumber);
	if (!before || !after) return null;

	const diffs: AttemptDiffField[] = [];

	for (const field of COMPARISON_FIELDS) {
		const beforeVal = before[field];
		const afterVal = after[field];
		if (beforeVal !== afterVal) diffs.push({ field, before: beforeVal, after: afterVal });
	}

	// Compare remoteMetadata sub-fields
	const bm = before.remoteMetadata;
	const am = after.remoteMetadata;
	if (bm || am) {
		const metaFields = [
			"baseBranch",
			"featureBranch",
			"startingCommitSha",
			"promptHash",
			"promptVersion",
			"repoUrl",
		] as const;
		for (const field of metaFields) {
			const bv = bm?.[field];
			const av = am?.[field];
			if (bv !== av && !diffs.some((d) => d.field === field)) {
				diffs.push({ field: `remoteMetadata.${field}`, before: bv, after: av });
			}
		}
	}

	// Compare trigger metadata snapshot context
	const bt = before.triggerMetadata;
	const at = after.triggerMetadata;
	if (bt?.pinnedCommitSha !== at?.pinnedCommitSha && (bt?.pinnedCommitSha || at?.pinnedCommitSha)) {
		diffs.push({ field: "triggerMetadata.pinnedCommitSha", before: bt?.pinnedCommitSha, after: at?.pinnedCommitSha });
	}
	if (bt?.pinnedPromptVersion !== at?.pinnedPromptVersion && (bt?.pinnedPromptVersion || at?.pinnedPromptVersion)) {
		diffs.push({
			field: "triggerMetadata.pinnedPromptVersion",
			before: bt?.pinnedPromptVersion,
			after: at?.pinnedPromptVersion,
		});
	}

	return {
		taskId,
		beforeAttempt: beforeAttemptNumber,
		afterAttempt: afterAttemptNumber,
		diffs,
		beforeOutcome: before.terminalState,
		afterOutcome: after.terminalState,
	};
}

// ---------------------------------------------------------------------------
// Execution Summary
// ---------------------------------------------------------------------------

/**
 * Build a rich execution summary for a task card detail view.
 * Returns `null` if the task has no execution history.
 */
export async function buildExecutionSummary(store: TimelineStore, taskId: string): Promise<ExecutionSummary | null> {
	const [events, executions, currentState] = await Promise.all([
		store.readEventsForTask(taskId),
		store.readExecutionsForTask(taskId),
		store.deriveTaskState(taskId),
	]);

	if (events.length === 0 && executions.length === 0) return null;

	const latestExecution = executions[executions.length - 1];
	const outcomePattern = executions.map((e) => e.terminalState);

	let hasBeenRetried = false;
	let hasBeenReplayed = false;
	for (const exec of executions) {
		if (exec.trigger === "retry") hasBeenRetried = true;
		if (exec.trigger === "replay") hasBeenReplayed = true;
	}

	let totalDurationSeconds = 0;
	let totalTokenUsage = 0;
	for (const exec of executions) {
		if (exec.durationSeconds !== undefined) {
			totalDurationSeconds += exec.durationSeconds;
		} else if (exec.startedAt && exec.completedAt) {
			const s = Date.parse(exec.startedAt);
			const e = Date.parse(exec.completedAt);
			if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) totalDurationSeconds += (e - s) / 1000;
		}
		if (exec.tokenUsage !== undefined) {
			totalTokenUsage += exec.tokenUsage;
		} else if (exec.remoteMetadata?.tokenUsage !== undefined) {
			totalTokenUsage += exec.remoteMetadata.tokenUsage;
		}
	}

	const timeInStates: Record<string, number> = {};
	for (let i = 0; i < events.length; i++) {
		const evt = events[i];
		if (!evt) continue;
		const next = events[i + 1];
		if (next) {
			const from = Date.parse(evt.timestamp);
			const to = Date.parse(next.timestamp);
			if (!Number.isNaN(from) && !Number.isNaN(to) && to >= from) {
				const state = evt.toState;
				timeInStates[state] = (timeInStates[state] ?? 0) + (to - from) / 1000;
			}
		}
	}

	return {
		taskId,
		totalAttempts: executions.length,
		lastAttemptOutcome: latestExecution?.terminalState,
		hasBeenRetried,
		hasBeenReplayed,
		currentState,
		executionMode: latestExecution?.executionMode,
		outcomePattern,
		timeInStates,
		totalDurationSeconds,
		totalTokenUsage,
		latestAttemptNumber: latestExecution?.attemptNumber ?? 0,
		latestExecutionId: latestExecution?.executionId,
		currentInstanceId: latestExecution?.instanceId ?? latestExecution?.remoteMetadata?.instanceId,
		teardownDecision: latestExecution?.teardownDecision,
	};
}
