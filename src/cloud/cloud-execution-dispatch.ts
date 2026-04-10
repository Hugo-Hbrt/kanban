// ---------------------------------------------------------------------------
// Cloud Execution Dispatch — Route tasks to local or cloud execution — B6
// @phase MVP
// @prd-section 12, 15.9, 16
// ---------------------------------------------------------------------------
//
// Determines the effective execution path for a task based on:
//   1. The task's execution_mode field (local_agent | cloud_agent)
//   2. The cloud-agent feature flag + allowlist state
//
// Architecture rules (PRD Section 12):
//   - Cloud-agent execution is additive, not a replacement
//   - Local-agent path must never break regardless of feature flag state
//   - Feature flag + allowlist must gate access for MVP internal rollout
//
// PRD: Section 15.9, Section 16 Task B6
// ---------------------------------------------------------------------------

import { type CloudAgentFeatureFlagContext, evaluateCloudAgentFeatureFlag } from "./cloud-agent-feature-flag";
import type { ExecutionMode } from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Dispatch Result
// ---------------------------------------------------------------------------

export type ExecutionDispatchPath = "local" | "cloud";

export interface ExecutionDispatchResult {
	/** The resolved execution path. */
	readonly path: ExecutionDispatchPath;
	/** The task's requested execution mode. */
	readonly requestedMode: ExecutionMode;
	/** Whether the cloud-agent feature flag is enabled. */
	readonly cloudAgentEnabled: boolean;
	/**
	 * Reason for the dispatch decision.
	 * Useful for logging/debugging.
	 */
	readonly reason: string;
}

// ---------------------------------------------------------------------------
// Dispatch Logic
// ---------------------------------------------------------------------------

/**
 * Resolve the execution path for a task.
 *
 * Rules:
 * - If the task's execution_mode is "local_agent", always route locally.
 * - If the task's execution_mode is "cloud_agent":
 *   - Route to cloud ONLY if the feature flag + allowlist allows it.
 *   - Otherwise, fall back to local (defensive: never break local path).
 * - If execution_mode is undefined/null, default to local_agent.
 */
export function resolveExecutionDispatch(
	taskExecutionMode: ExecutionMode | undefined | null,
	env: Record<string, string | undefined>,
	context: CloudAgentFeatureFlagContext = {},
): ExecutionDispatchResult {
	const effectiveMode: ExecutionMode = taskExecutionMode === "cloud_agent" ? "cloud_agent" : "local_agent";

	if (effectiveMode === "local_agent") {
		return {
			path: "local",
			requestedMode: effectiveMode,
			cloudAgentEnabled: false,
			reason: "Task execution mode is local_agent.",
		};
	}

	// Task requests cloud_agent — check feature flag + allowlist.
	const flagResult = evaluateCloudAgentFeatureFlag(env, context);

	if (!flagResult.enabled) {
		const detail = !flagResult.flagEnabled
			? "Feature flag KANBAN_CLOUD_AGENT_ENABLED is not enabled."
			: "Current context is not in the cloud-agent allowlist.";
		return {
			path: "local",
			requestedMode: effectiveMode,
			cloudAgentEnabled: false,
			reason: `Cloud-agent requested but not authorized. ${detail} Falling back to local execution.`,
		};
	}

	return {
		path: "cloud",
		requestedMode: effectiveMode,
		cloudAgentEnabled: true,
		reason: "Cloud-agent execution authorized via feature flag and allowlist.",
	};
}
