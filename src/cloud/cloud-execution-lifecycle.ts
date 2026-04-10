import { z } from "zod";

// ---------------------------------------------------------------------------
// Cloud Execution Lifecycle States
// ---------------------------------------------------------------------------

/**
 * Canonical cloud execution lifecycle states.
 *
 * These states track remote execution progress inside cloud-platform sandboxes
 * and are entirely separate from visible Kanban board columns
 * (backlog / in_progress / review / trash).
 */
export const cloudExecutionStateSchema = z.enum([
	"draft",
	"queued",
	"policy_check",
	"provisioning",
	"running",
	"completing",
	"completed",
	"failed",
	"canceled",
	"teardown",
	"archived",
]);
export type CloudExecutionState = z.infer<typeof cloudExecutionStateSchema>;

// ---------------------------------------------------------------------------
// Transition Triggers
// ---------------------------------------------------------------------------

/**
 * Named triggers that cause state transitions.
 * Each trigger maps to exactly one valid (from -> to) edge in the state diagram.
 */
export const cloudExecutionTriggerSchema = z.enum([
	"submit",
	"dequeue",
	"authorized",
	"denied",
	"sandbox_ready",
	"provision_timeout",
	"execution_done",
	"execution_error",
	"user_cancel",
	"finalize_success",
	"finalize_error",
	"auto_teardown",
	"sandbox_terminated",
]);
export type CloudExecutionTrigger = z.infer<typeof cloudExecutionTriggerSchema>;

// ---------------------------------------------------------------------------
// Transition Table
// ---------------------------------------------------------------------------

export interface CloudExecutionTransitionEdge {
	readonly from: CloudExecutionState;
	readonly trigger: CloudExecutionTrigger;
	readonly to: CloudExecutionState;
}

/**
 * Complete set of valid transitions per PRD Section 3 / Section 15.5.
 * This is the single source of truth for what transitions the validator accepts.
 */
export const CLOUD_EXECUTION_TRANSITIONS: readonly CloudExecutionTransitionEdge[] = [
	{ from: "draft", trigger: "submit", to: "queued" },
	{ from: "queued", trigger: "dequeue", to: "policy_check" },
	{ from: "policy_check", trigger: "authorized", to: "provisioning" },
	{ from: "policy_check", trigger: "denied", to: "failed" },
	{ from: "provisioning", trigger: "sandbox_ready", to: "running" },
	{ from: "provisioning", trigger: "provision_timeout", to: "failed" },
	{ from: "running", trigger: "execution_done", to: "completing" },
	{ from: "running", trigger: "execution_error", to: "failed" },
	{ from: "running", trigger: "user_cancel", to: "canceled" },
	{ from: "completing", trigger: "finalize_success", to: "completed" },
	{ from: "completing", trigger: "finalize_error", to: "failed" },
	{ from: "completed", trigger: "auto_teardown", to: "teardown" },
	{ from: "failed", trigger: "auto_teardown", to: "teardown" },
	{ from: "canceled", trigger: "auto_teardown", to: "teardown" },
	{ from: "teardown", trigger: "sandbox_terminated", to: "archived" },
] as const;

// ---------------------------------------------------------------------------
// Internal Lookup Structures
// ---------------------------------------------------------------------------

function transitionKey(from: CloudExecutionState, trigger: CloudExecutionTrigger): string {
	return `${from}::${trigger}`;
}

const transitionMap: ReadonlyMap<string, CloudExecutionState> = new Map(
	CLOUD_EXECUTION_TRANSITIONS.map((edge) => [transitionKey(edge.from, edge.trigger), edge.to]),
);

const validFromStates: ReadonlyMap<CloudExecutionState, ReadonlySet<CloudExecutionTrigger>> = (() => {
	const map = new Map<CloudExecutionState, Set<CloudExecutionTrigger>>();
	for (const edge of CLOUD_EXECUTION_TRANSITIONS) {
		let triggers = map.get(edge.from);
		if (!triggers) {
			triggers = new Set();
			map.set(edge.from, triggers);
		}
		triggers.add(edge.trigger);
	}
	return map;
})();

// ---------------------------------------------------------------------------
// State Classification Helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATES: ReadonlySet<CloudExecutionState> = new Set<CloudExecutionState>([
	"completed",
	"failed",
	"canceled",
]);

