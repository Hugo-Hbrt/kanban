import { describe, expect, it } from "vitest";
import {
	buildManualCleanupEventMetadata,
	computeTtlWarning,
	DEFAULT_MAX_TTL_MS,
	DEFAULT_TTL_WARNING_THRESHOLD_MS,
	type DebugPreserveDetail,
	type DebugPreserveVisibilityConfig,
	deriveDebugPreserveDetail,
	executeManualCleanup,
	findManualCleanupEvent,
	findTeardownSkippedEvent,
	formatDurationMs,
	type ManualCleanupClient,
	validateManualCleanupAllowed,
} from "../../../src/cloud/cloud-debug-preserve-visibility";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventCounter = 0;

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	eventCounter++;
	return {
		eventId: `evt-${eventCounter}`,
		taskId: "task-1",
		trigger: "submit",
		fromState: "draft",
		toState: "queued",
		timestamp: new Date().toISOString(),
		triggerSource: "system",
		...overrides,
	};
}

function makeExecution(overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: "exec-1",
		taskId: "task-1",
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

const PRESERVED_AT = "2026-04-09T10:00:00.000Z";

function makePreservedScenario(opts?: {
	preservedAt?: string;
	nowMs?: number;
	instanceId?: string;
	instanceHostname?: string;
}): {
	events: PersistedTaskEvent[];
	executions: PersistedTaskExecution[];
	config: DebugPreserveVisibilityConfig;
} {
	const preservedAt = opts?.preservedAt ?? PRESERVED_AT;
	return {
		events: [
			makeEvent({ trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			makeEvent({ trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
			makeEvent({ trigger: "execution_error", fromState: "running", toState: "failed" }),
			makeEvent({ trigger: "auto_teardown", fromState: "failed", toState: "teardown" }),
			makeEvent({
				trigger: "sandbox_terminated",
				fromState: "teardown",
				toState: "archived",
				timestamp: preservedAt,
				metadata: {
					teardownSkipped: true,
					debugPreserve: true,
					reason: "Debug-preserve mode: sandbox preserved for inspection",
					instanceId: opts?.instanceId ?? "inst-debug-1",
				},
			}),
		],
		executions: [
			makeExecution({
				terminalState: "failed",
				remoteMetadata: {
					instanceId: opts?.instanceId ?? "inst-debug-1",
					instanceHostname: opts?.instanceHostname ?? "inst-debug-1.runner.test",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					debugPreserve: true,
				},
			}),
		],
		config: {
			ttlWarningThresholdMs: DEFAULT_TTL_WARNING_THRESHOLD_MS,
			maxTtlMs: DEFAULT_MAX_TTL_MS,
			nowMs: opts?.nowMs ?? Date.parse(preservedAt) + 600_000, // 10 min after
		},
	};
}

// ===========================================================================
// Tests — formatDurationMs
// ===========================================================================

describe("formatDurationMs", () => {
	it("formats zero milliseconds", () => {
		expect(formatDurationMs(0)).toBe("0s");
	});

	it("formats seconds only", () => {
		expect(formatDurationMs(30_000)).toBe("30s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDurationMs(150_000)).toBe("2m 30s");
	});

	it("formats hours, minutes, and seconds", () => {
		expect(formatDurationMs(3_661_000)).toBe("1h 1m 1s");
	});

	it("formats exact hours", () => {
		expect(formatDurationMs(7_200_000)).toBe("2h");
	});

	it("formats hours and minutes without seconds", () => {
		expect(formatDurationMs(4_500_000)).toBe("1h 15m");
	});

	it("returns 0s for negative values", () => {
		expect(formatDurationMs(-1000)).toBe("0s");
	});
});

// ===========================================================================
// Tests — findTeardownSkippedEvent
// ===========================================================================

describe("findTeardownSkippedEvent", () => {
	it("returns null for empty events", () => {
		expect(findTeardownSkippedEvent([])).toBeNull();
	});

	it("returns null when no sandbox_terminated event exists", () => {
		const events = [makeEvent({ trigger: "submit" }), makeEvent({ trigger: "dequeue" })];
		expect(findTeardownSkippedEvent(events)).toBeNull();
	});

	it("returns null for sandbox_terminated without teardownSkipped", () => {
		const events = [
			makeEvent({
				trigger: "sandbox_terminated",
				metadata: { instanceDeleted: true },
			}),
		];
		expect(findTeardownSkippedEvent(events)).toBeNull();
	});

	it("finds the teardown-skipped event", () => {
		const { events } = makePreservedScenario();
		const result = findTeardownSkippedEvent(events);
		expect(result).not.toBeNull();
		expect(result?.trigger).toBe("sandbox_terminated");
		const meta = result?.metadata as Record<string, unknown>;
		expect(meta?.teardownSkipped).toBe(true);
		expect(meta?.debugPreserve).toBe(true);
	});
});

// ===========================================================================
// Tests — findManualCleanupEvent
// ===========================================================================

describe("findManualCleanupEvent", () => {
	it("returns null for empty events", () => {
		expect(findManualCleanupEvent([])).toBeNull();
	});

	it("returns null when no cleanup event exists", () => {
		const { events } = makePreservedScenario();
		expect(findManualCleanupEvent(events)).toBeNull();
	});

	it("finds a manual cleanup event", () => {
		const { events } = makePreservedScenario();
		events.push(
			makeEvent({
				trigger: "sandbox_terminated",
				metadata: { manualCleanup: true, cleanupCompleted: true },
			}),
		);
		const result = findManualCleanupEvent(events);
		expect(result).not.toBeNull();
		const meta = result?.metadata as Record<string, unknown>;
		expect(meta?.manualCleanup).toBe(true);
	});
});

// ===========================================================================
// Tests — computeTtlWarning
// ===========================================================================

describe("computeTtlWarning", () => {
	it("returns none for null duration", () => {
		const result = computeTtlWarning(null);
		expect(result.level).toBe("none");
		expect(result.message).toBeNull();
	});

	it("returns none for negative duration", () => {
		const result = computeTtlWarning(-1000);
		expect(result.level).toBe("none");
	});

	it("returns none when under threshold", () => {
		const result = computeTtlWarning(600_000); // 10 min
		expect(result.level).toBe("none");
		expect(result.message).toBeNull();
	});

	it("returns approaching when at threshold", () => {
		const result = computeTtlWarning(DEFAULT_TTL_WARNING_THRESHOLD_MS);
		expect(result.level).toBe("approaching");
		expect(result.message).toContain("1h");
		expect(result.message).toContain("Consider completing inspection");
	});

	it("returns critical when at max TTL", () => {
		const result = computeTtlWarning(DEFAULT_MAX_TTL_MS);
		expect(result.level).toBe("critical");
		expect(result.message).toContain("4h");
		expect(result.message).toContain("immediately");
	});

	it("returns critical when beyond max TTL", () => {
		const result = computeTtlWarning(DEFAULT_MAX_TTL_MS + 1_000_000);
		expect(result.level).toBe("critical");
	});

	it("uses custom config", () => {
		const config: DebugPreserveVisibilityConfig = {
			ttlWarningThresholdMs: 10_000,
			maxTtlMs: 20_000,
		};
		expect(computeTtlWarning(5_000, config).level).toBe("none");
		expect(computeTtlWarning(15_000, config).level).toBe("approaching");
		expect(computeTtlWarning(25_000, config).level).toBe("critical");
	});
});

// ===========================================================================
// Tests — deriveDebugPreserveDetail: not applicable cases
// ===========================================================================

describe("deriveDebugPreserveDetail — not applicable", () => {
	it("returns not_applicable for empty events and executions", () => {
		const detail = deriveDebugPreserveDetail("task-1", [], []);
		expect(detail.status).toBe("not_applicable");
		expect(detail.debugPreserveEnabled).toBe(false);
		expect(detail.manualCleanupAvailable).toBe(false);
	});

	it("returns not_applicable when debug-preserve is not enabled", () => {
		const events = [makeEvent({ trigger: "execution_error", fromState: "running", toState: "failed" })];
		const executions = [
			makeExecution({
				terminalState: "failed",
				remoteMetadata: {
					instanceId: "inst-1",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					debugPreserve: false,
				},
			}),
		];
		const detail = deriveDebugPreserveDetail("task-1", events, executions);
		expect(detail.status).toBe("not_applicable");
		expect(detail.debugPreserveEnabled).toBe(false);
	});

	it("returns not_applicable when task completed (not failed)", () => {
		const events = [makeEvent({ trigger: "finalize_success", fromState: "completing", toState: "completed" })];
		const executions = [
			makeExecution({
				terminalState: "completed",
				remoteMetadata: {
					instanceId: "inst-1",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					debugPreserve: true,
				},
			}),
		];
		const detail = deriveDebugPreserveDetail("task-1", events, executions);
		expect(detail.status).toBe("not_applicable");
		expect(detail.debugPreserveEnabled).toBe(true);
	});

	it("returns not_applicable when task canceled (not failed)", () => {
		const events = [makeEvent({ trigger: "user_cancel", fromState: "running", toState: "canceled" })];
		const executions = [
			makeExecution({
				terminalState: "canceled",
				remoteMetadata: {
					instanceId: "inst-1",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					debugPreserve: true,
				},
			}),
		];
		const detail = deriveDebugPreserveDetail("task-1", events, executions);
		expect(detail.status).toBe("not_applicable");
	});

	it("returns not_applicable when failed but teardown not yet skipped", () => {
		const events = [makeEvent({ trigger: "execution_error", fromState: "running", toState: "failed" })];
		const executions = [
			makeExecution({
				terminalState: "failed",
				remoteMetadata: {
					instanceId: "inst-1",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					debugPreserve: true,
				},
			}),
		];
		const detail = deriveDebugPreserveDetail("task-1", events, executions);
		expect(detail.status).toBe("not_applicable");
		expect(detail.debugPreserveEnabled).toBe(true);
		expect(detail.teardownSkipped).toBe(false);
	});
});

// ===========================================================================
// Tests — deriveDebugPreserveDetail: preserved state
// ===========================================================================

describe("deriveDebugPreserveDetail — preserved state", () => {
	it("shows preserved status for failed task with debug-preserve + skipped teardown", () => {
		const { events, executions, config } = makePreservedScenario();
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.status).toBe("preserved");
		expect(detail.debugPreserveEnabled).toBe(true);
		expect(detail.teardownSkipped).toBe(true);
		expect(detail.manualCleanupAvailable).toBe(true);
	});

	it("surfaces instance ID and hostname", () => {
		const { events, executions, config } = makePreservedScenario({
			instanceId: "inst-xyz",
			instanceHostname: "inst-xyz.runner.test",
		});
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.instanceId).toBe("inst-xyz");
		expect(detail.instanceHostname).toBe("inst-xyz.runner.test");
	});

	it("computes preservation duration", () => {
		const { events, executions, config } = makePreservedScenario({
			nowMs: Date.parse(PRESERVED_AT) + 600_000, // 10 min
		});
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.preservedAt).toBe(PRESERVED_AT);
		expect(detail.preservedDurationMs).toBe(600_000);
		expect(detail.preservedDurationHuman).toBe("10m");
	});

	it("shows no TTL warning when under threshold", () => {
		const { events, executions, config } = makePreservedScenario({
			nowMs: Date.parse(PRESERVED_AT) + 600_000, // 10 min
		});
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.ttlWarning).toBe("none");
		expect(detail.ttlWarningMessage).toBeNull();
	});

	it("shows approaching TTL warning", () => {
		const { events, executions, config } = makePreservedScenario({
			nowMs: Date.parse(PRESERVED_AT) + DEFAULT_TTL_WARNING_THRESHOLD_MS + 60_000,
		});
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.ttlWarning).toBe("approaching");
		expect(detail.ttlWarningMessage).toContain("Consider completing inspection");
	});

	it("shows critical TTL warning", () => {
		const { events, executions, config } = makePreservedScenario({
			nowMs: Date.parse(PRESERVED_AT) + DEFAULT_MAX_TTL_MS + 60_000,
		});
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.ttlWarning).toBe("critical");
		expect(detail.ttlWarningMessage).toContain("immediately");
	});

	it("includes preservation reason from event metadata", () => {
		const { events, executions, config } = makePreservedScenario();
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.preservationReason).toBe("Debug-preserve mode: sandbox preserved for inspection");
	});

	it("falls back to instanceId from teardown event metadata", () => {
		const { events, config } = makePreservedScenario({ instanceId: "inst-meta-1" });
		// Create execution without instanceId in remoteMetadata
		const executions = [
			makeExecution({
				terminalState: "failed",
				remoteMetadata: {
					instanceId: "",
					repoUrl: "https://github.com/test/repo",
					baseBranch: "main",
					debugPreserve: true,
				},
			}),
		];
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		// Should get instanceId from teardown event metadata
		expect(detail.instanceId).toBe("inst-meta-1");
	});
});

