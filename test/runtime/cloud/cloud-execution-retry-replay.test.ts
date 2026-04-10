import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import {
	CloudExecutionStore,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
	type RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import {
	canRetry,
	DEFAULT_BRANCH_INTENT,
	DEFAULT_MAX_RETRY_COUNT,
	getAttemptHistory,
	getRetryCount,
	isRetryableState,
	RetryLimitExceededError,
	type RetryReplayFailure,
	type RetryReplaySuccess,
	replayTask,
	retryTask,
} from "../../../src/cloud/cloud-execution-retry-replay";
import { createTempDir } from "../../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: { path: string; cleanup: () => void };
let store: CloudExecutionStore;
const TASK_ID = "task-retry-001";

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
		featureBranch: "task/task-retry-001",
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
): Promise<void> {
	await store.createExecution(
		makeExecution({
			executionId: "exec-initial",
			attemptNumber: 1,
			terminalState,
			completedAt: new Date().toISOString(),
			resultSummary: terminalState === "failed" ? "Execution error" : "Success",
			remoteMetadata: metadata ?? makeRemoteMetadata(),
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

async function advanceToArchived(terminalState: CloudExecutionState): Promise<void> {
	const evtBase = Date.now();
	await store.appendEvent(
		makeEvent({
			eventId: `evt-td-${evtBase}`,
			trigger: "auto_teardown",
			fromState: terminalState,
			toState: "teardown",
		}),
	);
	await store.appendEvent(
		makeEvent({
			eventId: `evt-ar-${evtBase}`,
			trigger: "sandbox_terminated",
			fromState: "teardown",
			toState: "archived",
		}),
	);
}

beforeEach(() => {
	tempDir = createTempDir("kanban-retry-replay-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

// ---------------------------------------------------------------------------
// isRetryableState
// ---------------------------------------------------------------------------

describe("isRetryableState", () => {
	it("returns true for terminal and post-terminal states", () => {
		const retryable: CloudExecutionState[] = ["completed", "failed", "canceled", "teardown", "archived"];
		for (const state of retryable) {
			expect(isRetryableState(state)).toBe(true);
		}
	});

	it("returns false for active and pre-terminal states", () => {
		const nonRetryable: CloudExecutionState[] = [
			"draft",
			"queued",
			"policy_check",
			"provisioning",
			"running",
			"completing",
		];
		for (const state of nonRetryable) {
			expect(isRetryableState(state)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Retry from each terminal state
// ---------------------------------------------------------------------------

describe("retryTask — from each terminal state", () => {
	const terminalStates: CloudExecutionState[] = ["completed", "failed", "canceled"];

	for (const terminalState of terminalStates) {
		it(`creates new attempt from ${terminalState}`, async () => {
			await setupTerminalTask(terminalState);

			const result = await retryTask(store, {
				taskId: TASK_ID,
				triggeredBy: "user-123",
				reason: `Retry from ${terminalState}`,
			});

			expect(result.success).toBe(true);
			const success = result as RetryReplaySuccess;
			expect(success.newAttemptNumber).toBe(2);
			expect(success.branchIntent).toBe("fresh_branch");
			expect(success.triggerMetadata.type).toBe("retry");
			expect(success.triggerMetadata.triggeredBy).toBe("user-123");
			expect(success.triggerMetadata.sourceState).toBe(terminalState);
			expect(success.triggerMetadata.previousExecutionId).toBe("exec-initial");
			expect(success.triggerMetadata.previousAttemptNumber).toBe(1);
			expect(success.execution.instanceId).toBeUndefined();
			expect(success.execution.terminalState).toBeUndefined();
		});
	}

	it("creates new attempt from archived state", async () => {
		await setupTerminalTask("failed");
		await advanceToArchived("failed");

		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.newAttemptNumber).toBe(2);
		expect(success.triggerMetadata.sourceState).toBe("archived");
	});

	it("creates new attempt from teardown state", async () => {
		await setupTerminalTask("failed");
		const evtBase = Date.now();
		await store.appendEvent(
			makeEvent({
				eventId: `evt-td-${evtBase}`,
				trigger: "auto_teardown",
				fromState: "failed",
				toState: "teardown",
			}),
		);

		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(true);
		expect((result as RetryReplaySuccess).triggerMetadata.sourceState).toBe("teardown");
	});
});

// ---------------------------------------------------------------------------
// Retry rejection from active states
// ---------------------------------------------------------------------------

describe("retryTask — rejects from active states", () => {
	it("rejects retry from draft (no events)", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-draft" }));
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(false);
		expect((result as RetryReplayFailure).code).toBe("invalid_state");
	});

	it("rejects retry from queued", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-queued" }));
		await store.appendEvent(
			makeEvent({ eventId: "evt-q", trigger: "submit", fromState: "draft", toState: "queued" }),
		);
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(false);
		expect((result as RetryReplayFailure).code).toBe("invalid_state");
		expect((result as RetryReplayFailure).reason).toContain("queued");
	});

	it("rejects retry from running", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-running" }));
		await store.appendEvents([
			makeEvent({ eventId: "evt-r1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-r2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-r3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			makeEvent({ eventId: "evt-r4", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
		]);
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(false);
		expect((result as RetryReplayFailure).code).toBe("invalid_state");
	});
});

// ---------------------------------------------------------------------------
// Retry limit enforcement
// ---------------------------------------------------------------------------

describe("retryTask — retry limit enforcement", () => {
	it("enforces default retry limit of 2", async () => {
		await setupTerminalTask("failed");
		const r1 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(r1.success).toBe(true);
		const r2 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(r2.success).toBe(true);
		const r3 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(r3.success).toBe(false);
		expect((r3 as RetryReplayFailure).code).toBe("retry_limit_exceeded");
	});

	it("enforces custom retry limit", async () => {
		await setupTerminalTask("failed");
		const r1 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123", maxRetryCount: 1 });
		expect(r1.success).toBe(true);
		const r2 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123", maxRetryCount: 1 });
		expect(r2.success).toBe(false);
		expect((r2 as RetryReplayFailure).code).toBe("retry_limit_exceeded");
	});

	it("rejects retry when no previous execution exists", async () => {
		await store.appendEvents([
			makeEvent({ eventId: "evt-ne-1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-ne-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-ne-3", trigger: "denied", fromState: "policy_check", toState: "failed" }),
		]);
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(false);
		expect((result as RetryReplayFailure).code).toBe("no_previous_execution");
	});
});

// ---------------------------------------------------------------------------
// Branch intent decisions
// ---------------------------------------------------------------------------

describe("retryTask — branch intent", () => {
	it("defaults to fresh_branch", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.branchIntent).toBe("fresh_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBeUndefined();
	});

	it("honors explicit reuse_branch intent", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-123",
			branchIntent: "reuse_branch",
		});
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.branchIntent).toBe("reuse_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBe("task/task-retry-001");
	});

	it("clears instance-specific fields on retry", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		const exec = (result as RetryReplaySuccess).execution;
		expect(exec.instanceId).toBeUndefined();
		expect(exec.remoteMetadata?.instanceHostname).toBeUndefined();
		expect(exec.remoteMetadata?.instanceStatus).toBeUndefined();
		expect(exec.remoteMetadata?.callbackUrl).toBeUndefined();
		expect(exec.remoteMetadata?.callbackReceivedAt).toBeUndefined();
		expect(exec.remoteMetadata?.executionDurationSeconds).toBeUndefined();
		expect(exec.remoteMetadata?.tokenUsage).toBeUndefined();
		expect(exec.remoteMetadata?.promptHash).toBeUndefined();
	});

	it("preserves repo context on retry", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		const meta = (result as RetryReplaySuccess).execution.remoteMetadata;
		expect(meta?.repoUrl).toBe("https://github.com/cline/kanban.git");
		expect(meta?.baseBranch).toBe("main");
		expect(meta?.worktreePath).toBe("/workspace");
	});
});

// ---------------------------------------------------------------------------
// Replay with snapshot context
// ---------------------------------------------------------------------------

describe("replayTask — snapshot pinning", () => {
	it("pins to a specific commit SHA", async () => {
		await setupTerminalTask("completed");
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-456",
			startingCommitSha: "deadbeef123456",
		});
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.startingCommitSha).toBe("deadbeef123456");
		expect(success.triggerMetadata.type).toBe("replay");
		expect(success.triggerMetadata.pinnedCommitSha).toBe("deadbeef123456");
	});

	it("pins to a specific prompt version", async () => {
		await setupTerminalTask("completed");
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-456",
			promptVersion: "2",
		});
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.promptVersion).toBe("2");
		expect(success.triggerMetadata.pinnedPromptVersion).toBe("2");
	});

	it("pins both commit SHA and prompt version", async () => {
		await setupTerminalTask("failed");
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-456",
			startingCommitSha: "abc000",
			promptVersion: "3",
		});
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.startingCommitSha).toBe("abc000");
		expect(success.execution.remoteMetadata?.promptVersion).toBe("3");
	});

	it("inherits previous metadata when no overrides", async () => {
		await setupTerminalTask("failed");
		const result = await replayTask(store, { taskId: TASK_ID, triggeredBy: "user-456" });
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.startingCommitSha).toBe("abc123def456");
		expect(success.execution.remoteMetadata?.promptVersion).toBe("1");
	});

	it("supports reuse_branch intent on replay", async () => {
		await setupTerminalTask("failed");
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-456",
			branchIntent: "reuse_branch",
			startingCommitSha: "snapshot123",
		});
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.branchIntent).toBe("reuse_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBe("task/task-retry-001");
		expect(success.execution.remoteMetadata?.startingCommitSha).toBe("snapshot123");
	});

	it("replay counts toward retry limit", async () => {
		await setupTerminalTask("failed");
		const r1 = await replayTask(store, { taskId: TASK_ID, triggeredBy: "user-456", maxRetryCount: 1 });
		expect(r1.success).toBe(true);
		const r2 = await replayTask(store, { taskId: TASK_ID, triggeredBy: "user-456", maxRetryCount: 1 });
		expect(r2.success).toBe(false);
		expect((r2 as RetryReplayFailure).code).toBe("retry_limit_exceeded");
	});
});