const ACTIVE_SANDBOX_STATES: ReadonlySet<CloudExecutionState> = new Set<CloudExecutionState>([
	"provisioning",
	"running",
	"completing",
	"completed",
	"failed",
	"canceled",
	"teardown",
]);

/**
 * Returns `true` if the state is a terminal execution outcome
 * (completed, failed, or canceled).
 * Terminal states always transition to `teardown` then `archived`.
 */
export function isTerminalState(state: CloudExecutionState): boolean {
	return TERMINAL_STATES.has(state);
}

/**
 * Returns `true` if the state implies an active (or recently active) sandbox
 * exists in cloud-platform.
 */
export function isActiveSandboxState(state: CloudExecutionState): boolean {
	return ACTIVE_SANDBOX_STATES.has(state);
}

/**
 * Returns `true` if no further transitions are possible from this state.
 */
export function isFinalState(state: CloudExecutionState): boolean {
	return state === "archived";
}

// ---------------------------------------------------------------------------
// Transition Validation
// ---------------------------------------------------------------------------

export type CloudExecutionTransitionResult =
	| {
			readonly valid: true;
			readonly from: CloudExecutionState;
			readonly to: CloudExecutionState;
			readonly trigger: CloudExecutionTrigger;
	  }
	| {
			readonly valid: false;
			readonly from: CloudExecutionState;
			readonly trigger: CloudExecutionTrigger;
			readonly reason: string;
	  };

/**
 * Validate whether a transition is allowed from the given state with the
 * given trigger.
 *
 * This is the **central** validation point — all cloud execution state
 * changes must pass through this function.
 */
export function validateCloudExecutionTransition(
	from: CloudExecutionState,
	trigger: CloudExecutionTrigger,
): CloudExecutionTransitionResult {
	const to = transitionMap.get(transitionKey(from, trigger));
	if (to !== undefined) {
		return { valid: true, from, to, trigger };
	}

	const allowedTriggers = validFromStates.get(from);
	if (!allowedTriggers || allowedTriggers.size === 0) {
		return {
			valid: false,
			from,
			trigger,
			reason: `State "${from}" is a terminal state with no outgoing transitions.`,
		};
	}

	const allowedList = Array.from(allowedTriggers).sort().join(", ");
	return {
		valid: false,
		from,
		trigger,
		reason: `Trigger "${trigger}" is not valid from state "${from}". Valid triggers: ${allowedList}.`,
	};
}

/**
 * Returns the set of triggers that are valid from the given state.
 */
export function getValidTriggers(from: CloudExecutionState): readonly CloudExecutionTrigger[] {
	const triggers = validFromStates.get(from);
	return triggers ? Array.from(triggers).sort() : [];
}

// ---------------------------------------------------------------------------
// Append-Only Event Model
// ---------------------------------------------------------------------------

/**
 * A single append-only lifecycle event recorded in `task_events`.
 * Events are immutable once written.  `task.current_state` is always derived
 * from the latest accepted event via {@link deriveCurrentState}.
 */
export const cloudExecutionEventSchema = z.object({
	eventId: z.string().min(1),
	taskId: z.string().min(1),
	trigger: cloudExecutionTriggerSchema,
	fromState: cloudExecutionStateSchema,
	toState: cloudExecutionStateSchema,
	timestamp: z.string().min(1),
	idempotencyKey: z.string().optional(),
});
export type CloudExecutionEvent = z.infer<typeof cloudExecutionEventSchema>;

/**
 * Derive the current cloud execution state from an ordered list of accepted
 * events.  If the event list is empty, the task is implicitly in `draft`.
 */
export function deriveCurrentState(events: readonly Pick<CloudExecutionEvent, "toState">[]): CloudExecutionState {
	if (events.length === 0) {
		return "draft";
	}
	const lastEvent = events[events.length - 1];
	if (!lastEvent) {
		return "draft";
	}
	return lastEvent.toState;
}

// ---------------------------------------------------------------------------
// Transition Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when an invalid cloud execution state transition is attempted.
 */
export class CloudExecutionTransitionError extends Error {
	readonly from: CloudExecutionState;
	readonly trigger: CloudExecutionTrigger;

	constructor(result: Extract<CloudExecutionTransitionResult, { valid: false }>) {
		super(result.reason);
		this.name = "CloudExecutionTransitionError";
		this.from = result.from;
		this.trigger = result.trigger;
	}
}
