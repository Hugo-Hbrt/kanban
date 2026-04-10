// ---------------------------------------------------------------------------
// Cloud Debug-Preserve Visibility — E4
// ---------------------------------------------------------------------------
//
// Surfaces debug-preserve state so operators can see when a failed task's
// sandbox has been intentionally preserved for inspection.
//
// PRD: Section 15.11 (Failure preservation rule), Section 16 Task E4, UAT-3
// Dependencies: A4 (teardown handling), E2 (metadata attachment)
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { CloudExecutionState } from "./cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL warning threshold (1 hour). */
export const DEFAULT_TTL_WARNING_THRESHOLD_MS = 3_600_000;

/** Default max TTL before critical warning (4 hours). */
export const DEFAULT_MAX_TTL_MS = 14_400_000;

// ---------------------------------------------------------------------------
// Schemas & Types
// ---------------------------------------------------------------------------

export const debugPreserveStatusSchema = z.enum(["not_applicable", "preserved", "cleanup_requested", "cleaned_up"]);
export type DebugPreserveStatus = z.infer<typeof debugPreserveStatusSchema>;

export type TtlWarningLevel = "none" | "approaching" | "critical";

export interface DebugPreserveDetail {
	readonly status: DebugPreserveStatus;
	readonly debugPreserveEnabled: boolean;
	readonly teardownSkipped: boolean;
	readonly executionState: CloudExecutionState;
	readonly instanceId: string | null;
	readonly instanceHostname: string | null;
	readonly preservedAt: string | null;
	readonly preservedDurationMs: number | null;
	readonly preservedDurationHuman: string | null;
	readonly ttlWarning: TtlWarningLevel;
	readonly ttlWarningMessage: string | null;
	readonly manualCleanupAvailable: boolean;
	readonly preservationReason: string | null;
}

export interface DebugPreserveVisibilityConfig {
	readonly ttlWarningThresholdMs: number;
	readonly maxTtlMs: number;
	readonly nowMs?: number;
}

export const DEFAULT_DEBUG_PRESERVE_VISIBILITY_CONFIG: Readonly<DebugPreserveVisibilityConfig> = {
	ttlWarningThresholdMs: DEFAULT_TTL_WARNING_THRESHOLD_MS,
	maxTtlMs: DEFAULT_MAX_TTL_MS,
};

// ---------------------------------------------------------------------------
// Duration Formatting
// ---------------------------------------------------------------------------

export function formatDurationMs(ms: number): string {
	if (ms < 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Event Analysis Helpers
// ---------------------------------------------------------------------------

export function findTeardownSkippedEvent(events: readonly PersistedTaskEvent[]): PersistedTaskEvent | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (!event) continue;
		if (event.trigger === "sandbox_terminated") {
			const meta = event.metadata as Record<string, unknown> | undefined;
			if (meta?.teardownSkipped === true && meta?.debugPreserve === true) {
				return event;
			}
		}
	}
	return null;
}

