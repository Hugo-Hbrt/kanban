import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import {
	CloudExecutionStore,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
	type RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import {
	canRerunFromSnapshot,
	DEFAULT_RERUN_BRANCH_INTENT,
	extractSnapshotFromAttempt,
	getSnapshotForAttempt,
	type RerunFromSnapshotFailure,
	type RerunFromSnapshotSuccess,
	rerunFromSnapshot,
} from "../../../src/cloud/cloud-execution-rerun-snapshot";
import { createTempDir } from "../../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: { path: string; cleanup: () => void };
let store: CloudExecutionStore;
const TASK_ID = "task-rerun-001";

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	return {
		eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId: TASK_ID,
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
		executionId: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId: TASK_ID,
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
		instanceStatus: "terminated",
		repoUrl: "https://github.com/cline/kanban.git",
		baseBranch: "main",
		featureBranch: "task/task-rerun-001",
		worktreePath: "/workspace",
		startingCommitSha: "abc123def456",
		promptHash: "sha256:deadbeef",
		promptVersion: "1",
		callbackUrl: "https://kanban.local/api/callback",
		callbackReceivedAt: "2026-01-01T00:10:00Z",
		debugPreserve: false,
		executionDurationSeconds: 120,
		tokenUsage: 5000,
		...overrides,
	};
}

async function setupTerminalTask(
	terminalState: CloudExecutionState = "failed",
	metadata?: RemoteExecutionMetadata,
	executionId = "exec-initial",
	attemptNumber = 1,
): Promise<void> {
	await store.createExecution(
		makeExecution({
			executionId,
			attemptNumber,
			terminalState,
			completedAt: new Date().toISOString(),
			resultSummary: terminalState === "failed" ? "Execution error" : "Success",
			remoteMetadata: metadata ?? makeRemoteMetadata(),
		}),
	);
	const events: PersistedTaskEvent[] = [
		makeEvent({ eventId: `evt-1-${attemptNumber}`, trigger: "submit", fromState: "draft", toState: "queued" }),
		makeEvent({
			eventId: `evt-2-${attemptNumber}`,
			trigger: "dequeue",
			fromState: "queued",
			toState: "policy_check",
		}),
		makeEvent({
			eventId: `evt-3-${attemptNumber}`,
			trigger: "authorized",
			fromState: "policy_check",
			toState: "provisioning",
		}),
		makeEvent({
			eventId: `evt-4-${attemptNumber}`,
			trigger: "sandbox_ready",
			fromState: "provisioning",
			toState: "running",
		}),
	];
	if (terminalState === "failed") {
		events.push(
			makeEvent({
				eventId: `evt-5-${attemptNumber}`,
				trigger: "execution_error",
				fromState: "running",
				toState: "failed",
			}),
		);
	} else if (terminalState === "completed") {
		events.push(
			makeEvent({
				eventId: `evt-5-${attemptNumber}`,
				trigger: "execution_done",
				fromState: "running",
				toState: "completing",
			}),
		);
		events.push(
			makeEvent({
				eventId: `evt-6-${attemptNumber}`,
				trigger: "finalize_success",
				fromState: "completing",
				toState: "completed",
			}),
		);
	} else if (terminalState === "canceled") {
		events.push(
			makeEvent({
				eventId: `evt-5-${attemptNumber}`,
				trigger: "user_cancel",
				fromState: "running",
				toState: "canceled",
			}),
		);
	}
	await store.appendEvents(events);
}

