import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CloudExecutionStore,
	DuplicateEventError,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
	type RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import { createTempDir } from "../../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: { path: string; cleanup: () => void };
let store: CloudExecutionStore;

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	return {
		eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
		executionId: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

beforeEach(() => {
	tempDir = createTempDir("kanban-cloud-persist-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

// ---------------------------------------------------------------------------
// Task Events — append-only recording
// ---------------------------------------------------------------------------

describe("task events — append-only recording", () => {
	it("returns empty array when no events exist", async () => {
		const events = await store.readEvents();
		expect(events).toEqual([]);
	});

	it("appends a single event and reads it back", async () => {
		const event = makeEvent({ eventId: "evt-1" });
		await store.appendEvent(event);

		const events = await store.readEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(event);
	});

	it("preserves insertion order across multiple appends", async () => {
		const e1 = makeEvent({ eventId: "evt-1", trigger: "submit", fromState: "draft", toState: "queued" });
		const e2 = makeEvent({ eventId: "evt-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" });
		const e3 = makeEvent({
			eventId: "evt-3",
			trigger: "authorized",
			fromState: "policy_check",
			toState: "provisioning",
		});

		await store.appendEvent(e1);
		await store.appendEvent(e2);
		await store.appendEvent(e3);

		const events = await store.readEvents();
		expect(events).toHaveLength(3);
		expect(events.map((e) => e.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
	});

	it("appends a batch of events atomically", async () => {
		const batch = [
			makeEvent({ eventId: "evt-batch-1" }),
			makeEvent({ eventId: "evt-batch-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
		];
		await store.appendEvents(batch);

		const events = await store.readEvents();
		expect(events).toHaveLength(2);
		expect(events.map((e) => e.eventId)).toEqual(["evt-batch-1", "evt-batch-2"]);
	});

	it("does nothing when appending an empty batch", async () => {
		await store.appendEvents([]);
		const events = await store.readEvents();
		expect(events).toHaveLength(0);
	});

	it("persists triggerSource and metadata on events", async () => {
		const event = makeEvent({
			eventId: "evt-meta",
			triggerSource: "callback",
			metadata: { callbackId: "cb-123", attemptCount: 1 },
		});
		await store.appendEvent(event);

		const events = await store.readEvents();
		expect(events[0]?.triggerSource).toBe("callback");
		expect(events[0]?.metadata).toEqual({ callbackId: "cb-123", attemptCount: 1 });
	});
});

// ---------------------------------------------------------------------------
// Task Events — deduplication
// ---------------------------------------------------------------------------

describe("task events — deduplication", () => {
	it("rejects a single event with a duplicate eventId", async () => {
		const event = makeEvent({ eventId: "evt-dup" });
		await store.appendEvent(event);

		await expect(store.appendEvent(event)).rejects.toThrow(DuplicateEventError);

		const events = await store.readEvents();
		expect(events).toHaveLength(1);
	});

	it("rejects a batch containing a duplicate of an existing event", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-existing" }));

		const batch = [makeEvent({ eventId: "evt-new" }), makeEvent({ eventId: "evt-existing" })];

		await expect(store.appendEvents(batch)).rejects.toThrow(DuplicateEventError);

		// Batch should be atomic — no partial writes
		const events = await store.readEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.eventId).toBe("evt-existing");
	});

	it("rejects a batch with internal duplicate eventIds", async () => {
		const batch = [makeEvent({ eventId: "evt-same" }), makeEvent({ eventId: "evt-same" })];

		await expect(store.appendEvents(batch)).rejects.toThrow(DuplicateEventError);

		const events = await store.readEvents();
		expect(events).toHaveLength(0);
	});

	it("DuplicateEventError has correct properties", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-props" }));

		try {
			await store.appendEvent(makeEvent({ eventId: "evt-props" }));
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(DuplicateEventError);
			expect(error).toBeInstanceOf(Error);
			const dupError = error as DuplicateEventError;
			expect(dupError.eventId).toBe("evt-props");
			expect(dupError.name).toBe("DuplicateEventError");
			expect(dupError.message).toContain("evt-props");
		}
	});
});

// ---------------------------------------------------------------------------
// Task Events — filtering by task
// ---------------------------------------------------------------------------

describe("task events — filtering by task", () => {
	it("returns only events for the requested taskId", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-t1-1", taskId: "task-001" }));
		await store.appendEvent(makeEvent({ eventId: "evt-t2-1", taskId: "task-002" }));
		await store.appendEvent(
			makeEvent({
				eventId: "evt-t1-2",
				taskId: "task-001",
				trigger: "dequeue",
				fromState: "queued",
				toState: "policy_check",
			}),
		);

		const task1Events = await store.readEventsForTask("task-001");
		expect(task1Events).toHaveLength(2);
		expect(task1Events.map((e) => e.eventId)).toEqual(["evt-t1-1", "evt-t1-2"]);

		const task2Events = await store.readEventsForTask("task-002");
		expect(task2Events).toHaveLength(1);
	});

	it("returns empty array for unknown taskId", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-1" }));
		const events = await store.readEventsForTask("nonexistent");
		expect(events).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Task Events — state derivation
// ---------------------------------------------------------------------------

describe("task events — state derivation", () => {
	it("returns draft for a task with no events", async () => {
		const state = await store.deriveTaskState("task-new");
		expect(state).toBe("draft");
	});

	it("returns toState of the last event for a task", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-1", toState: "queued" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
		);
		await store.appendEvent(
			makeEvent({ eventId: "evt-3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
		);

		const state = await store.deriveTaskState("task-001");
		expect(state).toBe("provisioning");
	});
});

// ---------------------------------------------------------------------------
// Task Executions — CRUD
// ---------------------------------------------------------------------------

describe("task executions — CRUD", () => {
	it("returns empty array when no executions exist", async () => {
		const executions = await store.readExecutions();
		expect(executions).toEqual([]);
	});

	it("creates and reads back an execution", async () => {
		const execution = makeExecution({ executionId: "exec-1" });
		await store.createExecution(execution);

		const executions = await store.readExecutions();
		expect(executions).toHaveLength(1);
		expect(executions[0]).toEqual(execution);
	});

	it("rejects duplicate executionId", async () => {
		const execution = makeExecution({ executionId: "exec-dup" });
		await store.createExecution(execution);

		await expect(store.createExecution(execution)).rejects.toThrow("already exists");

		const executions = await store.readExecutions();
		expect(executions).toHaveLength(1);
	});

	it("reads execution by executionId", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-1" }));
		await store.createExecution(makeExecution({ executionId: "exec-2", attemptNumber: 2 }));

		const exec = await store.readExecution("exec-2");
		expect(exec).not.toBeNull();
		expect(exec?.executionId).toBe("exec-2");
		expect(exec?.attemptNumber).toBe(2);
	});

	it("returns null for unknown executionId", async () => {
		const exec = await store.readExecution("nonexistent");
		expect(exec).toBeNull();
	});

	it("filters executions by taskId and sorts by attemptNumber", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-t1-a2", taskId: "task-001", attemptNumber: 2 }));
		await store.createExecution(makeExecution({ executionId: "exec-t2-a1", taskId: "task-002", attemptNumber: 1 }));
		await store.createExecution(makeExecution({ executionId: "exec-t1-a1", taskId: "task-001", attemptNumber: 1 }));

		const task1Executions = await store.readExecutionsForTask("task-001");
		expect(task1Executions).toHaveLength(2);
		expect(task1Executions.map((e) => e.attemptNumber)).toEqual([1, 2]);
	});
});

// ---------------------------------------------------------------------------
// Task Executions — updates
// ---------------------------------------------------------------------------

describe("task executions — updates", () => {
	it("updates startedAt and completedAt on an execution", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-upd" }));

		const updated = await store.updateExecution("exec-upd", {
			startedAt: "2026-01-01T00:00:00Z",
			completedAt: "2026-01-01T00:05:00Z",
		});
		expect(updated).toBe(true);

		const exec = await store.readExecution("exec-upd");
		expect(exec?.startedAt).toBe("2026-01-01T00:00:00Z");
		expect(exec?.completedAt).toBe("2026-01-01T00:05:00Z");
	});

	it("updates terminalState and resultSummary", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-term" }));

		await store.updateExecution("exec-term", {
			terminalState: "completed",
			resultSummary: "All tests passed.",
		});

		const exec = await store.readExecution("exec-term");
		expect(exec?.terminalState).toBe("completed");
		expect(exec?.resultSummary).toBe("All tests passed.");
	});

	it("returns false when updating a nonexistent execution", async () => {
		const updated = await store.updateExecution("nonexistent", {
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(updated).toBe(false);
	});

	it("preserves unmodified fields during update", async () => {
		const original = makeExecution({
			executionId: "exec-preserve",
			instanceId: "inst-original",
		});
		await store.createExecution(original);

		await store.updateExecution("exec-preserve", {
			terminalState: "failed",
		});

		const exec = await store.readExecution("exec-preserve");
		expect(exec?.instanceId).toBe("inst-original");
		expect(exec?.taskId).toBe(original.taskId);
		expect(exec?.attemptNumber).toBe(original.attemptNumber);
		expect(exec?.terminalState).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// Remote Execution Metadata
// ---------------------------------------------------------------------------

describe("remote execution metadata", () => {
	it("persists remote metadata alongside an execution", async () => {
		const metadata = makeRemoteMetadata();
		await store.createExecution(makeExecution({ executionId: "exec-remote", remoteMetadata: metadata }));

		const exec = await store.readExecution("exec-remote");
		expect(exec?.remoteMetadata).toEqual(metadata);
	});

	it("persists feature branch and worktree intent", async () => {
		const metadata = makeRemoteMetadata({
			featureBranch: "feature/cloud-task-42",
			worktreePath: "/workspace",
			baseBranch: "main",
			repoUrl: "https://github.com/cline/kanban.git",
		});
		await store.createExecution(makeExecution({ executionId: "exec-branch", remoteMetadata: metadata }));

		const exec = await store.readExecution("exec-branch");
		expect(exec?.remoteMetadata?.featureBranch).toBe("feature/cloud-task-42");
		expect(exec?.remoteMetadata?.worktreePath).toBe("/workspace");
		expect(exec?.remoteMetadata?.baseBranch).toBe("main");
		expect(exec?.remoteMetadata?.repoUrl).toBe("https://github.com/cline/kanban.git");
	});

	it("persists prompt hash and version", async () => {
		const metadata = makeRemoteMetadata({
			promptHash: "sha256:abc123",
			promptVersion: "v2",
		});
		await store.createExecution(makeExecution({ executionId: "exec-prompt", remoteMetadata: metadata }));

		const exec = await store.readExecution("exec-prompt");
		expect(exec?.remoteMetadata?.promptHash).toBe("sha256:abc123");
		expect(exec?.remoteMetadata?.promptVersion).toBe("v2");
	});

	it("persists callback URL and received timestamp", async () => {
		const metadata = makeRemoteMetadata({
			callbackUrl: "https://kanban.local/api/callback",
			callbackReceivedAt: "2026-01-01T00:10:00Z",
		});
		await store.createExecution(makeExecution({ executionId: "exec-cb", remoteMetadata: metadata }));

		const exec = await store.readExecution("exec-cb");
		expect(exec?.remoteMetadata?.callbackUrl).toBe("https://kanban.local/api/callback");
		expect(exec?.remoteMetadata?.callbackReceivedAt).toBe("2026-01-01T00:10:00Z");
	});

	it("persists debugPreserve flag", async () => {
		const metadata = makeRemoteMetadata({ debugPreserve: true });
		await store.createExecution(makeExecution({ executionId: "exec-debug", remoteMetadata: metadata }));

		const exec = await store.readExecution("exec-debug");
		expect(exec?.remoteMetadata?.debugPreserve).toBe(true);
	});

	it("updates remote metadata on an existing execution", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-upd-meta" }));

		const metadata = makeRemoteMetadata({ instanceStatus: "terminated" });
		await store.updateExecution("exec-upd-meta", { remoteMetadata: metadata });

		const exec = await store.readExecution("exec-upd-meta");
		expect(exec?.remoteMetadata?.instanceStatus).toBe("terminated");
		expect(exec?.remoteMetadata?.repoUrl).toBe(metadata.repoUrl);
	});
});

// ---------------------------------------------------------------------------
// Recovery after restart
// ---------------------------------------------------------------------------

describe("recovery after restart", () => {
	it("recovers events from a new store instance pointed at the same path", async () => {
		const e1 = makeEvent({ eventId: "evt-r1", toState: "queued" });
		const e2 = makeEvent({ eventId: "evt-r2", trigger: "dequeue", fromState: "queued", toState: "policy_check" });
		await store.appendEvent(e1);
		await store.appendEvent(e2);

		// Simulate restart by creating a new store instance
		const recoveredStore = new CloudExecutionStore(tempDir.path);
		const events = await recoveredStore.readEvents();
		expect(events).toHaveLength(2);
		expect(events.map((e) => e.eventId)).toEqual(["evt-r1", "evt-r2"]);
	});

	it("recovers executions from a new store instance pointed at the same path", async () => {
		const metadata = makeRemoteMetadata();
		await store.createExecution(makeExecution({ executionId: "exec-r1", remoteMetadata: metadata }));
		await store.updateExecution("exec-r1", {
			startedAt: "2026-01-01T00:00:00Z",
			terminalState: "completed",
			resultSummary: "Success",
		});

		// Simulate restart
		const recoveredStore = new CloudExecutionStore(tempDir.path);
		const exec = await recoveredStore.readExecution("exec-r1");
		expect(exec).not.toBeNull();
		expect(exec?.terminalState).toBe("completed");
		expect(exec?.resultSummary).toBe("Success");
		expect(exec?.remoteMetadata).toEqual(metadata);
	});

	it("recovers derived task state after restart", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-s1", toState: "queued" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-s2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
		);
		await store.appendEvent(
			makeEvent({ eventId: "evt-s3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
		);

		// Simulate restart
		const recoveredStore = new CloudExecutionStore(tempDir.path);
		const state = await recoveredStore.deriveTaskState("task-001");
		expect(state).toBe("provisioning");
	});

	it("maintains deduplication after restart", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-dedup" }));

		// Simulate restart
		const recoveredStore = new CloudExecutionStore(tempDir.path);
		await expect(recoveredStore.appendEvent(makeEvent({ eventId: "evt-dedup" }))).rejects.toThrow(
			DuplicateEventError,
		);
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle path
// ---------------------------------------------------------------------------

describe("full lifecycle path", () => {
	it("records a complete happy-path lifecycle with execution and metadata", async () => {
		const taskId = "task-lifecycle";

		// Create execution with remote metadata
		const metadata = makeRemoteMetadata({
			featureBranch: "task/lifecycle-test",
			worktreePath: "/workspace",
		});
		await store.createExecution(
			makeExecution({
				executionId: "exec-lifecycle",
				taskId,
				remoteMetadata: metadata,
			}),
		);

		// Record lifecycle events
		const events: PersistedTaskEvent[] = [
			makeEvent({
				eventId: "lc-1",
				taskId,
				trigger: "submit",
				fromState: "draft",
				toState: "queued",
				triggerSource: "user",
			}),
			makeEvent({
				eventId: "lc-2",
				taskId,
				trigger: "dequeue",
				fromState: "queued",
				toState: "policy_check",
				triggerSource: "system",
			}),
			makeEvent({
				eventId: "lc-3",
				taskId,
				trigger: "authorized",
				fromState: "policy_check",
				toState: "provisioning",
				triggerSource: "system",
			}),
			makeEvent({
				eventId: "lc-4",
				taskId,
				trigger: "sandbox_ready",
				fromState: "provisioning",
				toState: "running",
				triggerSource: "callback",
			}),
			makeEvent({
				eventId: "lc-5",
				taskId,
				trigger: "execution_done",
				fromState: "running",
				toState: "completing",
				triggerSource: "callback",
			}),
			makeEvent({
				eventId: "lc-6",
				taskId,
				trigger: "finalize_success",
				fromState: "completing",
				toState: "completed",
				triggerSource: "callback",
			}),
		];
		await store.appendEvents(events);

		// Update execution terminal state
		await store.updateExecution("exec-lifecycle", {
			startedAt: "2026-01-01T00:00:00Z",
			completedAt: "2026-01-01T00:05:00Z",
			terminalState: "completed",
			resultSummary: "PR created successfully.",
		});

		// Verify
		const state = await store.deriveTaskState(taskId);
		expect(state).toBe("completed");

		const taskEvents = await store.readEventsForTask(taskId);
		expect(taskEvents).toHaveLength(6);

		const exec = await store.readExecution("exec-lifecycle");
		expect(exec?.terminalState).toBe("completed");
		expect(exec?.remoteMetadata?.featureBranch).toBe("task/lifecycle-test");
		expect(exec?.resultSummary).toBe("PR created successfully.");
	});
});
