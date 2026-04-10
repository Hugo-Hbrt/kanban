import type { CloudExecutionState, CloudExecutionTrigger } from "./cloud-execution-lifecycle";
import { type CloudInstanceState, cloudInstanceStateSchema } from "./cloud-instance-client";

// ---------------------------------------------------------------------------
// Cloud Instance State → Kanban Lifecycle Mapping
// ---------------------------------------------------------------------------

/**
 * The Kanban lifecycle phase that a cloud instance state maps to.
 *
 * This is a constrained subset of {@link CloudExecutionState} — only the
 * phases that correspond to observable cloud-platform instance states.
 */
export type KanbanLifecyclePhase = "provisioning" | "running" | "teardown" | "failed";

/**
 * Result of mapping a cloud instance state to a Kanban lifecycle phase.
 */
export interface CloudStateMapping {
	/** The cloud-platform instance state that was mapped. */
	readonly cloudState: CloudInstanceState;
	/** The Kanban lifecycle phase this cloud state maps to. */
	readonly kanbanPhase: KanbanLifecyclePhase;
	/**
	 * If the mapped state should trigger a Kanban lifecycle transition,
	 * this is the trigger to fire.  `null` means the state is expected
	 * during the current phase and does not cause a transition.
	 */
	readonly trigger: CloudExecutionTrigger | null;
	/**
	 * Whether this state indicates the instance has reached a terminal
	 * condition on the cloud side (ready for execution, or failed/terminated).
	 */
	readonly isCloudTerminal: boolean;
}

// ---------------------------------------------------------------------------
// Explicit Mapping Table
// ---------------------------------------------------------------------------

/**
 * Deterministic, explicit mapping from every recognised cloud-platform
 * instance state to a Kanban lifecycle phase and optional trigger.
 *
 * Architecture rule (PRD Section 12):
 *   "State mapping must be explicit, not inferred from heuristics."
 *
 * PRD Section 4 mapping table:
 *   Cloud requested/creating/ready    → Kanban provisioning
 *   Cloud ready                       → triggers provisioning → running transition
 *   Cloud executing                   → Kanban running
 *   Cloud stopping/terminated         → Kanban teardown
 *
 * PRD Section 15.5 code-grounded notes:
 *   Current cloud-platform values: provisioning, starting, ready, unhealthy, failed
 */
const CLOUD_STATE_MAP: Record<CloudInstanceState, Omit<CloudStateMapping, "cloudState">> = {
	// -- Currently verified API values --

	/** Instance provision request accepted, image pull / env setup in progress. */
	provisioning: {
		kanbanPhase: "provisioning",
		trigger: null,
		isCloudTerminal: false,
	},

	/** Instance is starting up (post-create, pre-ready). */
	starting: {
		kanbanPhase: "provisioning",
		trigger: null,
		isCloudTerminal: false,
	},

	/**
	 * Instance is ready to accept `/run`.
	 * This triggers the Kanban provisioning → running transition.
	 */
	ready: {
		kanbanPhase: "provisioning",
		trigger: "sandbox_ready",
		isCloudTerminal: true,
	},

	/** Instance is in an unhealthy / unrecoverable state. */
	unhealthy: {
		kanbanPhase: "failed",
		trigger: "provision_timeout",
		isCloudTerminal: true,
	},

	/** Instance provisioning failed outright. */
	failed: {
		kanbanPhase: "failed",
		trigger: "provision_timeout",
		isCloudTerminal: true,
	},

	// -- Target lifecycle values from PRD Section 4 --

	/** Provision request recorded but not yet started. */
	requested: {
		kanbanPhase: "provisioning",
		trigger: null,
		isCloudTerminal: false,
	},

	/** Instance is being created (image pull + env config). */
	creating: {
		kanbanPhase: "provisioning",
		trigger: null,
		isCloudTerminal: false,
	},

	/** Task execution is in progress inside the sandbox. */
	executing: {
		kanbanPhase: "running",
		trigger: null,
		isCloudTerminal: false,
	},

	/** Sandbox is shutting down. */
	stopping: {
		kanbanPhase: "teardown",
		trigger: null,
		isCloudTerminal: true,
	},

	/** Sandbox has been fully terminated and cleaned up. */
	terminated: {
		kanbanPhase: "teardown",
		trigger: null,
		isCloudTerminal: true,
	},
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a cloud-platform instance state to its corresponding Kanban lifecycle
 * phase, trigger, and terminal flag.
 *
 * This function is **deterministic** — the same input always produces the
 * same output.  It covers every value in {@link CloudInstanceState}.
 */
export function mapCloudInstanceState(cloudState: CloudInstanceState): CloudStateMapping {
	const mapping = CLOUD_STATE_MAP[cloudState];
	return { cloudState, ...mapping };
}

/**
 * Returns `true` if the cloud instance state indicates the instance is
 * ready for execution (i.e. `/run` can be invoked).
 */
export function isInstanceReady(cloudState: CloudInstanceState): boolean {
	return cloudState === "ready";
}

/**
 * Returns `true` if the cloud instance state indicates a failure that
 * should transition the Kanban task to `failed`.
 */
export function isInstanceFailed(cloudState: CloudInstanceState): boolean {
	return cloudState === "failed" || cloudState === "unhealthy";
}

/**
 * Returns all recognised cloud-platform instance states.
 */
export function getAllCloudInstanceStates(): readonly CloudInstanceState[] {
	return cloudInstanceStateSchema.options as readonly CloudInstanceState[];
}