export function findManualCleanupEvent(events: readonly PersistedTaskEvent[]): PersistedTaskEvent | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (!event) continue;
		const meta = event.metadata as Record<string, unknown> | undefined;
		if (meta?.manualCleanup === true) {
			return event;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// TTL Warning Computation
// ---------------------------------------------------------------------------

export function computeTtlWarning(
	preservedDurationMs: number | null,
	config: DebugPreserveVisibilityConfig = DEFAULT_DEBUG_PRESERVE_VISIBILITY_CONFIG,
): { level: TtlWarningLevel; message: string | null } {
	if (preservedDurationMs === null || preservedDurationMs < 0) {
		return { level: "none", message: null };
	}

	if (preservedDurationMs >= config.maxTtlMs) {
		const duration = formatDurationMs(preservedDurationMs);
		const maxTtl = formatDurationMs(config.maxTtlMs);
		return {
			level: "critical",
			message: `Preserved sandbox has been alive for ${duration} (max TTL: ${maxTtl}). Cloud-platform may auto-terminate this instance. Complete inspection and trigger manual cleanup immediately.`,
		};
	}

	if (preservedDurationMs >= config.ttlWarningThresholdMs) {
		const duration = formatDurationMs(preservedDurationMs);
		const maxTtl = formatDurationMs(config.maxTtlMs);
		return {
			level: "approaching",
			message: `Preserved sandbox has been alive for ${duration}. Max TTL is ${maxTtl}. Consider completing inspection and triggering manual cleanup.`,
		};
	}

	return { level: "none", message: null };
}

// ---------------------------------------------------------------------------
// Main Visibility Function
// ---------------------------------------------------------------------------

/**
 * Derive the debug-preserve visibility detail for a task.
 *
 * This is the primary function that task detail views and API endpoints
 * should call to get the complete debug-preserve state for display.
 */
export function deriveDebugPreserveDetail(
	_taskId: string,
	events: readonly PersistedTaskEvent[],
	executions: readonly PersistedTaskExecution[],
	config: DebugPreserveVisibilityConfig = DEFAULT_DEBUG_PRESERVE_VISIBILITY_CONFIG,
): DebugPreserveDetail {
	const nowMs = config.nowMs ?? Date.now();
	const latest = executions.length > 0 ? executions[executions.length - 1] : null;
	const meta = latest?.remoteMetadata;
	const debugPreserveEnabled = meta?.debugPreserve === true;
	const executionState: CloudExecutionState =
		events.length > 0 ? (events[events.length - 1]?.toState ?? "draft") : "draft";

	// Not applicable: debug-preserve not enabled, or task didn't fail
	if (!debugPreserveEnabled || latest?.terminalState !== "failed") {
		return {
			status: "not_applicable",
			debugPreserveEnabled,
			teardownSkipped: false,
			executionState,
			instanceId: meta?.instanceId ?? null,
			instanceHostname: meta?.instanceHostname ?? null,
			preservedAt: null,
			preservedDurationMs: null,
			preservedDurationHuman: null,
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: false,
			preservationReason: null,
		};
	}

	const teardownSkippedEvent = findTeardownSkippedEvent(events);
	const teardownSkipped = teardownSkippedEvent !== null;
	const cleanupEvent = findManualCleanupEvent(events);

	// Determine status
	let status: DebugPreserveStatus;
	if (cleanupEvent) {
		const cleanupMeta = cleanupEvent.metadata as Record<string, unknown> | undefined;
		status = cleanupMeta?.cleanupCompleted === true ? "cleaned_up" : "cleanup_requested";
	} else if (teardownSkipped) {
		status = "preserved";
	} else {
		// debug-preserve enabled + failed but teardown hasn't been skipped yet
		return {
			status: "not_applicable",
			debugPreserveEnabled: true,
			teardownSkipped: false,
			executionState,
			instanceId: meta?.instanceId ?? null,
			instanceHostname: meta?.instanceHostname ?? null,
			preservedAt: null,
			preservedDurationMs: null,
			preservedDurationHuman: null,
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: false,
			preservationReason: null,
		};
	}

	const preservedAt = teardownSkippedEvent?.timestamp ?? null;
	const preservedDurationMs = preservedAt !== null ? Math.max(0, nowMs - Date.parse(preservedAt)) : null;
	const preservedDurationHuman = preservedDurationMs !== null ? formatDurationMs(preservedDurationMs) : null;

	const ttlResult =
		status === "preserved"
			? computeTtlWarning(preservedDurationMs, config)
			: { level: "none" as TtlWarningLevel, message: null };

	const teardownMeta = teardownSkippedEvent?.metadata as Record<string, unknown> | undefined;
	const preservationReason = typeof teardownMeta?.reason === "string" ? teardownMeta.reason : null;

	return {
		status,
		debugPreserveEnabled: true,
		teardownSkipped,
		executionState,
		instanceId:
			(meta?.instanceId || null) ?? (typeof teardownMeta?.instanceId === "string" ? teardownMeta.instanceId : null),
		instanceHostname: meta?.instanceHostname ?? null,
		preservedAt,
		preservedDurationMs,
		preservedDurationHuman,
		ttlWarning: ttlResult.level,
		ttlWarningMessage: ttlResult.message,
		manualCleanupAvailable: status === "preserved",
		preservationReason,
	};
}

// ---------------------------------------------------------------------------
// Manual Cleanup Interface
// ---------------------------------------------------------------------------

export interface ManualCleanupClient {
	deleteInstance(instanceId: string): Promise<void>;
}

export interface ManualCleanupResult {
	readonly success: boolean;
	readonly instanceId: string;
	readonly taskId: string;
	readonly error?: string;
	readonly alreadyTerminated?: boolean;
}

export function validateManualCleanupAllowed(
	detail: DebugPreserveDetail,
): { allowed: true } | { allowed: false; reason: string } {
	if (!detail.debugPreserveEnabled) {
		return { allowed: false, reason: "Debug-preserve is not enabled on this task." };
	}
	if (detail.status === "not_applicable") {
		return {
			allowed: false,
			reason:
				"Task is not in a debug-preserve state. The task may not have failed or teardown has not been skipped.",
		};
	}
	if (detail.status === "cleaned_up") {
		return { allowed: false, reason: "Sandbox has already been cleaned up." };
	}
	if (detail.status === "cleanup_requested") {
		return { allowed: false, reason: "Cleanup has already been requested and is in progress." };
	}
	if (!detail.instanceId) {
		return { allowed: false, reason: "No instance ID available for cleanup." };
	}
	return { allowed: true };
}

export async function executeManualCleanup(
	taskId: string,
	detail: DebugPreserveDetail,
	client: ManualCleanupClient,
): Promise<ManualCleanupResult> {
	const validation = validateManualCleanupAllowed(detail);
	if (!validation.allowed) {
		return {
			success: false,
			instanceId: detail.instanceId ?? "",
			taskId,
			error: validation.reason,
		};
	}

	const instanceId = detail.instanceId as string;

	try {
		await client.deleteInstance(instanceId);
		return { success: true, instanceId, taskId };
	} catch (e) {
		const errWithStatus = e as Error & { statusCode?: number };
		if (errWithStatus.statusCode === 404 || errWithStatus.statusCode === 410) {
			return { success: true, instanceId, taskId, alreadyTerminated: true };
		}
		const msg = e instanceof Error ? e.message.toLowerCase() : "";
		if (msg.includes("not found") || msg.includes("already terminated") || msg.includes("gone")) {
			return { success: true, instanceId, taskId, alreadyTerminated: true };
		}
		return {
			success: false,
			instanceId,
			taskId,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// ---------------------------------------------------------------------------
// Cleanup Event Builder
// ---------------------------------------------------------------------------

export function buildManualCleanupEventMetadata(result: ManualCleanupResult): Record<string, unknown> {
	return {
		manualCleanup: true,
		cleanupCompleted: result.success,
		instanceId: result.instanceId,
		alreadyTerminated: result.alreadyTerminated ?? false,
		error: result.error ?? null,
		cleanupTimestamp: new Date().toISOString(),
	};
}