beforeEach(() => {
	tempDir = createTempDir("kanban-rerun-snapshot-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

// ---------------------------------------------------------------------------
// extractSnapshotFromAttempt — unit
// ---------------------------------------------------------------------------

describe("extractSnapshotFromAttempt", () => {
	it("captures all fields from execution with remote metadata", () => {
		const execution = makeExecution({
			executionId: "exec-snap-1",
			attemptNumber: 1,
			terminalState: "failed",
			startingCommitSha: "sha-top-level",
			promptVersion: "v2",
			promptHash: "hash-top-level",
			branchIntent: "fresh_branch",
			worktreeIntent: "/worktrees/task-001",
			remoteMetadata: makeRemoteMetadata({
				startingCommitSha: "sha-remote",
				promptVersion: "v1",
				featureBranch: "task/task-rerun-001",
				debugPreserve: true,
			}),
		});

		const snapshot = extractSnapshotFromAttempt(execution);

		expect(snapshot.taskId).toBe(TASK_ID);
		expect(snapshot.sourceAttemptNumber).toBe(1);
		expect(snapshot.sourceExecutionId).toBe("exec-snap-1");
		expect(snapshot.sourceTerminalState).toBe("failed");
		// Top-level fields take precedence over remoteMetadata
		expect(snapshot.commitSha).toBe("sha-top-level");
		expect(snapshot.promptVersion).toBe("v2");
		expect(snapshot.promptHash).toBe("hash-top-level");
		expect(snapshot.branchIntent).toBe("fresh_branch");
		expect(snapshot.worktreeIntent).toBe("/worktrees/task-001");
		// Remote metadata fields
		expect(snapshot.repoUrl).toBe("https://github.com/cline/kanban.git");
		expect(snapshot.baseBranch).toBe("main");
		expect(snapshot.featureBranch).toBe("task/task-rerun-001");
		expect(snapshot.debugPreserve).toBe(true);
		expect(snapshot.executionMode).toBe("cloud_agent");
		expect(snapshot.capturedAt).toBeTruthy();
	});

	it("falls back to remoteMetadata when top-level fields absent", () => {
		const execution = makeExecution({
			executionId: "exec-snap-2",
			attemptNumber: 2,
			remoteMetadata: makeRemoteMetadata({ startingCommitSha: "sha-from-meta", promptVersion: "v-meta" }),
		});
		const snapshot = extractSnapshotFromAttempt(execution);
		expect(snapshot.commitSha).toBe("sha-from-meta");
		expect(snapshot.promptVersion).toBe("v-meta");
	});

	it("handles execution without remote metadata gracefully", () => {
		const execution = makeExecution({ executionId: "exec-no-meta", attemptNumber: 1, terminalState: "failed" });
		const snapshot = extractSnapshotFromAttempt(execution);
		expect(snapshot.taskId).toBe(TASK_ID);
		expect(snapshot.commitSha).toBeUndefined();
		expect(snapshot.repoUrl).toBeUndefined();
		expect(snapshot.featureBranch).toBeUndefined();
	});

	it("snapshot is a new object (not mutated reference)", () => {
		const execution = makeExecution({ executionId: "exec-ref", attemptNumber: 1 });
		const snapshot = extractSnapshotFromAttempt(execution);
		expect(snapshot).not.toBe(execution);
	});
});

// ---------------------------------------------------------------------------
// rerunFromSnapshot — creation and trigger
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — creates new attempt", () => {
	it("creates new attempt from attempt 1", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-rerun",
		});
		expect(result.success).toBe(true);
		const success = result as RerunFromSnapshotSuccess;
		expect(success.taskId).toBe(TASK_ID);
		expect(success.newAttemptNumber).toBe(2);
		expect(success.newExecutionId).toBeTruthy();
		expect(success.branchIntent).toBe("fresh_branch");
	});

	it("trigger is rerun_snapshot (distinct from retry/replay)", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect((result as RerunFromSnapshotSuccess).execution.trigger).toBe("rerun_snapshot");
	});

	it("links to source attempt via triggerMetadata", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-rerun",
			reason: "Reproduce failure",
		});
		const meta = (result as RerunFromSnapshotSuccess).execution.triggerMetadata;
		expect(meta?.previousExecutionId).toBe("exec-initial");
		expect(meta?.previousAttemptNumber).toBe(1);
		expect(meta?.triggeredBy).toBe("user-rerun");
		expect(meta?.reason).toBe("Reproduce failure");
		expect(meta?.sourceState).toBe("failed");
	});

	it("source attempt remains immutable after rerun", async () => {
		await setupTerminalTask("failed");
		await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const executions = await store.readExecutionsForTask(TASK_ID);
		const sourceAttempt = executions.find((e) => e.attemptNumber === 1);
		expect(sourceAttempt?.executionId).toBe("exec-initial");
		expect(sourceAttempt?.terminalState).toBe("failed");
		expect(sourceAttempt?.trigger).toBeUndefined();
	});

	it("new execution has no terminal fields", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.instanceId).toBeUndefined();
		expect(exec.startedAt).toBeUndefined();
		expect(exec.completedAt).toBeUndefined();
		expect(exec.terminalState).toBeUndefined();
		expect(exec.resultSummary).toBeUndefined();
	});

	it("preserves executionMode from source attempt", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect((result as RerunFromSnapshotSuccess).execution.executionMode).toBe("cloud_agent");
	});
});

