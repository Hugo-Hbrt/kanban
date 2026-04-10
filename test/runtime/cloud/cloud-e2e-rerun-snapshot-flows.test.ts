// ---------------------------------------------------------------------------
// E2E Rerun-from-Snapshot Flows — P3-2
// ---------------------------------------------------------------------------
//
// End-to-end contract tests for rerun-from-snapshot. Covers:
//   1. Rerun creation from prior attempt context
//   2. Snapshot fidelity (commit, prompt, config, branch intent)
//   3. Branch context options (fresh_branch / reuse_branch)
//   4. Source attempt immutability
//   5. Concurrency interaction (rerun blocked while task active)
//
// ---------------------------------------------------------------------------

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
const TASK_ID = "task-rerun-e2e-001";

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
		instanceId: "inst-e2e-abc",
		repoUrl: "https://github.com/cline/kanban.git",
		baseBranch: "main",
		featureBranch: "task/task-rerun-e2e-001",
		startingCommitSha: "abc123",
		promptVersion: "1",
		...overrides,
	};
}

async function setupTerminalTask(
	terminalState: CloudExecutionState = "failed",
	meta?: RemoteExecutionMetadata,
	executionId = "exec-initial",
): Promise<void> {
	await store.createExecution(
		makeExecution({
			executionId,
			attemptNumber: 1,
			terminalState,
			completedAt: new Date().toISOString(),
			resultSummary: terminalState === "failed" ? "Execution error" : "Success",
			remoteMetadata: meta ?? makeRemoteMetadata(),
		}),
	);
	const events: PersistedTaskEvent[] = [
		makeEvent({ eventId: "evt-1", trigger: "submit", fromState: "draft", toState: "queued" }),
		makeEvent({ eventId: "evt-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
		makeEvent({ eventId: "evt-3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
		makeEvent({ eventId: "evt-4", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
	];
	if (terminalState === "failed") {
		events.push(makeEvent({ eventId: "evt-5", trigger: "execution_error", fromState: "running", toState: "failed" }));
	} else if (terminalState === "completed") {
		events.push(
			makeEvent({ eventId: "evt-5", trigger: "execution_done", fromState: "running", toState: "completing" }),
		);
		events.push(
			makeEvent({ eventId: "evt-6", trigger: "finalize_success", fromState: "completing", toState: "completed" }),
		);
	} else if (terminalState === "canceled") {
		events.push(makeEvent({ eventId: "evt-5", trigger: "user_cancel", fromState: "running", toState: "canceled" }));
	}
	await store.appendEvents(events);
}

beforeEach(() => {
	tempDir = createTempDir("kanban-rerun-e2e-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

// ===========================================================================
// E2E: Rerun creation from prior attempt context
// ===========================================================================

describe("E2E Rerun-from-Snapshot — Rerun creation", () => {
	it("creates new attempt from failed attempt", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		expect(result.success).toBe(true);
		const success = result as RerunFromSnapshotSuccess;
		expect(success.newAttemptNumber).toBe(2);
		expect(success.branchIntent).toBe("fresh_branch");
		expect(success.execution.trigger).toBe("rerun_snapshot");
		expect(success.execution.instanceId).toBeUndefined();
		expect(success.execution.terminalState).toBeUndefined();
	});

	it("creates new attempt from completed attempt", async () => {
		await setupTerminalTask("completed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		expect(result.success).toBe(true);
		expect((result as RerunFromSnapshotSuccess).snapshot.sourceTerminalState).toBe("completed");
	});

	it("creates new attempt from canceled attempt", async () => {
		await setupTerminalTask("canceled");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		expect(result.success).toBe(true);
		expect((result as RerunFromSnapshotSuccess).snapshot.sourceTerminalState).toBe("canceled");
	});

	it("new execution has pending-provisioning instanceId (enters full lifecycle)", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		expect((result as RerunFromSnapshotSuccess).execution.remoteMetadata?.instanceId).toBe("pending-provisioning");
	});

	it("attempt history grows after rerun", async () => {
		await setupTerminalTask("failed");
		await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "user-e2e" });
		const executions = await store.readExecutionsForTask(TASK_ID);
		expect(executions).toHaveLength(2);
		expect(executions[0]?.attemptNumber).toBe(1);
		expect(executions[1]?.attemptNumber).toBe(2);
	});
});

// ===========================================================================
// E2E: Snapshot fidelity
// ===========================================================================

describe("E2E Rerun-from-Snapshot — Snapshot fidelity", () => {
	it("inherits commitSha and promptVersion from source attempt", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "orig-sha", promptVersion: "orig-v" }));
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.startingCommitSha).toBe("orig-sha");
		expect(exec.remoteMetadata?.promptVersion).toBe("orig-v");
	});

	it("override commitSha replaces snapshot value", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "old-sha" }));
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
			commitSha: "new-override-sha",
		});
		expect((result as RerunFromSnapshotSuccess).execution.remoteMetadata?.startingCommitSha).toBe("new-override-sha");
		expect((result as RerunFromSnapshotSuccess).execution.triggerMetadata?.pinnedCommitSha).toBe("new-override-sha");
	});

	it("override promptVersion replaces snapshot value", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
			promptVersion: "v-override",
		});
		expect((result as RerunFromSnapshotSuccess).execution.remoteMetadata?.promptVersion).toBe("v-override");
		expect((result as RerunFromSnapshotSuccess).execution.triggerMetadata?.pinnedPromptVersion).toBe("v-override");
	});

	it("snapshot captures exact source attempt context", async () => {
		await setupTerminalTask(
			"failed",
			makeRemoteMetadata({
				startingCommitSha: "exact-sha",
				promptVersion: "exact-v",
				featureBranch: "exact-branch",
			}),
		);
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		const snapshot = (result as RerunFromSnapshotSuccess).snapshot;
		expect(snapshot.commitSha).toBe("exact-sha");
		expect(snapshot.promptVersion).toBe("exact-v");
		expect(snapshot.featureBranch).toBe("exact-branch");
		expect(snapshot.sourceAttemptNumber).toBe(1);
		expect(snapshot.sourceExecutionId).toBe("exec-initial");
	});

	it("getSnapshotForAttempt matches snapshot in rerun result", async () => {
		await setupTerminalTask("failed");
		const inspected = await getSnapshotForAttempt(store, TASK_ID, 1);
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		const fromRerun = (result as RerunFromSnapshotSuccess).snapshot;
		expect(inspected?.sourceAttemptNumber).toBe(fromRerun.sourceAttemptNumber);
		expect(inspected?.sourceExecutionId).toBe(fromRerun.sourceExecutionId);
		expect(inspected?.commitSha).toBe(fromRerun.commitSha);
		expect(inspected?.promptVersion).toBe(fromRerun.promptVersion);
	});
});

