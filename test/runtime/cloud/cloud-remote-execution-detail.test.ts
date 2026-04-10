import { describe, expect, it } from "vitest";

import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import { deriveCurrentState } from "../../../src/cloud/cloud-execution-lifecycle";
import type {
	PersistedTaskEvent,
	PersistedTaskExecution,
	RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import {
	assembleTaskRemoteExecutionDetail,
	type TaskRemoteExecutionDetail,
	taskRemoteExecutionDetailSchema,
} from "../../../src/cloud/cloud-remote-execution-detail";

// ---------------------------------------------------------------------------
// In-memory store mock
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

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	return {
		eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
		taskId: "task-001",
		trigger: "submit",
		fromState: "draft",
		toState: "queued",
		timestamp: new Date().toISOString(),
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
		createdAt: new Date().toISOString(),
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
// Tests — returns null for tasks with no cloud data
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — no data", () => {
	it("returns null when task has no events and no executions", async () => {
		const store = createMockStore();
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-unknown");
		expect(detail).toBeNull();
	});

	it("returns null for a different task when data exists for another", async () => {
		const store = createMockStore({
			events: [makeEvent({ taskId: "task-other" })],
			executions: [],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail).toBeNull();
	});
});

// ===========================================================================
// Tests — basic metadata assembly
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — basic metadata", () => {
	it("returns detail when events exist (even without executions)", async () => {
		const store = createMockStore({
			events: [makeEvent({ taskId: "task-001" })],
			executions: [],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail).not.toBeNull();
		expect(detail?.taskId).toBe("task-001");
		expect(detail?.cloudExecutionState).toBe("queued");
		expect(detail?.attemptHistory).toEqual([]);
		expect(detail?.eventCount).toBe(1);
		expect(detail?.callbackReceived).toBe(false);
	});

	it("populates all fields from execution and remote metadata", async () => {
		const metadata = makeRemoteMetadata({
			executionDurationSeconds: 120.5,
			tokenUsage: 5000,
			callbackReceivedAt: "2026-01-01T00:10:00Z",
		});
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", trigger: "submit", fromState: "draft", toState: "queued" }),
				makeEvent({ eventId: "e2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			],
			executions: [
				makeExecution({
					executionId: "exec-1",
					instanceId: "inst-abc123",
					terminalState: "completed",
					resultSummary: "PR created",
					remoteMetadata: metadata,
				}),
			],
		});

		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail).not.toBeNull();
		expect(detail?.taskId).toBe("task-001");
		expect(detail?.executionMode).toBe("cloud_agent");
		expect(detail?.instanceId).toBe("inst-abc123");
		expect(detail?.instanceHostname).toBe("sandbox-abc123.cloud.example.com");
		expect(detail?.attemptNumber).toBe(1);
		expect(detail?.promptHash).toBe("sha256:deadbeef");
		expect(detail?.promptVersion).toBe("v1");
		expect(detail?.repoUrl).toBe("https://github.com/cline/kanban.git");
		expect(detail?.baseBranch).toBe("main");
		expect(detail?.featureBranch).toBe("task/task-001");
		expect(detail?.worktreePath).toBe("/workspace");
		expect(detail?.callbackReceived).toBe(true);
		expect(detail?.callbackReceivedAt).toBe("2026-01-01T00:10:00Z");
		expect(detail?.terminalState).toBe("completed");
		expect(detail?.resultSummary).toBe("PR created");
		expect(detail?.executionDurationSeconds).toBe(120.5);
		expect(detail?.tokenUsage).toBe(5000);
		expect(detail?.debugPreserve).toBe(false);
		expect(detail?.eventCount).toBe(2);
	});
});

// ===========================================================================
// Tests — attempt history
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — attempt history", () => {
	it("includes all attempt history entries ordered by attempt number", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({
					executionId: "exec-1",
					attemptNumber: 1,
					terminalState: "failed",
					resultSummary: "First attempt failed",
				}),
				makeExecution({
					executionId: "exec-2",
					attemptNumber: 2,
					terminalState: "completed",
					resultSummary: "Second attempt succeeded",
				}),
			],
		});

		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.attemptHistory).toHaveLength(2);
		expect(detail?.attemptHistory[0]?.attemptNumber).toBe(1);
		expect(detail?.attemptHistory[0]?.resultSummary).toBe("First attempt failed");
		expect(detail?.attemptHistory[1]?.attemptNumber).toBe(2);
		expect(detail?.attemptHistory[1]?.resultSummary).toBe("Second attempt succeeded");
		expect(detail?.attemptNumber).toBe(2);
	});

	it("uses latest execution for top-level fields", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({
					executionId: "exec-1",
					attemptNumber: 1,
					executionMode: "cloud_agent",
					terminalState: "failed",
					remoteMetadata: makeRemoteMetadata({ instanceId: "inst-old" }),
				}),
				makeExecution({
					executionId: "exec-2",
					attemptNumber: 2,
					executionMode: "cloud_agent",
					terminalState: "completed",
					remoteMetadata: makeRemoteMetadata({ instanceId: "inst-new" }),
				}),
			],
		});

		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.instanceId).toBe("inst-new");
		expect(detail?.terminalState).toBe("completed");
	});
});