// ---------------------------------------------------------------------------
// Attempt history preservation
// ---------------------------------------------------------------------------

describe("attempt history preservation", () => {
	it("preserves all attempts as separate execution records", async () => {
		await setupTerminalTask("failed");
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });

		const history = await getAttemptHistory(store, TASK_ID);
		expect(history).toHaveLength(3);
		expect(history.map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
	});

	it("preserves terminal state from previous attempts", async () => {
		await setupTerminalTask("failed");
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });

		const history = await getAttemptHistory(store, TASK_ID);
		expect(history[0]?.terminalState).toBe("failed");
		expect(history[0]?.resultSummary).toBe("Execution error");
		expect(history[1]?.terminalState).toBeUndefined();
	});

	it("each attempt has a unique executionId", async () => {
		await setupTerminalTask("failed");
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });

		const history = await getAttemptHistory(store, TASK_ID);
		const ids = history.map((e) => e.executionId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("getRetryCount returns correct count", async () => {
		await setupTerminalTask("failed");
		expect(await getRetryCount(store, TASK_ID)).toBe(0);
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(await getRetryCount(store, TASK_ID)).toBe(1);
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(await getRetryCount(store, TASK_ID)).toBe(2);
	});

	it("getRetryCount returns 0 for unknown task", async () => {
		expect(await getRetryCount(store, "nonexistent")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// canRetry helper
// ---------------------------------------------------------------------------

describe("canRetry", () => {
	it("returns allowed=true for retryable task", async () => {
		await setupTerminalTask("failed");
		const check = await canRetry(store, TASK_ID);
		expect(check.allowed).toBe(true);
		expect(check.reason).toBeUndefined();
	});

	it("returns allowed=false for active task", async () => {
		await store.createExecution(makeExecution());
		await store.appendEvent(
			makeEvent({ eventId: "evt-act", trigger: "submit", fromState: "draft", toState: "queued" }),
		);
		const check = await canRetry(store, TASK_ID);
		expect(check.allowed).toBe(false);
		expect(check.reason).toContain("queued");
	});

	it("returns allowed=false when limit exceeded", async () => {
		await setupTerminalTask("failed");
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		const check = await canRetry(store, TASK_ID);
		expect(check.allowed).toBe(false);
		expect(check.reason).toContain("Retry limit exceeded");
	});

	it("respects custom maxRetryCount", async () => {
		await setupTerminalTask("failed");
		const check = await canRetry(store, TASK_ID, 5);
		expect(check.allowed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// RetryLimitExceededError
// ---------------------------------------------------------------------------

describe("RetryLimitExceededError", () => {
	it("has correct properties", () => {
		const error = new RetryLimitExceededError("task-x", 3, 2);
		expect(error.name).toBe("RetryLimitExceededError");
		expect(error.taskId).toBe("task-x");
		expect(error.currentAttemptCount).toBe(3);
		expect(error.maxRetryCount).toBe(2);
		expect(error.message).toContain("task-x");
		expect(error.message).toContain("3 attempts");
		expect(error).toBeInstanceOf(Error);
	});
});

// ---------------------------------------------------------------------------
// Trigger metadata
// ---------------------------------------------------------------------------

describe("trigger metadata", () => {
	it("retry includes correct metadata fields", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-789",
			reason: "Transient failure",
		});
		expect(result.success).toBe(true);
		const meta = (result as RetryReplaySuccess).triggerMetadata;
		expect(meta.triggeredBy).toBe("user-789");
		expect(meta.reason).toBe("Transient failure");
		expect(meta.type).toBe("retry");
		expect(meta.triggeredAt).toBeTruthy();
		expect(meta.sourceState).toBe("failed");
		expect(meta.previousExecutionId).toBe("exec-initial");
		expect(meta.previousAttemptNumber).toBe(1);
		expect(meta.branchIntent).toBe("fresh_branch");
		expect(meta.pinnedCommitSha).toBeUndefined();
		expect(meta.pinnedPromptVersion).toBeUndefined();
	});

	it("replay includes pinned snapshot metadata", async () => {
		await setupTerminalTask("completed");
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-debug",
			reason: "Reproduce issue",
			startingCommitSha: "pin123",
			promptVersion: "42",
		});
		expect(result.success).toBe(true);
		const meta = (result as RetryReplaySuccess).triggerMetadata;
		expect(meta.type).toBe("replay");
		expect(meta.pinnedCommitSha).toBe("pin123");
		expect(meta.pinnedPromptVersion).toBe("42");
		expect(meta.reason).toBe("Reproduce issue");
	});
});

// ---------------------------------------------------------------------------
// Execution record correctness
// ---------------------------------------------------------------------------

describe("execution record correctness", () => {
	it("new execution has no instanceId", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect((result as RetryReplaySuccess).execution.instanceId).toBeUndefined();
	});

	it("preserves executionMode from previous attempt", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect((result as RetryReplaySuccess).execution.executionMode).toBe("cloud_agent");
	});

	it("has no terminal fields set", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		const exec = (result as RetryReplaySuccess).execution;
		expect(exec.startedAt).toBeUndefined();
		expect(exec.completedAt).toBeUndefined();
		expect(exec.terminalState).toBeUndefined();
		expect(exec.resultSummary).toBeUndefined();
	});

	it("handles execution without remote metadata", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-no-meta", terminalState: "failed" }));
		await store.appendEvents([
			makeEvent({ eventId: "evt-nm-1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "evt-nm-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "evt-nm-3", trigger: "denied", fromState: "policy_check", toState: "failed" }),
		]);
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect(result.success).toBe(true);
		expect((result as RetryReplaySuccess).execution.remoteMetadata).toBeUndefined();
	});

	it("debugPreserve is carried forward", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ debugPreserve: true }));
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-123" });
		expect((result as RetryReplaySuccess).execution.remoteMetadata?.debugPreserve).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
	it("DEFAULT_BRANCH_INTENT is fresh_branch", () => {
		expect(DEFAULT_BRANCH_INTENT).toBe("fresh_branch");
	});

	it("DEFAULT_MAX_RETRY_COUNT is 2", () => {
		expect(DEFAULT_MAX_RETRY_COUNT).toBe(2);
	});
});
