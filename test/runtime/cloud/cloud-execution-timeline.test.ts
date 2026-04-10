import { describe, expect, it } from "vitest";

import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import { deriveCurrentState } from "../../../src/cloud/cloud-execution-lifecycle";
import type {
	PersistedTaskEvent,
	PersistedTaskExecution,
	RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import {
	buildExecutionSummary,
	compareAttempts,
	executionSummarySchema,
	executionTimelineSchema,
	queryAttemptTimeline,
	queryExecutionTimeline,
	queryTimelineByCategory,
} from "../../../src/cloud/cloud-execution-timeline";

// ---------------------------------------------------------------------------
// In-memory store mock (same pattern as cloud-remote-execution-detail.test.ts)
// ---------------------------------------------------------------------------

interface MockStoreData {
	events: PersistedTaskEvent[];
	executions: PersistedTaskExecution[];
}

function createMockStore(data: MockStoreData = { events: [], executions: [] }) {
	return {
		async readEventsForTask(taskId: string) {
			return data.events.filter((e) => e.taskId === taskId);
		},
		async readExecutionsForTask(taskId: string) {
			return data.executions.filter((e) => e.taskId === taskId).sort((a, b) => a.attemptNumber - b.attemptNumber);
		},
		async deriveTaskState(taskId: string): Promise<CloudExecutionState> {
			const taskEvents = data.events.filter((e) => e.taskId === taskId);
			return deriveCurrentState(taskEvents);
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventCounter = 0;

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	eventCounter++;
	return {
		eventId: `evt-${eventCounter}`,
		taskId: "task-001",
		trigger: "submit",
		fromState: "draft",
		toState: "queued",
		timestamp: "2026-01-01T00:00:00Z",
		triggerSource: "user",
		...overrides,
	};
}

function makeExecution(overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
		taskId: "task-001",
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeRemoteMetadata(overrides: Partial<RemoteExecutionMetadata> = {}): RemoteExecutionMetadata {
	return {
		instanceId: "inst-abc123",
		instanceHostname: "sandbox-abc123.cloud.example.com",
		instanceStatus: "running",
		repoUrl: "https://github.com/cline/kanban.git",
		baseBranch: "main",
		featureBranch: "task/task-001",
		worktreePath: "/workspace",
		startingCommitSha: "abc123def456",
		promptHash: "sha256:deadbeef",
		promptVersion: "v1",
		callbackUrl: "https://kanban.local/api/callback",
		debugPreserve: false,
		...overrides,
	};
}

// ===========================================================================
// queryExecutionTimeline — empty / basic
// ===========================================================================

describe("queryExecutionTimeline — empty / basic", () => {
	it("returns empty timeline for unknown task", async () => {
		const store = createMockStore();
		const tl = await queryExecutionTimeline(store, "task-unknown");
		expect(tl.taskId).toBe("task-unknown");
		expect(tl.totalEntries).toBe(0);
		expect(tl.entries).toEqual([]);
	});

	it("returns single entry for single event", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", timestamp: "2026-01-01T00:01:00Z" })],
			executions: [makeExecution({ createdAt: "2026-01-01T00:00:00Z" })],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.totalEntries).toBe(1);
		expect(tl.entries[0]?.eventId).toBe("e1");
		expect(tl.entries[0]?.category).toBe("lifecycle");
	});

	it("validates output against schema", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", timestamp: "2026-01-01T00:01:00Z" })],
			executions: [makeExecution({ createdAt: "2026-01-01T00:00:00Z" })],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(executionTimelineSchema.safeParse(tl).success).toBe(true);
	});
});

// ===========================================================================
// queryExecutionTimeline — ordering
// ===========================================================================

describe("queryExecutionTimeline — ordering", () => {
	it("orders events by timestamp ascending", async () => {
		const store = createMockStore({
			events: [
				makeEvent({
					eventId: "e3",
					timestamp: "2026-01-01T00:03:00Z",
					trigger: "authorized",
					fromState: "policy_check",
					toState: "provisioning",
				}),
				makeEvent({ eventId: "e1", timestamp: "2026-01-01T00:01:00Z" }),
				makeEvent({
					eventId: "e2",
					timestamp: "2026-01-01T00:02:00Z",
					trigger: "dequeue",
					fromState: "queued",
					toState: "policy_check",
				}),
			],
			executions: [makeExecution({ createdAt: "2026-01-01T00:00:00Z" })],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"]);
	});
});

// ===========================================================================
// queryExecutionTimeline — event classification
// ===========================================================================

describe("queryExecutionTimeline — event classification", () => {
	it("classifies lifecycle transitions", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", trigger: "submit", fromState: "draft", toState: "queued" })],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("lifecycle");
	});

	it("classifies cancel events", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", trigger: "user_cancel", fromState: "running", toState: "canceled" })],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("cancel");
		expect(tl.entries[0]?.summary).toContain("Canceled");
	});

	it("classifies teardown events", async () => {
		const store = createMockStore({
			events: [
				makeEvent({
					eventId: "e1",
					trigger: "auto_teardown",
					fromState: "completed",
					toState: "teardown",
					timestamp: "2026-01-01T00:01:00Z",
				}),
				makeEvent({
					eventId: "e2",
					trigger: "sandbox_terminated",
					fromState: "teardown",
					toState: "archived",
					timestamp: "2026-01-01T00:02:00Z",
				}),
			],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("teardown");
		expect(tl.entries[1]?.category).toBe("teardown");
	});

	it("classifies callback events", async () => {
		const store = createMockStore({
			events: [
				makeEvent({
					eventId: "e1",
					trigger: "execution_done",
					fromState: "running",
					toState: "completing",
					triggerSource: "callback",
					metadata: { callbackStatus: "success" },
				}),
			],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("callback");
	});

	it("classifies reconciler events", async () => {
		const store = createMockStore({
			events: [
				makeEvent({
					eventId: "e1",
					trigger: "execution_error",
					fromState: "running",
					toState: "failed",
					triggerSource: "system",
					metadata: { reconcilerAction: "failed_by_reconciler", reason: "Stale task" },
				}),
			],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("reconciler");
		expect(tl.entries[0]?.summary).toContain("Stale task");
	});

	it("classifies retry events via metadata", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", metadata: { type: "retry" } })],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("retry");
	});

	it("classifies replay events via metadata", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", metadata: { type: "replay" } })],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.category).toBe("replay");
	});
});

// ===========================================================================
// queryExecutionTimeline — attempt isolation
// ===========================================================================

describe("queryExecutionTimeline — attempt isolation", () => {
	it("associates events with correct attempt by timestamp", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", timestamp: "2026-01-01T00:01:00Z" }),
				makeEvent({
					eventId: "e2",
					timestamp: "2026-01-01T01:01:00Z",
					trigger: "dequeue",
					fromState: "queued",
					toState: "policy_check",
				}),
			],
			executions: [
				makeExecution({ executionId: "ex1", attemptNumber: 1, createdAt: "2026-01-01T00:00:00Z" }),
				makeExecution({ executionId: "ex2", attemptNumber: 2, createdAt: "2026-01-01T01:00:00Z" }),
			],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.attemptNumber).toBe(1);
		expect(tl.entries[1]?.attemptNumber).toBe(2);
	});

	it("uses metadata attemptNumber when available", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", metadata: { attemptNumber: 3 } })],
			executions: [makeExecution({ attemptNumber: 1 })],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.attemptNumber).toBe(3);
	});

	it("returns 0 for events with no matching execution", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [],
		});
		const tl = await queryExecutionTimeline(store, "task-001");
		expect(tl.entries[0]?.attemptNumber).toBe(0);
	});
});