// ===========================================================================
// Tests — deriveDebugPreserveDetail: cleanup states
// ===========================================================================

describe("deriveDebugPreserveDetail — cleanup states", () => {
	it("shows cleaned_up when cleanup event has cleanupCompleted=true", () => {
		const { events, executions, config } = makePreservedScenario();
		events.push(
			makeEvent({
				trigger: "sandbox_terminated",
				metadata: { manualCleanup: true, cleanupCompleted: true, instanceId: "inst-debug-1" },
			}),
		);
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.status).toBe("cleaned_up");
		expect(detail.manualCleanupAvailable).toBe(false);
		expect(detail.ttlWarning).toBe("none"); // no TTL warning for cleaned up
	});

	it("shows cleanup_requested when cleanup event has cleanupCompleted=false", () => {
		const { events, executions, config } = makePreservedScenario();
		events.push(
			makeEvent({
				trigger: "sandbox_terminated",
				metadata: { manualCleanup: true, cleanupCompleted: false, instanceId: "inst-debug-1" },
			}),
		);
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		expect(detail.status).toBe("cleanup_requested");
		expect(detail.manualCleanupAvailable).toBe(false);
	});
});

// ===========================================================================
// Tests — validateManualCleanupAllowed
// ===========================================================================

describe("validateManualCleanupAllowed", () => {
	it("allows cleanup for preserved tasks", () => {
		const { events, executions, config } = makePreservedScenario();
		const detail = deriveDebugPreserveDetail("task-1", events, executions, config);
		const result = validateManualCleanupAllowed(detail);
		expect(result.allowed).toBe(true);
	});

	it("rejects cleanup when debug-preserve not enabled", () => {
		const detail: DebugPreserveDetail = {
			status: "not_applicable",
			debugPreserveEnabled: false,
			teardownSkipped: false,
			executionState: "failed",
			instanceId: "inst-1",
			instanceHostname: null,
			preservedAt: null,
			preservedDurationMs: null,
			preservedDurationHuman: null,
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: false,
			preservationReason: null,
		};
		const result = validateManualCleanupAllowed(detail);
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("not enabled");
	});

	it("rejects cleanup for not_applicable status", () => {
		const detail: DebugPreserveDetail = {
			status: "not_applicable",
			debugPreserveEnabled: true,
			teardownSkipped: false,
			executionState: "failed",
			instanceId: "inst-1",
			instanceHostname: null,
			preservedAt: null,
			preservedDurationMs: null,
			preservedDurationHuman: null,
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: false,
			preservationReason: null,
		};
		const result = validateManualCleanupAllowed(detail);
		expect(result.allowed).toBe(false);
	});

	it("rejects cleanup for already cleaned up tasks", () => {
		const detail: DebugPreserveDetail = {
			status: "cleaned_up",
			debugPreserveEnabled: true,
			teardownSkipped: true,
			executionState: "archived",
			instanceId: "inst-1",
			instanceHostname: null,
			preservedAt: PRESERVED_AT,
			preservedDurationMs: 600_000,
			preservedDurationHuman: "10m",
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: false,
			preservationReason: null,
		};
		const result = validateManualCleanupAllowed(detail);
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("already been cleaned up");
	});

	it("rejects cleanup when already in progress", () => {
		const detail: DebugPreserveDetail = {
			status: "cleanup_requested",
			debugPreserveEnabled: true,
			teardownSkipped: true,
			executionState: "archived",
			instanceId: "inst-1",
			instanceHostname: null,
			preservedAt: PRESERVED_AT,
			preservedDurationMs: 600_000,
			preservedDurationHuman: "10m",
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: false,
			preservationReason: null,
		};
		const result = validateManualCleanupAllowed(detail);
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("already been requested");
	});

	it("rejects cleanup when no instanceId", () => {
		const detail: DebugPreserveDetail = {
			status: "preserved",
			debugPreserveEnabled: true,
			teardownSkipped: true,
			executionState: "archived",
			instanceId: null,
			instanceHostname: null,
			preservedAt: PRESERVED_AT,
			preservedDurationMs: 600_000,
			preservedDurationHuman: "10m",
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: true,
			preservationReason: null,
		};
		const result = validateManualCleanupAllowed(detail);
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("No instance ID");
	});
});