// ===========================================================================
// Tests — callback status
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — callback status", () => {
	it("reports callbackReceived false when no callback timestamp", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({
					remoteMetadata: makeRemoteMetadata({ callbackReceivedAt: undefined }),
				}),
			],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.callbackReceived).toBe(false);
		expect(detail?.callbackReceivedAt).toBeUndefined();
	});

	it("reports callbackReceived true when callback timestamp exists", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({
					remoteMetadata: makeRemoteMetadata({
						callbackReceivedAt: "2026-03-01T12:00:00Z",
					}),
				}),
			],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.callbackReceived).toBe(true);
		expect(detail?.callbackReceivedAt).toBe("2026-03-01T12:00:00Z");
	});
});

// ===========================================================================
// Tests — schema validation
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — schema validation", () => {
	it("output validates against taskRemoteExecutionDetailSchema", async () => {
		const metadata = makeRemoteMetadata({
			executionDurationSeconds: 60,
			tokenUsage: 2000,
		});
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({
					terminalState: "completed",
					resultSummary: "Done",
					remoteMetadata: metadata,
				}),
			],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail).not.toBeNull();
		const parsed = taskRemoteExecutionDetailSchema.safeParse(detail);
		expect(parsed.success).toBe(true);
	});
});

// ===========================================================================
// Tests — board semantics unchanged
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — board semantics", () => {
	it("does not include board column or card surface fields", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ remoteMetadata: makeRemoteMetadata() })],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail).not.toBeNull();
		const detailKeys = Object.keys(detail as TaskRemoteExecutionDetail);
		expect(detailKeys).not.toContain("column");
		expect(detailKeys).not.toContain("columnId");
		expect(detailKeys).not.toContain("prompt");
		expect(detailKeys).not.toContain("startInPlanMode");
		expect(detailKeys).not.toContain("autoReviewEnabled");
		expect(detailKeys).not.toContain("images");
	});
});

// ===========================================================================
// Tests — events-only lifecycle
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — events-only lifecycle", () => {
	it("derives state from events when no executions exist yet", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", trigger: "submit", fromState: "draft", toState: "queued" }),
				makeEvent({ eventId: "e2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
				makeEvent({ eventId: "e3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			],
			executions: [],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail).not.toBeNull();
		expect(detail?.cloudExecutionState).toBe("provisioning");
		expect(detail?.executionMode).toBeUndefined();
		expect(detail?.instanceId).toBeUndefined();
		expect(detail?.attemptHistory).toEqual([]);
		expect(detail?.eventCount).toBe(3);
	});
});

// ===========================================================================
// Tests — debug-preserve flag
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — debug preserve", () => {
	it("surfaces debugPreserve true from remote metadata", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ remoteMetadata: makeRemoteMetadata({ debugPreserve: true }) })],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.debugPreserve).toBe(true);
	});
});

// ===========================================================================
// Tests — metadata fallback across attempts
// ===========================================================================

describe("assembleTaskRemoteExecutionDetail — metadata fallback", () => {
	it("falls back to earlier attempt metadata when latest has none", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExecution({
					executionId: "exec-1",
					attemptNumber: 1,
					remoteMetadata: makeRemoteMetadata({ instanceId: "inst-first", promptHash: "sha256:first" }),
				}),
				makeExecution({ executionId: "exec-2", attemptNumber: 2 }),
			],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.instanceId).toBe("inst-first");
		expect(detail?.promptHash).toBe("sha256:first");
	});

	it("instanceId falls back to execution.instanceId when no metadata", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExecution({ instanceId: "inst-from-execution" })],
		});
		const detail = await assembleTaskRemoteExecutionDetail(store, "task-001");
		expect(detail?.instanceId).toBe("inst-from-execution");
	});
});
