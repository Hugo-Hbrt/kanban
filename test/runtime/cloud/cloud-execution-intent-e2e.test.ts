// ---------------------------------------------------------------------------
// Cloud Execution Intent E2E — Real Persistence Integration Test
// ---------------------------------------------------------------------------
//
// Proves retry/replay/rerun execution intent fidelity through real
// CloudExecutionStore with a temp directory. NOT mocks.
//
// Each test creates execution records, transitions through lifecycle states
// via real persistence, then verifies canonical field invariants.
//
// **Invariant: Kanban is the source of truth for execution intent.**
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type CallbackHeaders,
	type CallbackPayload,
	extractCallbackHeaders,
	ingestTerminalCallback,
	type CallbackIngestionContext,
	InMemoryCallbackDedupeStore,
} from "../../../src/cloud/cloud-callback-ingestion";
import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import {
	type CanonicalFieldsSnapshot,
	CloudExecutionStore,
	canonicalFieldsSnapshot,
	detectCanonicalFieldDrift,
	type PersistedTaskEvent,
	type PersistedTaskExecution,
	type RemoteExecutionMetadata,
} from "../../../src/cloud/cloud-execution-persistence";
import { rerunFromSnapshot } from "../../../src/cloud/cloud-execution-rerun-snapshot";
import { replayTask, retryTask } from "../../../src/cloud/cloud-execution-retry-replay";
import {
	reconcileTerminalCallback,
	type TerminalReconciliationContext,
} from "../../../src/cloud/cloud-terminal-reconciliation";
import { createTempDir } from "../../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Constants — canonical fields that must survive all lifecycle phases
// ---------------------------------------------------------------------------

const TASK_ID = "task-e2e-intent-001";
const CANONICAL_REPO_URL = "https://github.com/cline/kanban.git";
const CANONICAL_BASE_BRANCH = "main";
const CANONICAL_FEATURE_BRANCH = "task/e2e-intent-001";
const CANONICAL_WORKTREE_PATH = "/workspace/e2e-intent";
const CANONICAL_STARTING_COMMIT_SHA = "abc123def456789";
const CANONICAL_PROMPT_HASH = "sha256:deadbeef01234567";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: { path: string; cleanup: () => void };
let store: CloudExecutionStore;