// ===========================================================================
// queryAttemptTimeline — filtered by attempt
// ===========================================================================

describe("queryAttemptTimeline — filtered by attempt", () => {
	it("returns only events for requested attempt", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", timestamp: "2026-01-01T00:01:00Z" }),
				makeEvent({ eventId: "e2", timestamp: "2026-01-01T01:01:00Z" }),
			],
			executions: [
				makeExecution({ attemptNumber: 1, createdAt: "2026-01-01T00:00:00Z" }),
				makeExecution({ attemptNumber: 2, createdAt: "2026-01-01T01:00:00Z" }),
			],
		});
		const tl = await queryAttemptTimeline(store, "task-001", 1);
		expect(tl.totalEntries).toBe(1);
		expect(tl.entries[0]?.eventId).toBe("e1");
	});
});

// ===========================================================================
// queryTimelineByCategory — filtered by category
// ===========================================================================

describe("queryTimelineByCategory — filtered by category", () => {
	it("returns only events matching category", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", trigger: "submit", fromState: "draft", toState: "queued" }),
				makeEvent({ eventId: "e2", trigger: "user_cancel", fromState: "running", toState: "canceled" }),
				makeEvent({ eventId: "e3", trigger: "auto_teardown", fromState: "canceled", toState: "teardown" }),
			],
			executions: [],
		});
		const cancelTl = await queryTimelineByCategory(store, "task-001", "cancel");
		expect(cancelTl.totalEntries).toBe(1);
		expect(cancelTl.entries[0]?.eventId).toBe("e2");

		const teardownTl = await queryTimelineByCategory(store, "task-001", "teardown");
		expect(teardownTl.totalEntries).toBe(1);
		expect(teardownTl.entries[0]?.eventId).toBe("e3");
	});
});