// ===========================================================================
// E2E: Branch context options
// ===========================================================================

describe("E2E Rerun-from-Snapshot — Branch context options", () => {
	it("default fresh_branch creates clean execution context", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		const success = result as RerunFromSnapshotSuccess;
		expect(success.branchIntent).toBe("fresh_branch");
		expect(success.execution.branchIntent).toBe("fresh_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBeUndefined();
		expect(success.execution.triggerMetadata?.branchIntent).toBe("fresh_branch");
	});

	it("reuse_branch picks up source attempt feature branch", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ featureBranch: "task/attempt-branch" }));
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
			branchIntent: "reuse_branch",
		});
		const success = result as RerunFromSnapshotSuccess;
		expect(success.branchIntent).toBe("reuse_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBe("task/attempt-branch");
		expect(success.execution.triggerMetadata?.branchIntent).toBe("reuse_branch");
	});

	it("branch context from attempt 1 used even when attempt 2 has different branch", async () => {
		await setupTerminalTask(
			"failed",
			makeRemoteMetadata({ featureBranch: "task/branch-A", startingCommitSha: "sha-A" }),
		);
		await store.createExecution(
			makeExecution({
				executionId: "exec-2",
				attemptNumber: 2,
				terminalState: "failed",
				completedAt: new Date().toISOString(),
				remoteMetadata: makeRemoteMetadata({ featureBranch: "task/branch-B", startingCommitSha: "sha-B" }),
			}),
		);
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
			branchIntent: "reuse_branch",
		});
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.remoteMetadata?.featureBranch).toBe("task/branch-A");
		expect(exec.startingCommitSha).toBe("sha-A");
	});
});

// ===========================================================================
// E2E: Source attempt immutability
// ===========================================================================