beforeEach(() => {
	tempDir = createTempDir("kanban-intent-e2e-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

function makeEvent(overrides: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	return {
		eventId: randomUUID(),
		taskId: TASK_ID,
		trigger: "submit",
		fromState: "draft",
		toState: "queued",
		timestamp: new Date().toISOString(),
		triggerSource: "system",
		...overrides,
	};
}

function makeCanonicalRemoteMetadata(overrides: Partial<RemoteExecutionMetadata> = {}): RemoteExecutionMetadata {
	return {
		instanceId: "inst-e2e-001",
		instanceHostname: "sandbox-e2e.cloud.example.com",
		instanceStatus: "running",
		repoUrl: CANONICAL_REPO_URL,
		baseBranch: CANONICAL_BASE_BRANCH,
		featureBranch: CANONICAL_FEATURE_BRANCH,
		worktreePath: CANONICAL_WORKTREE_PATH,
		startingCommitSha: CANONICAL_STARTING_COMMIT_SHA,
		promptHash: CANONICAL_PROMPT_HASH,
		promptVersion: "v1",
		callbackUrl: "https://kanban.local/api/callback",
		debugPreserve: false,
		...overrides,
	};
}

function makeExecution(overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: randomUUID(),
		taskId: TASK_ID,
		attemptNumber: 1,
		instanceId: "inst-e2e-001",
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		remoteMetadata: makeCanonicalRemoteMetadata(),
		trigger: "initial",
		...overrides,
	};
}

const EXPECTED_CANONICAL: CanonicalFieldsSnapshot = {
	repoUrl: CANONICAL_REPO_URL,
	baseBranch: CANONICAL_BASE_BRANCH,
	featureBranch: CANONICAL_FEATURE_BRANCH,
	worktreePath: CANONICAL_WORKTREE_PATH,
	startingCommitSha: CANONICAL_STARTING_COMMIT_SHA,
	promptHash: CANONICAL_PROMPT_HASH,
};

/** Advance a task through lifecycle states to reach `target` via real persistence. */
async function advanceToState(taskId: string, target: CloudExecutionState): Promise<void> {
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
		["running", "execution_error", "failed"],
	];

	for (const [from, trigger, to] of transitions) {
		await store.appendEvent(
			makeEvent({ taskId, trigger, fromState: from, toState: to }),
		);
		if (to === target) return;
	}
}

/** Build a TerminalReconciliationContext backed by the real store. */
function buildReconciliationCtx(): TerminalReconciliationContext {
	return {
		deriveTaskState: (tid) => store.deriveTaskState(tid),
		appendEvent: (evt) => store.appendEvent(evt),
		appendEvents: (evts) => store.appendEvents(evts),
		readExecutionsForTask: (tid) => store.readExecutionsForTask(tid),
		updateExecution: (eid, updates) => store.updateExecution(eid, updates),
		now: () => new Date().toISOString(),
	};
}

/** Build a CallbackIngestionContext backed by the real store. */
function buildIngestionCtx(): CallbackIngestionContext {
	const dedupeStore = new InMemoryCallbackDedupeStore();
	return {
		getTaskExecutionState: (tid) => store.deriveTaskState(tid),
		hasProcessedCallback: async (key) => dedupeStore.has(key),
		recordProcessedCallback: async (key) => dedupeStore.add(key),
		signingSecret: null,
	};
}

// ===========================================================================
// 1. RETRY — canonical fields preserved, attemptNumber incremented
// ===========================================================================

describe("E2E: RETRY — canonical fields preserved through real persistence", () => {
	it("creates execution → fails → retryTask() → new execution has same repoUrl/baseBranch, incremented attempt, trigger=retry", async () => {
		// Seed: advance to failed state
		await advanceToState(TASK_ID, "failed");
		const originalExec = makeExecution();
		await store.createExecution(originalExec);

		// Capture canonical snapshot of original
		const originalCanonical = canonicalFieldsSnapshot(originalExec);

		// Retry
		const retryResult = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "test-user",
			reason: "E2E intent test",
		});

		expect(retryResult.success).toBe(true);
		if (!retryResult.success) return;

		// Read new execution from real persistence
		const executions = await store.readExecutionsForTask(TASK_ID);
		const newExec = executions.find((e) => e.executionId === retryResult.newExecutionId);
		expect(newExec).toBeDefined();
		if (!newExec) return;

		// Verify intent fidelity
		expect(newExec.attemptNumber).toBe(originalExec.attemptNumber + 1);
		expect(newExec.trigger).toBe("retry");
		expect(newExec.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(newExec.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);

		// featureBranch is cleared for fresh_branch (default intent)
		expect(newExec.branchIntent).toBe("fresh_branch");
		expect(newExec.remoteMetadata?.featureBranch).toBeUndefined();

		// startingCommitSha inherited from original
		expect(newExec.remoteMetadata?.startingCommitSha).toBe(CANONICAL_STARTING_COMMIT_SHA);
	});

	it("retry from real persistence roundtrip — read back matches write", async () => {
		await advanceToState(TASK_ID, "failed");
		await store.createExecution(makeExecution());

		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "e2e-test",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		// Re-read from disk to prove persistence, not memory
		const freshStore = new CloudExecutionStore(tempDir.path);
		const executions = await freshStore.readExecutionsForTask(TASK_ID);
		const retried = executions.find((e) => e.executionId === result.newExecutionId);
		expect(retried).toBeDefined();
		expect(retried?.trigger).toBe("retry");
		expect(retried?.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(retried?.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
	});
});

// ===========================================================================
// 2. REPLAY — canonical fields preserved, pinned commit SHA applied
// ===========================================================================

describe("E2E: REPLAY — canonical fields preserved, pinned commit SHA applied", () => {
	it("replay with pinnedCommitSha → new execution has pinned SHA, canonical fields unchanged", async () => {
		await advanceToState(TASK_ID, "failed");
		await store.createExecution(makeExecution());

		const pinnedSha = "pinned-sha-e2e-replay-001";
		const replayResult = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "test-user",
			reason: "E2E replay test",
			startingCommitSha: pinnedSha,
		});

		expect(replayResult.success).toBe(true);
		if (!replayResult.success) return;

		const executions = await store.readExecutionsForTask(TASK_ID);
		const newExec = executions.find((e) => e.executionId === replayResult.newExecutionId);
		expect(newExec).toBeDefined();
		if (!newExec) return;

		expect(newExec.trigger).toBe("replay");
		expect(newExec.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(newExec.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		expect(newExec.remoteMetadata?.startingCommitSha).toBe(pinnedSha);
		expect(newExec.attemptNumber).toBe(2);

		// Verify triggerMetadata records the pin
		expect(newExec.triggerMetadata?.pinnedCommitSha).toBe(pinnedSha);
	});

	it("replay roundtrip — re-read from fresh store instance proves on-disk fidelity", async () => {
		await advanceToState(TASK_ID, "failed");
		await store.createExecution(makeExecution());

		const pinnedSha = "pinned-sha-roundtrip";
		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "e2e",
			startingCommitSha: pinnedSha,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const freshStore = new CloudExecutionStore(tempDir.path);
		const replayed = (await freshStore.readExecutionsForTask(TASK_ID)).find(
			(e) => e.executionId === result.newExecutionId,
		);
		expect(replayed?.remoteMetadata?.startingCommitSha).toBe(pinnedSha);
		expect(replayed?.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
	});
});

// ===========================================================================
// 3. RERUN — repoUrl+baseBranch same, featureBranch is NEW, trigger=rerun_snapshot
// ===========================================================================

describe("E2E: RERUN — repoUrl/baseBranch preserved, featureBranch fresh, trigger=rerun_snapshot", () => {
	it("rerunFromSnapshot() → new execution preserves repoUrl/baseBranch, clears featureBranch (fresh_branch)", async () => {
		await advanceToState(TASK_ID, "failed");
		const originalExec = makeExecution({ terminalState: "failed" });
		await store.createExecution(originalExec);

		const rerunResult = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "test-user",
			reason: "E2E rerun test",
		});

		expect(rerunResult.success).toBe(true);
		if (!rerunResult.success) return;

		const executions = await store.readExecutionsForTask(TASK_ID);
		const newExec = executions.find((e) => e.executionId === rerunResult.newExecutionId);
		expect(newExec).toBeDefined();
		if (!newExec) return;

		expect(newExec.trigger).toBe("rerun_snapshot");
		expect(newExec.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(newExec.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		expect(newExec.remoteMetadata?.startingCommitSha).toBe(CANONICAL_STARTING_COMMIT_SHA);

		// fresh_branch default: featureBranch is cleared
		expect(newExec.branchIntent).toBe("fresh_branch");
		expect(newExec.remoteMetadata?.featureBranch).toBeUndefined();

		// Snapshot is captured from original
		expect(rerunResult.snapshot.sourceAttemptNumber).toBe(1);
		expect(rerunResult.snapshot.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(rerunResult.snapshot.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		expect(rerunResult.snapshot.commitSha).toBe(CANONICAL_STARTING_COMMIT_SHA);
	});

	it("rerun with reuse_branch preserves featureBranch from snapshot", async () => {
		await advanceToState(TASK_ID, "failed");
		await store.createExecution(makeExecution({ terminalState: "failed" }));

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "test-user",
			branchIntent: "reuse_branch",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const newExec = (await store.readExecutionsForTask(TASK_ID)).find(
			(e) => e.executionId === result.newExecutionId,
		);
		expect(newExec?.branchIntent).toBe("reuse_branch");
		expect(newExec?.remoteMetadata?.featureBranch).toBe(CANONICAL_FEATURE_BRANCH);
		expect(newExec?.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
	});

	it("rerun roundtrip — on-disk fidelity verified with fresh store", async () => {
		await advanceToState(TASK_ID, "failed");
		await store.createExecution(makeExecution({ terminalState: "failed" }));

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "e2e",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const freshStore = new CloudExecutionStore(tempDir.path);
		const rerun = (await freshStore.readExecutionsForTask(TASK_ID)).find(
			(e) => e.executionId === result.newExecutionId,
		);
		expect(rerun?.trigger).toBe("rerun_snapshot");
		expect(rerun?.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(rerun?.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
	});
});

// ===========================================================================
// 4. CALLBACK IMMUTABILITY — ingestTerminalCallback + reconcileTerminalCallback
//    → canonical fields unchanged on persisted execution
// ===========================================================================

describe("E2E: CALLBACK IMMUTABILITY — canonical fields unchanged after callback + reconciliation", () => {
	it("create execution → callback → reconcile → canonical fields unchanged in store", async () => {
		// Advance to running (the state that accepts terminal callbacks)
		await advanceToState(TASK_ID, "running");
		const originalExec = makeExecution();
		await store.createExecution(originalExec);

		// Capture canonical snapshot BEFORE callback
		const canonicalBefore = canonicalFieldsSnapshot(originalExec);

		// Ingest terminal callback
		const callbackBody = JSON.stringify({
			instanceId: "inst-e2e-001",
			taskId: TASK_ID,
			attemptNumber: 1,
			status: "success",
			prUrl: "https://github.com/org/repo/pull/42",
			taskOutput: "All tests pass",
			durationSeconds: 60,
			tokensUsed: 3000,
		});

		const ingestionCtx = buildIngestionCtx();
		const headers: CallbackHeaders = { timestamp: null, signature: null, eventId: randomUUID() };
		const ingestionResult = await ingestTerminalCallback(callbackBody, headers, {}, ingestionCtx);

		expect(ingestionResult.accepted).toBe(true);
		if (!ingestionResult.accepted) return;

		// Reconcile the accepted callback through real persistence
		const reconcileCtx = buildReconciliationCtx();
		const reconcileResult = await reconcileTerminalCallback(ingestionResult, reconcileCtx);

		expect(reconcileResult.reconciled).toBe(true);

		// Read the execution BACK from persistence
		const executions = await store.readExecutionsForTask(TASK_ID);
		const updatedExec = executions.find((e) => e.executionId === originalExec.executionId);
		expect(updatedExec).toBeDefined();
		if (!updatedExec) return;

		// Verify canonical fields are untouched
		const canonicalAfter = canonicalFieldsSnapshot(updatedExec);
		const drift = detectCanonicalFieldDrift(canonicalBefore, canonicalAfter);
		expect(drift).toEqual([]);

		// Verify the non-canonical fields WERE updated
		expect(updatedExec.terminalState).toBe("completing");
		expect(updatedExec.completedAt).toBeDefined();
		expect(updatedExec.resultSummary).toContain("status=success");
		expect(updatedExec.resultSummary).toContain("pr=https://github.com/org/repo/pull/42");
	});

	it("failed callback preserves error output AND canonical fields", async () => {
		await advanceToState(TASK_ID, "running");
		const originalExec = makeExecution();
		await store.createExecution(originalExec);
		const canonicalBefore = canonicalFieldsSnapshot(originalExec);

		const callbackBody = JSON.stringify({
			instanceId: "inst-e2e-001",
			taskId: TASK_ID,
			status: "failed",
			error: "OOM killed at step 3",
			taskOutput: "Partial output before crash",
		});

		const ingestionResult = await ingestTerminalCallback(
			callbackBody,
			{ timestamp: null, signature: null, eventId: randomUUID() },
			{},
			buildIngestionCtx(),
		);
		expect(ingestionResult.accepted).toBe(true);
		if (!ingestionResult.accepted) return;

		await reconcileTerminalCallback(ingestionResult, buildReconciliationCtx());

		const updatedExec = (await store.readExecutionsForTask(TASK_ID)).find(
			(e) => e.executionId === originalExec.executionId,
		);
		expect(updatedExec).toBeDefined();
		if (!updatedExec) return;

		// Canonical fields untouched
		const drift = detectCanonicalFieldDrift(canonicalBefore, canonicalFieldsSnapshot(updatedExec));
		expect(drift).toEqual([]);

		// Error IS persisted in resultSummary
		expect(updatedExec.terminalState).toBe("failed");
		expect(updatedExec.resultSummary).toContain("error=OOM killed at step 3");
		expect(updatedExec.resultSummary).toContain("output=Partial output before crash");
	});

	it("callback immutability roundtrip — fresh store read proves on-disk fidelity", async () => {
		await advanceToState(TASK_ID, "running");
		const originalExec = makeExecution();
		await store.createExecution(originalExec);

		const callbackBody = JSON.stringify({
			instanceId: "inst-e2e-001",
			taskId: TASK_ID,
			status: "success",
		});

		const ingestionResult = await ingestTerminalCallback(
			callbackBody,
			{ timestamp: null, signature: null, eventId: randomUUID() },
			{},
			buildIngestionCtx(),
		);
		expect(ingestionResult.accepted).toBe(true);
		if (!ingestionResult.accepted) return;

		await reconcileTerminalCallback(ingestionResult, buildReconciliationCtx());

		// Read from entirely fresh store instance
		const freshStore = new CloudExecutionStore(tempDir.path);
		const execFromDisk = (await freshStore.readExecutionsForTask(TASK_ID)).find(
			(e) => e.executionId === originalExec.executionId,
		);
		expect(execFromDisk).toBeDefined();
		if (!execFromDisk) return;

		const drift = detectCanonicalFieldDrift(
			canonicalFieldsSnapshot(originalExec),
			canonicalFieldsSnapshot(execFromDisk),
		);
		expect(drift).toEqual([]);
		expect(execFromDisk.terminalState).toBe("completing");
	});
});

// ===========================================================================
// 5. STATE PROGRESSION — canonical fields unchanged at each lifecycle state
// ===========================================================================

describe("E2E: STATE PROGRESSION — canonical fields unchanged at each lifecycle state", () => {
	it("canonical fields survive every state transition from draft to failed + teardown", async () => {
		const execution = makeExecution();
		await store.createExecution(execution);
		const canonicalExpected = canonicalFieldsSnapshot(execution);

		const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_error", "failed"],
			["failed", "auto_teardown", "teardown"],
		];

		for (const [from, trigger, to] of transitions) {
			await store.appendEvent(makeEvent({ trigger, fromState: from, toState: to }));

			// After each event, re-read execution and verify canonical fields
			const executions = await store.readExecutionsForTask(TASK_ID);
			const exec = executions.find((e) => e.executionId === execution.executionId);
			expect(exec).toBeDefined();
			if (!exec) return;

			const drift = detectCanonicalFieldDrift(canonicalExpected, canonicalFieldsSnapshot(exec));
			expect(drift).toEqual([]);
		}

		// Verify final state is teardown
		const finalState = await store.deriveTaskState(TASK_ID);
		expect(finalState).toBe("teardown");
	});

	it("canonical fields survive success path through completing to teardown", async () => {
		const execution = makeExecution();
		await store.createExecution(execution);
		const canonicalExpected = canonicalFieldsSnapshot(execution);

		const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_done", "completing"],
			["completing", "finalize_success", "completed"],
			["completed", "auto_teardown", "teardown"],
		];

		for (const [from, trigger, to] of transitions) {
			await store.appendEvent(makeEvent({ trigger, fromState: from, toState: to }));
		}

		// Re-read from fresh store to prove disk persistence
		const freshStore = new CloudExecutionStore(tempDir.path);
		const exec = (await freshStore.readExecutionsForTask(TASK_ID)).find(
			(e) => e.executionId === execution.executionId,
		);
		expect(exec).toBeDefined();
		if (!exec) return;

		const drift = detectCanonicalFieldDrift(canonicalExpected, canonicalFieldsSnapshot(exec));
		expect(drift).toEqual([]);

		const finalState = await freshStore.deriveTaskState(TASK_ID);
		expect(finalState).toBe("teardown");
	});

	it("events appended at each state are persisted and readable from fresh store", async () => {
		const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
		];

		for (const [from, trigger, to] of transitions) {
			await store.appendEvent(makeEvent({ trigger, fromState: from, toState: to }));
		}

		const freshStore = new CloudExecutionStore(tempDir.path);
		const events = await freshStore.readEventsForTask(TASK_ID);
		expect(events.length).toBe(transitions.length);

		const state = await freshStore.deriveTaskState(TASK_ID);
		expect(state).toBe("running");
	});
});

// ===========================================================================
// 6. FULL LIFECYCLE — retry after callback + reconciliation preserves intent
// ===========================================================================

describe("E2E: FULL LIFECYCLE — retry after callback+reconciliation preserves intent", () => {
	it("create → run → fail callback → reconcile → retry → verify both executions", async () => {
		// 1. Advance to running
		await advanceToState(TASK_ID, "running");
		const originalExec = makeExecution();
		await store.createExecution(originalExec);

		// 2. Failed callback + reconciliation
		const callbackBody = JSON.stringify({
			instanceId: "inst-e2e-001",
			taskId: TASK_ID,
			status: "failed",
			error: "Timeout after 300s",
		});
		const ingestionResult = await ingestTerminalCallback(
			callbackBody,
			{ timestamp: null, signature: null, eventId: randomUUID() },
			{},
			buildIngestionCtx(),
		);
		expect(ingestionResult.accepted).toBe(true);
		if (!ingestionResult.accepted) return;

		const reconcileResult = await reconcileTerminalCallback(ingestionResult, buildReconciliationCtx());
		expect(reconcileResult.reconciled).toBe(true);

		// 3. Retry from the failed state
		const retryResult = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "e2e-operator",
			reason: "Retry after timeout failure",
		});
		expect(retryResult.success).toBe(true);
		if (!retryResult.success) return;

		// 4. Verify both executions from fresh store
		const freshStore = new CloudExecutionStore(tempDir.path);
		const allExecs = await freshStore.readExecutionsForTask(TASK_ID);
		expect(allExecs.length).toBe(2);

		const original = allExecs.find((e) => e.executionId === originalExec.executionId);
		const retried = allExecs.find((e) => e.executionId === retryResult.newExecutionId);
		expect(original).toBeDefined();
		expect(retried).toBeDefined();
		if (!original || !retried) return;

		// Original has terminal state + error preserved
		expect(original.terminalState).toBe("failed");
		expect(original.resultSummary).toContain("error=Timeout after 300s");

		// Canonical fields of original are untouched
		const originalDrift = detectCanonicalFieldDrift(
			canonicalFieldsSnapshot(makeExecution()),
			canonicalFieldsSnapshot(original),
		);
		expect(originalDrift).toEqual([]);

		// Retried execution inherits repoUrl + baseBranch
		expect(retried.trigger).toBe("retry");
		expect(retried.attemptNumber).toBe(2);
		expect(retried.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(retried.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
	});
});
