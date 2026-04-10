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
	getAttemptHistory,
	getRetryCount,
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
const TASK_ID = "task-retry-e2e-001";

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
		featureBranch: "task/task-retry-e2e-001",
		startingCommitSha: "abc123",
		promptVersion: "1",
		...overrides,
	};
}

async function setupTerminalTask(
	terminalState: CloudExecutionState = "failed",
	meta?: RemoteExecutionMetadata,
): Promise<void> {
	await store.createExecution(
		makeExecution({
			executionId: "exec-initial",
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
	tempDir = createTempDir("kanban-retry-e2e-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

// ===========================================================================
// Retry from failed, completed, canceled states
// ===========================================================================

describe("E2E Retry Flows — Retry from each terminal state", () => {
	for (const terminalState of ["failed", "completed", "canceled"] as CloudExecutionState[]) {
		it(`creates new attempt from ${terminalState}`, async () => {
			await setupTerminalTask(terminalState);
			const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
			expect(result.success).toBe(true);
			const success = result as RetryReplaySuccess;
			expect(success.newAttemptNumber).toBe(2);
			expect(success.branchIntent).toBe("fresh_branch");
			expect(success.triggerMetadata.type).toBe("retry");
			expect(success.triggerMetadata.sourceState).toBe(terminalState);
			expect(success.triggerMetadata.previousExecutionId).toBe("exec-initial");
			expect(success.execution.instanceId).toBeUndefined();
			expect(success.execution.terminalState).toBeUndefined();
		});
	}
});

// ===========================================================================
// Retry creates new attempt with fresh instance
// ===========================================================================

describe("E2E Retry Flows — Fresh instance on retry", () => {
	it("new execution has no instanceId (fresh provisioning)", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		const success = result as RetryReplaySuccess;
		expect(success.execution.instanceId).toBeUndefined();
		expect(success.execution.startedAt).toBeUndefined();
		expect(success.execution.completedAt).toBeUndefined();
	});

	it("remote metadata has pending-provisioning instanceId", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.instanceId).toBe("pending-provisioning");
	});

	it("attempt history grows on each retry", async () => {
		await setupTerminalTask("failed");
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		const history = await getAttemptHistory(store, TASK_ID);
		expect(history).toHaveLength(2);
		expect(history[0]?.attemptNumber).toBe(1);
		expect(history[1]?.attemptNumber).toBe(2);
	});
});

// ===========================================================================
// Replay with pinned commit/prompt
// ===========================================================================

describe("E2E Retry Flows — Replay with pinned commit/prompt", () => {
	it("replay pins startingCommitSha and promptVersion", async () => {
		await setupTerminalTask("failed");
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-e2e",
			startingCommitSha: "pinned-sha-abc",
			promptVersion: "v2",
		});
		expect(result.success).toBe(true);
		const success = result as RetryReplaySuccess;
		expect(success.triggerMetadata.type).toBe("replay");
		expect(success.triggerMetadata.pinnedCommitSha).toBe("pinned-sha-abc");
		expect(success.triggerMetadata.pinnedPromptVersion).toBe("v2");
		expect(success.execution.remoteMetadata?.startingCommitSha).toBe("pinned-sha-abc");
		expect(success.execution.remoteMetadata?.promptVersion).toBe("v2");
	});

	it("replay without pinned values inherits from previous execution", async () => {
		await setupTerminalTask("failed", makeRemoteMetadata({ startingCommitSha: "orig-sha", promptVersion: "v1" }));
		const result = await replayTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.startingCommitSha).toBe("orig-sha");
		expect(success.execution.remoteMetadata?.promptVersion).toBe("v1");
	});
});

// ===========================================================================
// Retry limit enforcement
// ===========================================================================

describe("E2E Retry Flows — Retry limit enforcement", () => {
	it("default limit allows 2 retries (3 total attempts)", async () => {
		await setupTerminalTask("failed");
		const r1 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		expect(r1.success).toBe(true);
		const r2 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		expect(r2.success).toBe(true);
		const r3 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		expect(r3.success).toBe(false);
		expect((r3 as RetryReplayFailure).code).toBe("retry_limit_exceeded");
	});

	it("custom maxRetryCount=1 allows only 1 retry", async () => {
		await setupTerminalTask("failed");
		const r1 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e", maxRetryCount: 1 });
		expect(r1.success).toBe(true);
		const r2 = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e", maxRetryCount: 1 });
		expect(r2.success).toBe(false);
		expect((r2 as RetryReplayFailure).code).toBe("retry_limit_exceeded");
	});

	it("canRetry reflects limit correctly", async () => {
		await setupTerminalTask("failed");
		const check1 = await canRetry(store, TASK_ID, 1);
		expect(check1.allowed).toBe(true);
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e", maxRetryCount: 1 });
		const check2 = await canRetry(store, TASK_ID, 1);
		expect(check2.allowed).toBe(false);
	});

	it("getRetryCount increments after each retry", async () => {
		await setupTerminalTask("failed");
		expect(await getRetryCount(store, TASK_ID)).toBe(0);
		await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		expect(await getRetryCount(store, TASK_ID)).toBe(1);
	});
});

// ===========================================================================
// Branch context is explicit on retry
// ===========================================================================

describe("E2E Retry Flows — Branch context is explicit on retry", () => {
	it("default branchIntent is fresh_branch", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		const success = result as RetryReplaySuccess;
		expect(success.branchIntent).toBe("fresh_branch");
		expect(success.triggerMetadata.branchIntent).toBe("fresh_branch");
	});

	it("reuse_branch intent is recorded", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e", branchIntent: "reuse_branch" });
		const success = result as RetryReplaySuccess;
		expect(success.branchIntent).toBe("reuse_branch");
		expect(success.execution.remoteMetadata?.featureBranch).toBe("task/task-retry-e2e-001");
	});

	it("fresh_branch clears featureBranch", async () => {
		await setupTerminalTask("failed");
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e", branchIntent: "fresh_branch" });
		const success = result as RetryReplaySuccess;
		expect(success.execution.remoteMetadata?.featureBranch).toBeUndefined();
	});

	it("retry rejects from active state", async () => {
		await store.createExecution(makeExecution({ executionId: "exec-active" }));
		await store.appendEvents([
			makeEvent({ eventId: "evt-a1", trigger: "submit", fromState: "draft", toState: "queued" }),
		]);
		const result = await retryTask(store, { taskId: TASK_ID, triggeredBy: "user-e2e" });
		expect(result.success).toBe(false);
		expect((result as RetryReplayFailure).code).toBe("invalid_state");
	});
});