// ===========================================================================
// Tests — executeManualCleanup
// ===========================================================================

describe("executeManualCleanup", () => {
	function makePreservedDetail(overrides?: Partial<DebugPreserveDetail>): DebugPreserveDetail {
		return {
			status: "preserved",
			debugPreserveEnabled: true,
			teardownSkipped: true,
			executionState: "archived",
			instanceId: "inst-debug-1",
			instanceHostname: "inst-debug-1.runner.test",
			preservedAt: PRESERVED_AT,
			preservedDurationMs: 600_000,
			preservedDurationHuman: "10m",
			ttlWarning: "none",
			ttlWarningMessage: null,
			manualCleanupAvailable: true,
			preservationReason: "Debug-preserve mode",
			...overrides,
		};
	}

	it("successfully deletes the instance", async () => {
		const client: ManualCleanupClient = {
			deleteInstance: async () => {},
		};
		const result = await executeManualCleanup("task-1", makePreservedDetail(), client);
		expect(result.success).toBe(true);
		expect(result.instanceId).toBe("inst-debug-1");
		expect(result.taskId).toBe("task-1");
	});

	it("returns failure when validation fails", async () => {
		const client: ManualCleanupClient = {
			deleteInstance: async () => {},
		};
		const detail = makePreservedDetail({ status: "cleaned_up" });
		const result = await executeManualCleanup("task-1", detail, client);
		expect(result.success).toBe(false);
		expect(result.error).toContain("already been cleaned up");
	});

	it("treats 404 as successful (already terminated)", async () => {
		const err = Object.assign(new Error("Not found"), { statusCode: 404 });
		const client: ManualCleanupClient = {
			deleteInstance: async () => {
				throw err;
			},
		};
		const result = await executeManualCleanup("task-1", makePreservedDetail(), client);
		expect(result.success).toBe(true);
		expect(result.alreadyTerminated).toBe(true);
	});

	it("treats 410 as successful (gone)", async () => {
		const err = Object.assign(new Error("Gone"), { statusCode: 410 });
		const client: ManualCleanupClient = {
			deleteInstance: async () => {
				throw err;
			},
		};
		const result = await executeManualCleanup("task-1", makePreservedDetail(), client);
		expect(result.success).toBe(true);
		expect(result.alreadyTerminated).toBe(true);
	});

	it("treats 'not found' message as successful", async () => {
		const client: ManualCleanupClient = {
			deleteInstance: async () => {
				throw new Error("Instance not found");
			},
		};
		const result = await executeManualCleanup("task-1", makePreservedDetail(), client);
		expect(result.success).toBe(true);
		expect(result.alreadyTerminated).toBe(true);
	});

	it("returns failure for other errors", async () => {
		const client: ManualCleanupClient = {
			deleteInstance: async () => {
				throw new Error("Network timeout");
			},
		};
		const result = await executeManualCleanup("task-1", makePreservedDetail(), client);
		expect(result.success).toBe(false);
		expect(result.error).toBe("Network timeout");
	});
});