// ---------------------------------------------------------------------------
// Snapshot fidelity — commit, prompt, config captured exactly
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — snapshot fidelity", () => {
	it("inherits commitSha from source attempt when no override", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.startingCommitSha).toBe("abc123def456");
		expect(exec.startingCommitSha).toBe("abc123def456");
	});

	it("inherits promptVersion from source attempt when no override", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.promptVersion).toBe("1");
		expect(exec.promptVersion).toBe("1");
	});

	it("override commitSha takes precedence over snapshot", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "u",
			commitSha: "override-sha-999",
		});
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.startingCommitSha).toBe("override-sha-999");
		expect(exec.startingCommitSha).toBe("override-sha-999");
		expect(exec.triggerMetadata?.pinnedCommitSha).toBe("override-sha-999");
	});

	it("override promptVersion takes precedence over snapshot", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "u",
			promptVersion: "v99",
		});
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.promptVersion).toBe("v99");
		expect(exec.promptVersion).toBe("v99");
		expect(exec.triggerMetadata?.pinnedPromptVersion).toBe("v99");
	});

	it("snapshot in result reflects source attempt context exactly", async () => {
		await setupTerminalTask("completed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const snapshot = (result as RerunFromSnapshotSuccess).snapshot;
		expect(snapshot.sourceAttemptNumber).toBe(1);
		expect(snapshot.sourceExecutionId).toBe("exec-initial");
		expect(snapshot.sourceTerminalState).toBe("completed");
		expect(snapshot.commitSha).toBe("abc123def456");
		expect(snapshot.promptVersion).toBe("1");
		expect(snapshot.repoUrl).toBe("https://github.com/cline/kanban.git");
		expect(snapshot.baseBranch).toBe("main");
	});

	it("preserves debugPreserve from source attempt config", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ debugPreserve: true }));
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect((result as RerunFromSnapshotSuccess).execution.remoteMetadata?.debugPreserve).toBe(true);
	});

	it("preserves repoUrl and baseBranch from source attempt", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.repoUrl).toBe("https://github.com/cline/kanban.git");
		expect(exec.remoteMetadata?.baseBranch).toBe("main");
	});

	it("clears instance-specific runtime fields", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.instanceId).toBe("pending-provisioning");
		expect(exec.remoteMetadata?.instanceHostname).toBeUndefined();
		expect(exec.remoteMetadata?.instanceStatus).toBeUndefined();
		expect(exec.remoteMetadata?.callbackUrl).toBeUndefined();
		expect(exec.remoteMetadata?.callbackReceivedAt).toBeUndefined();
		expect(exec.remoteMetadata?.executionDurationSeconds).toBeUndefined();
		expect(exec.remoteMetadata?.tokenUsage).toBeUndefined();
		expect(exec.remoteMetadata?.promptHash).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Branch context — explicit, never silently inherited
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — branch context is explicit", () => {
	it("defaults to fresh_branch", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const success = result as RerunFromSnapshotSuccess;
		expect(success.branchIntent).toBe("fresh_branch");
		expect(success.execution.branchIntent).toBe("fresh_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBeUndefined();
	});

	it("fresh_branch clears featureBranch from source attempt", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ featureBranch: "task/task-rerun-001" }));
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "u",
			branchIntent: "fresh_branch",
		});
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.featureBranch).toBeUndefined();
		expect(exec.branchIntent).toBe("fresh_branch");
	});

	it("reuse_branch carries forward feature branch from source attempt", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "u",
			branchIntent: "reuse_branch",
		});
		const success = result as RerunFromSnapshotSuccess;
		expect(success.branchIntent).toBe("reuse_branch");
		expect(success.execution.branchIntent).toBe("reuse_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBe("task/task-rerun-001");
	});

	it("reuse_branch uses the specific source attempt's branch (not latest)", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ featureBranch: "task/attempt-1-branch" }));
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "u",
			branchIntent: "reuse_branch",
		});
		expect((result as RerunFromSnapshotSuccess).execution.remoteMetadata?.featureBranch).toBe(
			"task/attempt-1-branch",
		);
	});

	it("branchIntent is recorded in triggerMetadata", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "u",
			branchIntent: "reuse_branch",
		});
		expect((result as RerunFromSnapshotSuccess).execution.triggerMetadata?.branchIntent).toBe("reuse_branch");
	});

	it("DEFAULT_RERUN_BRANCH_INTENT is fresh_branch", () => {
		expect(DEFAULT_RERUN_BRANCH_INTENT).toBe("fresh_branch");
	});
});