// ===========================================================================
// compareAttempts
// ===========================================================================

describe("compareAttempts", () => {
	it("returns null when before attempt not found", async () => {
		const store = createMockStore({
			events: [],
			executions: [makeExecution({ attemptNumber: 1 })],
		});
		const result = await compareAttempts(store, "task-001", 99, 1);
		expect(result).toBeNull();
	});

	it("returns null when after attempt not found", async () => {
		const store = createMockStore({
			events: [],
			executions: [makeExecution({ attemptNumber: 1 })],
		});
		const result = await compareAttempts(store, "task-001", 1, 99);
		expect(result).toBeNull();
	});

	it("returns empty diffs when attempts are identical", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, branchIntent: "fresh_branch", promptVersion: "v1" }),
				makeExecution({ attemptNumber: 2, branchIntent: "fresh_branch", promptVersion: "v1" }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		expect(result).not.toBeNull();
		expect(result?.diffs).toEqual([]);
	});

	it("detects changed branch intent", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, branchIntent: "fresh_branch" }),
				makeExecution({ attemptNumber: 2, branchIntent: "reuse_branch" }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		expect(result?.diffs).toContainEqual({ field: "branchIntent", before: "fresh_branch", after: "reuse_branch" });
	});

	it("detects changed prompt version", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, promptVersion: "v1" }),
				makeExecution({ attemptNumber: 2, promptVersion: "v2" }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		expect(result?.diffs).toContainEqual({ field: "promptVersion", before: "v1", after: "v2" });
	});

	it("detects changed commit SHA", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, startingCommitSha: "aaa111" }),
				makeExecution({ attemptNumber: 2, startingCommitSha: "bbb222" }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		expect(result?.diffs).toContainEqual({ field: "startingCommitSha", before: "aaa111", after: "bbb222" });
	});

	it("includes outcomes from both attempts", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, terminalState: "failed" }),
				makeExecution({ attemptNumber: 2, terminalState: "completed" }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		expect(result?.beforeOutcome).toBe("failed");
		expect(result?.afterOutcome).toBe("completed");
	});

	it("detects trigger type change (initial to retry)", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, trigger: "initial" }),
				makeExecution({ attemptNumber: 2, trigger: "retry" }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		expect(result?.diffs).toContainEqual({ field: "trigger", before: "initial", after: "retry" });
	});

	it("detects remoteMetadata sub-field changes", async () => {
		const store = createMockStore({
			events: [],
			executions: [
				makeExecution({ attemptNumber: 1, remoteMetadata: makeRemoteMetadata({ featureBranch: "feat/old" }) }),
				makeExecution({ attemptNumber: 2, remoteMetadata: makeRemoteMetadata({ featureBranch: "feat/new" }) }),
			],
		});
		const result = await compareAttempts(store, "task-001", 1, 2);
		const fbDiff = result?.diffs.find((d) => d.field === "remoteMetadata.featureBranch");
		expect(fbDiff).toBeDefined();
		expect(fbDiff?.before).toBe("feat/old");
		expect(fbDiff?.after).toBe("feat/new");
	});
});

// ===========================================================================
// buildExecutionSummary
// ===========================================================================

