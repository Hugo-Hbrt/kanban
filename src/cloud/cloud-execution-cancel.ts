import { randomUUID } from "node:crypto";

import type { CloudExecutionState } from "./cloud-execution-lifecycle";
import {
	isActiveSandboxState,
	isFinalState,
	isPreTerminalState,
	isTerminalState,
	validateCloudExecutionTransition,
} from "./cloud-execution-lifecycle";
import type { EventTriggerSource, PersistedTaskEvent, PersistedTaskExecution } from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Cancel Request
// ---------------------------------------------------------------------------

/**
 * Who or what triggered the cancellation.
 * PRD Section 6.2: Record who/what triggered the cancel.
 */
export interface CancelActor {
	/** Type of actor: user, api_caller, or system. */
	readonly type: "user" | "api_caller" | "system";
	/** Unique identifier for the actor (user ID, API key ID, etc.). */
	readonly id: string;
	/** Optional human-readable name. */
	readonly name?: string;
}

export interface CancelCloudExecutionRequest {
	readonly taskId: string;
	readonly actor: CancelActor;
	readonly reason?: string;
	readonly idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Cancel Result
// ---------------------------------------------------------------------------

export type CancelCloudExecutionResult =
	| {
			readonly canceled: true;
			readonly taskId: string;
			readonly previousState: CloudExecutionState;
			readonly instanceDeletionTriggered: boolean;
			readonly teardownTriggered: boolean;
			readonly eventsAppended: number;
	  }
	| {
			readonly canceled: false;
			readonly taskId: string;
			readonly reason: string;
			/** True if the task is already canceled or terminal — idempotent no-op. */
			readonly idempotentNoOp: boolean;
	  };

// ---------------------------------------------------------------------------
// Cancel Context (dependency injection)
// ---------------------------------------------------------------------------

export interface CancelExecutionContext {
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
	/** Delete a cloud instance. Best-effort; failure does not block cancel. */
	deleteInstance(instanceId: string): Promise<void>;
	/** Optional clock override for deterministic testing. */
	now?(): string;
}

// ---------------------------------------------------------------------------
// Main Cancel Function
// ---------------------------------------------------------------------------

/**
 * Cancel a cloud execution task from any pre-terminal state.
 *
 * PRD Section 6.2: User cancels → state=canceled → DELETE /instances/{id}
 * → teardown → archived.
 *
 * Architecture invariants:
 * - Cancel goes through the lifecycle validator.
 * - Events are persisted BEFORE triggering side effects.
 * - Cancel is idempotent across all states.
 * - Branch/worktree intent is preserved in execution record.
 */
export async function cancelCloudExecution(
	request: CancelCloudExecutionRequest,
	ctx: CancelExecutionContext,
): Promise<CancelCloudExecutionResult> {
	const { taskId, actor, reason, idempotencyKey } = request;
	const nowFn = ctx.now ?? (() => new Date().toISOString());
	const timestamp = nowFn();

	// 1. Derive current state from persistence (crash-safe).
	const currentState = await ctx.deriveTaskState(taskId);

	// 2. Idempotency: already canceled/terminal/post-terminal → no-op.
	if (currentState === "canceled") {
		return {
			canceled: false,
			taskId,
			reason: `Task ${taskId} is already canceled.`,
			idempotentNoOp: true,
		};
	}

	if (isTerminalState(currentState) || currentState === "teardown" || isFinalState(currentState)) {
		return {
			canceled: false,
			taskId,
			reason: `Task ${taskId} is in state "${currentState}". Cancel is a no-op.`,
			idempotentNoOp: true,
		};
	}

	// 3. Validate user_cancel from current state.
	if (!isPreTerminalState(currentState)) {
		return {
			canceled: false,
			taskId,
			reason: `State "${currentState}" does not support cancellation.`,
			idempotentNoOp: false,
		};
	}

	const transitionResult = validateCloudExecutionTransition(currentState, "user_cancel");
	if (!transitionResult.valid) {
		return {
			canceled: false,
			taskId,
			reason: transitionResult.reason,
			idempotentNoOp: false,
		};
	}

	// 4. Build cancel + auto-teardown events.
	const events: PersistedTaskEvent[] = [];

	const cancelEvent: PersistedTaskEvent = {
		eventId: idempotencyKey ?? randomUUID(),
		taskId,
		trigger: "user_cancel",
		fromState: transitionResult.from,
		toState: transitionResult.to,
		timestamp,
		triggerSource: "user" as EventTriggerSource,
		metadata: {
			cancelActor: actor,
			cancelReason: reason,
			cancelledFromState: currentState,
		},
	};
	events.push(cancelEvent);

	const teardownTransition = validateCloudExecutionTransition("canceled", "auto_teardown");
	let teardownTriggered = false;
	if (teardownTransition.valid) {
		events.push({
			eventId: randomUUID(),
			taskId,
			trigger: "auto_teardown",
			fromState: "canceled",
			toState: teardownTransition.to,
			timestamp: nowFn(),
			triggerSource: "system" as EventTriggerSource,
			metadata: { autoTeardown: true, triggeredByCancel: true },
		});
		teardownTriggered = true;
	}

	// 5. Persist events BEFORE side effects.
	const firstEvent = events[0];
	if (events.length === 1 && firstEvent) {
		await ctx.appendEvent(firstEvent);
	} else {
		await ctx.appendEvents(events);
	}

	// 6. Update execution record.
	let instanceDeletionTriggered = false;
	const executions = await ctx.readExecutionsForTask(taskId);
	const latest = executions[executions.length - 1];

	if (latest) {
		const summary = `canceled; actor=${actor.type}:${actor.id}` + (reason ? `; reason=${reason}` : "");
		await ctx.updateExecution(latest.executionId, {
			terminalState: "canceled",
			completedAt: timestamp,
			resultSummary: summary,
		});

		// 7. Delete instance if one exists.
		const instanceId = latest.instanceId ?? latest.remoteMetadata?.instanceId;
		if (instanceId && isActiveSandboxState(currentState)) {
			instanceDeletionTriggered = true;
			try {
				await ctx.deleteInstance(instanceId);
			} catch {
				// Best-effort; teardown handler retries if needed.
			}
		}
	}

	return {
		canceled: true,
		taskId,
		previousState: currentState,
		instanceDeletionTriggered,
		teardownTriggered,
		eventsAppended: events.length,
	};
}