// ---------------------------------------------------------------------------
// Specific attempt number targeting
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — targets specific attempt number", () => {
	it("reruns from attempt 1 when attempts 1 and 2 exist", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "sha-attempt-1" }));
		await store.createExecution(
			makeExecution({
				executionId: "exec-attempt-2",
				attemptNumber: 2,
				terminalState: "failed",
				completedAt: new Date().toISOString(),
				remoteMetadata: makeRemoteMetadata({ startingCommitSha: "sha-attempt-2" }),
			}),
		);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(true);
		const success = result as RerunFromSnapshotSuccess;
		expect(success.snapshot.sourceAttemptNumber).toBe(1);
		expect(success.snapshot.commitSha).toBe("sha-attempt-1");
		expect(success.newAttemptNumber).toBe(3);
		expect(success.execution.startingCommitSha).toBe("sha-attempt-1");
	});

	it("reruns from attempt 2 when attempts 1 and 2 exist", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "sha-attempt-1" }));
		await store.createExecution(
			makeExecution({
				executionId: "exec-attempt-2",
				attemptNumber: 2,
				terminalState: "failed",
				completedAt: new Date().toISOString(),
				remoteMetadata: makeRemoteMetadata({ startingCommitSha: "sha-attempt-2" }),
			}),
		);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 2, triggeredBy: "u" });
		expect(result.success).toBe(true);
		const success = result as RerunFromSnapshotSuccess;
		expect(success.snapshot.sourceAttemptNumber).toBe(2);
		expect(success.snapshot.commitSha).toBe("sha-attempt-2");
		expect(success.newAttemptNumber).toBe(3);
	});

	it("fails with attempt_not_found for non-existent attempt", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 99, triggeredBy: "u" });
		expect(result.success).toBe(false);
		expect((result as RerunFromSnapshotFailure).code).toBe("attempt_not_found");
		expect((result as RerunFromSnapshotFailure).reason).toContain("99");
		expect((result as RerunFromSnapshotFailure).reason).toContain("Available attempts: 1");
	});
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — failure cases", () => {
	it("fails with task_not_found when no executions exist", async () => {
		await store.appendEvents([
			makeEvent({ eventId: "evt-ne-1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-ne-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-ne-3", trigger: "denied", fromState: "policy_check", toState: "failed" }),
		]);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(false);
		expect((result as RerunFromSnapshotFailure).code).toBe("task_not_found");
	});

	it("fails with invalid_source_state when task is queued", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-queued" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-q1", trigger: "submit", fromState: "draft", toState: "queued" }),
		);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(false);
		expect((result as RerunFromSnapshotFailure).code).toBe("invalid_source_state");
		expect((result as RerunFromSnapshotFailure).reason).toContain("queued");
	});

	it("fails with invalid_source_state when task is running", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-running" }));
		await store.appendEvents([
			makeEvent({ eventId: "evt-rn1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-rn2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-rn3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			makeEvent({ eventId: "evt-rn4", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
		]);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(false);
		expect((result as RerunFromSnapshotFailure).code).toBe("invalid_source_state");
	});
});

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — from each terminal state", () => {
	const terminalStates: CloudExecutionState[] = ["completed", "failed", "canceled"];
	for (const terminalState of terminalStates) {
		it(`succeeds from ${terminalState}`, async () => {
			await setupTerminalTask(terminalState);
			const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
			expect(result.success).toBe(true);
			expect((result as RerunFromSnapshotSuccess).snapshot.sourceTerminalState).toBe(terminalState);
		});
	}

	it("succeeds from archived state", async () => {
		await setupTerminalTask("failed");
		const base = Date.now();
		await store.appendEvent(
			makeEvent({ eventId: `evt-td-${base}`, trigger: "auto_teardown", fromState: "failed", toState: "teardown" }),
		);
		await store.appendEvent(
			makeEvent({
				eventId: `evt-ar-${base}`,
				trigger: "sandbox_terminated",
				fromState: "teardown",
				toState: "archived",
			}),
		);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(true);
	});

	it("succeeds from teardown state", async () => {
		await setupTerminalTask("failed");
		const base = Date.now();
		await store.appendEvent(
			makeEvent({ eventId: `evt-td2-${base}`, trigger: "auto_teardown", fromState: "failed", toState: "teardown" }),
		);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Concurrency and lifecycle
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — lifecycle and concurrency", () => {
	it("new execution has no instanceId (fresh provisioning required)", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.instanceId).toBeUndefined();
		expect(exec.remoteMetadata?.instanceId).toBe("pending-provisioning");
	});

	it("new attempt is persisted and readable from store", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(true);
		const success = result as RerunFromSnapshotSuccess;
		const executions = await store.readExecutionsForTask(TASK_ID);
		expect(executions).toHaveLength(2);
		const newAttempt = executions.find((e) => e.executionId === success.newExecutionId);
		expect(newAttempt?.trigger).toBe("rerun_snapshot");
	});

	it("source attempt preserved immutably in history", async () => {
		await setupTerminalTask("failed");
		await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const executions = await store.readExecutionsForTask(TASK_ID);
		expect(executions).toHaveLength(2);
		expect(executions[0]?.terminalState).toBe("failed");
		expect(executions[0]?.trigger).toBeUndefined();
		expect(executions[1]?.trigger).toBe("rerun_snapshot");
	});

	it("multiple reruns create sequential attempt numbers", async () => {
		await setupTerminalTask("failed");
		const r1 = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect((r1 as RerunFromSnapshotSuccess).newAttemptNumber).toBe(2);
		const r2 = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect((r2 as RerunFromSnapshotSuccess).newAttemptNumber).toBe(3);
	});

	it("each rerun creates a unique executionId", async () => {
		await setupTerminalTask("failed");
		const r1 = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		const r2 = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect((r1 as RerunFromSnapshotSuccess).newExecutionId).not.toBe((r2 as RerunFromSnapshotSuccess).newExecutionId);
	});
});