describe("E2E Rerun-from-Snapshot — Source attempt immutability", () => {
	it("source attempt is unchanged after rerun", async () => {
		await setupTerminalTask("failed");
		await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "user-e2e" });
		const executions = await store.readExecutionsForTask(TASK_ID);
		const source = executions.find((e) => e.attemptNumber === 1);
		expect(source?.executionId).toBe("exec-initial");
		expect(source?.terminalState).toBe("failed");
		expect(source?.trigger).toBeUndefined();
		expect(source?.triggerMetadata).toBeUndefined();
	});

	it("multiple reruns from same source do not change source", async () => {
		await setupTerminalTask("failed");
		await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "user-e2e" });
		await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "user-e2e" });
		const executions = await store.readExecutionsForTask(TASK_ID);
		const source = executions.find((e) => e.attemptNumber === 1);
		expect(source?.executionId).toBe("exec-initial");
		expect(source?.terminalState).toBe("failed");
	});

	it("all reruns link back to source attempt via triggerMetadata", async () => {
		await setupTerminalTask("failed");
		const r1 = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "user-e2e" });
		const r2 = await rerunFromSnapshot(store, { taskId: TASK_ID, sourceAttemptNumber: 1, triggeredBy: "user-e2e" });
		expect((r1 as RerunFromSnapshotSuccess).execution.triggerMetadata?.previousAttemptNumber).toBe(1);
		expect((r1 as RerunFromSnapshotSuccess).execution.triggerMetadata?.previousExecutionId).toBe("exec-initial");
		expect((r2 as RerunFromSnapshotSuccess).execution.triggerMetadata?.previousAttemptNumber).toBe(1);
		expect((r2 as RerunFromSnapshotSuccess).execution.triggerMetadata?.previousExecutionId).toBe("exec-initial");
	});
});

// ===========================================================================
// E2E: Concurrency interaction
// ===========================================================================

describe("E2E Rerun-from-Snapshot — Concurrency interaction", () => {
	it("rerun is blocked when task is queued", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-active" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-q", trigger: "submit", fromState: "draft", toState: "queued" }),
		);
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		expect(result.success).toBe(false);
		expect((result as RerunFromSnapshotFailure).code).toBe("invalid_source_state");
	});

	it("rerun is blocked when task is running", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-running" }));
		await store.appendEvents([
			makeEvent({ eventId: "evt-c1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-c2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-c3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			makeEvent({ eventId: "evt-c4", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
		]);
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		expect(result.success).toBe(false);
		expect((result as RerunFromSnapshotFailure).code).toBe("invalid_source_state");
	});

	it("canRerunFromSnapshot returns false for active task", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-active" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-a", trigger: "submit", fromState: "draft", toState: "queued" }),
		);
		const check = await canRerunFromSnapshot(store, TASK_ID);
		expect(check.allowed).toBe(false);
	});

	it("rerun attempt starts without instanceId (must go through full lifecycle)", async () => {
		await setupTerminalTask("failed");
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
		});
		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.instanceId).toBeUndefined();
		expect(exec.startedAt).toBeUndefined();
		expect(exec.completedAt).toBeUndefined();
		expect(exec.remoteMetadata?.instanceId).toBe("pending-provisioning");
		expect(exec.remoteMetadata?.instanceHostname).toBeUndefined();
	});
});

// ===========================================================================
// E2E: Full scenario — multi-attempt history with reruns
// ===========================================================================

describe("E2E Rerun-from-Snapshot — Full scenario", () => {
	it("initial fail -> second attempt -> rerun from attempt 1", async () => {
		// Attempt 1: initial failure
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "sha-v1", promptVersion: "p1" }));
		// Attempt 2: another attempt
		await store.createExecution(
			makeExecution({
				executionId: "exec-attempt-2",
				attemptNumber: 2,
				terminalState: "failed",
				completedAt: new Date().toISOString(),
				remoteMetadata: makeRemoteMetadata({ startingCommitSha: "sha-v2", promptVersion: "p2" }),
			}),
		);

		// Rerun from attempt 1 to reproduce original failure
		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-e2e",
			reason: "Reproduce original failure",
		});

		expect(result.success).toBe(true);
		const success = result as RerunFromSnapshotSuccess;
		expect(success.snapshot.commitSha).toBe("sha-v1");
		expect(success.snapshot.promptVersion).toBe("p1");
		expect(success.newAttemptNumber).toBe(3);
		expect(success.execution.startingCommitSha).toBe("sha-v1");
		expect(success.execution.promptVersion).toBe("p1");
		expect(success.execution.trigger).toBe("rerun_snapshot");
		expect(success.execution.triggerMetadata?.previousAttemptNumber).toBe(1);
	});

	it("rerun with commit override for bisect debugging", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "bad-sha" }));

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-bisect",
			commitSha: "bisect-sha-middle",
			reason: "Bisecting failure point",
		});

		const exec = (result as RerunFromSnapshotSuccess).execution;
		expect(exec.startingCommitSha).toBe("bisect-sha-middle");
		expect(exec.remoteMetadata?.startingCommitSha).toBe("bisect-sha-middle");
		expect(exec.triggerMetadata?.pinnedCommitSha).toBe("bisect-sha-middle");
		expect(exec.triggerMetadata?.reason).toBe("Bisecting failure point");
	});
});