// ===========================================================================
// Tests — buildManualCleanupEventMetadata
// ===========================================================================

describe("buildManualCleanupEventMetadata", () => {
	it("builds metadata for successful cleanup", () => {
		const meta = buildManualCleanupEventMetadata({
			success: true,
			instanceId: "inst-1",
			taskId: "task-1",
		});
		expect(meta.manualCleanup).toBe(true);
		expect(meta.cleanupCompleted).toBe(true);
		expect(meta.instanceId).toBe("inst-1");
		expect(meta.alreadyTerminated).toBe(false);
		expect(meta.error).toBeNull();
		expect(typeof meta.cleanupTimestamp).toBe("string");
	});

	it("builds metadata for already-terminated cleanup", () => {
		const meta = buildManualCleanupEventMetadata({
			success: true,
			instanceId: "inst-1",
			taskId: "task-1",
			alreadyTerminated: true,
		});
		expect(meta.cleanupCompleted).toBe(true);
		expect(meta.alreadyTerminated).toBe(true);
	});

	it("builds metadata for failed cleanup", () => {
		const meta = buildManualCleanupEventMetadata({
			success: false,
			instanceId: "inst-1",
			taskId: "task-1",
			error: "Network timeout",
		});
		expect(meta.cleanupCompleted).toBe(false);
		expect(meta.error).toBe("Network timeout");
	});
});