// ---------------------------------------------------------------------------
// Helper: getSnapshotForAttempt
// ---------------------------------------------------------------------------

describe("getSnapshotForAttempt", () => {
	it("returns snapshot for existing attempt", async () => {
		await setupTerminalTask("failed");
		const snapshot = await getSnapshotForAttempt(store, TASK_ID, 1);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.sourceAttemptNumber).toBe(1);
		expect(snapshot?.sourceExecutionId).toBe("exec-initial");
		expect(snapshot?.commitSha).toBe("abc123def456");
	});

	it("returns null for non-existent attempt", async () => {
		await setupTerminalTask("failed");
		expect(await getSnapshotForAttempt(store, TASK_ID, 99)).toBeNull();
	});

	it("returns null for unknown task", async () => {
		expect(await getSnapshotForAttempt(store, "nonexistent-task", 1)).toBeNull();
	});

	it("does not modify source execution", async () => {
		await setupTerminalTask("failed");
		await getSnapshotForAttempt(store, TASK_ID, 1);
		const executions = await store.readExecutionsForTask(TASK_ID);
		expect(executions).toHaveLength(1);
		expect(executions[0]?.executionId).toBe("exec-initial");
	});
});

// ---------------------------------------------------------------------------
// Helper: canRerunFromSnapshot
// ---------------------------------------------------------------------------

describe("canRerunFromSnapshot", () => {
	it("returns allowed=true for task in terminal state", async () => {
		await setupTerminalTask("failed");
		const check = await canRerunFromSnapshot(store, TASK_ID);
		expect(check.allowed).toBe(true);
		expect(check.reason).toBeUndefined();
		expect(check.availableAttempts).toEqual([1]);
	});

	it("returns allowed=false for active task (queued)", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-act" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-can-1", trigger: "submit", fromState: "draft", toState: "queued" }),
		);
		const check = await canRerunFromSnapshot(store, TASK_ID);
		expect(check.allowed).toBe(false);
		expect(check.reason).toContain("queued");
		expect(check.availableAttempts).toEqual([1]);
	});

	it("returns empty availableAttempts when no executions", async () => {
		await store.appendEvent(makeEvent({ eventId: "evt-no-exec-can" }));
		const check = await canRerunFromSnapshot(store, TASK_ID);
		expect(check.allowed).toBe(false);
		expect(check.availableAttempts).toEqual([]);
	});

	it("lists all attempt numbers in availableAttempts", async () => {
		await setupTerminalTask("failed");
		await store.createExecution(
			makeExecution({ executionId: "exec-2", attemptNumber: 2, terminalState: "completed" }),
		);
		const check = await canRerunFromSnapshot(store, TASK_ID);
		expect(check.allowed).toBe(true);
		expect(check.availableAttempts).toContain(1);
		expect(check.availableAttempts).toContain(2);
	});
});

// ---------------------------------------------------------------------------
// Execution without remote metadata
// ---------------------------------------------------------------------------

describe("rerunFromSnapshot — execution without remote metadata", () => {
	it("handles gracefully", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-no-meta", terminalState: "failed" }));
		await store.appendEvents([
			makeEvent({ eventId: "evt-nm-1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-nm-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-nm-3", trigger: "denied", fromState: "policy_check", toState: "failed" }),
		]);
		const result = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "u" });
		expect(result.success).toBe(true);
		expect((result as RerunFromSnapshotSuccess).execution.remoteMetadata).toBeUndefined();
	});
});