describe("buildExecutionSummary — basic", () => {
	it("returns null for task with no history", async () => {
		const store = createMockStore();
		const summary = await buildExecutionSummary(store, "task-unknown");
		expect(summary).toBeNull();
	});

	it("returns summary for single attempt", async () => {
		const store = createMockStore({
			events: [
				makeEvent({
					eventId: "e1",
					timestamp: "2026-01-01T00:01:00Z",
					trigger: "submit",
					fromState: "draft",
					toState: "queued",
				}),
				makeEvent({
					eventId: "e2",
					timestamp: "2026-01-01T00:02:00Z",
					trigger: "dequeue",
					fromState: "queued",
					toState: "policy_check",
				}),
			],
			executions: [
				makeExecution({ executionId: "ex1", attemptNumber: 1, terminalState: "completed", trigger: "initial" }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s).not.toBeNull();
		expect(s?.totalAttempts).toBe(1);
		expect(s?.lastAttemptOutcome).toBe("completed");
		expect(s?.hasBeenRetried).toBe(false);
		expect(s?.hasBeenReplayed).toBe(false);
		expect(s?.latestAttemptNumber).toBe(1);
		expect(s?.latestExecutionId).toBe("ex1");
	});

	it("validates output against schema", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ trigger: "initial" })],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(executionSummarySchema.safeParse(s).success).toBe(true);
	});
});

describe("buildExecutionSummary — retry/replay flags", () => {
	it("detects retried task", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, trigger: "initial" }),
				makeExecution({ attemptNumber: 2, trigger: "retry" }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.hasBeenRetried).toBe(true);
		expect(s?.hasBeenReplayed).toBe(false);
		expect(s?.totalAttempts).toBe(2);
	});

	it("detects replayed task", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, trigger: "initial" }),
				makeExecution({ attemptNumber: 2, trigger: "replay" }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.hasBeenRetried).toBe(false);
		expect(s?.hasBeenReplayed).toBe(true);
	});
});

// ===========================================================================
// buildExecutionSummary — outcome pattern and aggregates
// ===========================================================================

describe("buildExecutionSummary — outcome pattern", () => {
	it("shows outcome pattern across attempts", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, terminalState: "failed" }),
				makeExecution({ attemptNumber: 2, terminalState: "failed" }),
				makeExecution({ attemptNumber: 3, terminalState: "completed" }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.outcomePattern).toEqual(["failed", "failed", "completed"]);
		expect(s?.lastAttemptOutcome).toBe("completed");
	});

	it("includes undefined for in-progress attempts", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, terminalState: "failed" }),
				makeExecution({ attemptNumber: 2 }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.outcomePattern).toEqual(["failed", undefined]);
	});
});

describe("buildExecutionSummary — duration and token aggregation", () => {
	it("sums durationSeconds across attempts", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, durationSeconds: 60 }),
				makeExecution({ attemptNumber: 2, durationSeconds: 120 }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.totalDurationSeconds).toBe(180);
	});

	it("computes duration from startedAt/completedAt when durationSeconds missing", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.totalDurationSeconds).toBe(60);
	});

	it("sums tokenUsage across attempts", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({ attemptNumber: 1, tokenUsage: 1000 }),
				makeExecution({ attemptNumber: 2, tokenUsage: 2000 }),
			],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.totalTokenUsage).toBe(3000);
	});

	it("falls back to remoteMetadata tokenUsage", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ attemptNumber: 1, remoteMetadata: makeRemoteMetadata({ tokenUsage: 500 }) })],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.totalTokenUsage).toBe(500);
	});
});

describe("buildExecutionSummary — time in states", () => {
	it("computes time in each state from events", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", toState: "queued", timestamp: "2026-01-01T00:00:00Z" }),
				makeEvent({ eventId: "e2", toState: "policy_check", timestamp: "2026-01-01T00:00:10Z" }),
				makeEvent({ eventId: "e3", toState: "provisioning", timestamp: "2026-01-01T00:00:30Z" }),
			],
			executions: [makeExecution()],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.timeInStates.queued).toBe(10);
		expect(s?.timeInStates.policy_check).toBe(20);
		expect(s?.timeInStates.provisioning).toBeUndefined();
	});
});

describe("buildExecutionSummary — teardown and instance", () => {
	it("includes teardown decision from latest attempt", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ teardownDecision: "debug-preserve" })],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.teardownDecision).toBe("debug-preserve");
	});

	it("includes current instance ID from latest execution", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ instanceId: "inst-xyz" })],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.currentInstanceId).toBe("inst-xyz");
	});

	it("falls back to remoteMetadata instanceId", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ remoteMetadata: makeRemoteMetadata({ instanceId: "inst-meta" }) })],
		});
		const s = await buildExecutionSummary(store, "task-001");
		expect(s?.currentInstanceId).toBe("inst-meta");
	});
});
