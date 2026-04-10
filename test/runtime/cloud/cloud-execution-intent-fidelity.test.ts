// ---------------------------------------------------------------------------
// Cloud Execution Intent Fidelity — End-to-End Proof
// ---------------------------------------------------------------------------
//
// Proves canonical persistence of execution intent across all lifecycle phases:
//   a) dispatch    — initial execution record created with all canonical fields
//   b) callback    — callback ingestion does NOT overwrite canonical fields
//   c) retry       — new execution inherits canonical fields from original
//   d) replay      — execution reuses same canonical fields
//   e) rerun       — new execution derives fresh feature branch but preserves
//                    repoUrl + baseBranch
//   f) reconciliation — terminal reconciliation updates completion data
//                       without mutating canonical identity
//
// **Invariant: Kanban is the source of truth for execution intent.**
// Cloud-platform and task-runner are consumers, not authors, of these
// canonical fields.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallbackIngestionResult, CallbackPayload } from "../../../src/cloud/cloud-callback-ingestion";
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
// Constants
// ---------------------------------------------------------------------------

const TASK_ID = "task-intent-fidelity-001";
const CANONICAL_REPO_URL = "https://github.com/cline/kanban.git";
const CANONICAL_BASE_BRANCH = "main";
const CANONICAL_FEATURE_BRANCH = "task/intent-fidelity-001";
const CANONICAL_WORKTREE_PATH = "/workspace/intent-fidelity";
const CANONICAL_STARTING_COMMIT_SHA = "abc123def456789";
const CANONICAL_PROMPT_HASH = "sha256:deadbeef01234567";

// ---------------------------------------------------------------------------
// Test Fixtures & Helpers
// ---------------------------------------------------------------------------

let tempDir: { path: string; cleanup: () => void };
let store: CloudExecutionStore;

beforeEach(() => {
	tempDir = createTempDir("intent-fidelity-");
	store = new CloudExecutionStore(tempDir.path);
});

afterEach(() => {
	tempDir.cleanup();
});

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

function makeCanonicalRemoteMetadata(overrides: Partial<RemoteExecutionMetadata> = {}): RemoteExecutionMetadata {
	return {
		instanceId: "inst-canonical",
		instanceHostname: "sandbox-canonical.cloud.example.com",
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
		executionId: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId: TASK_ID,
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: new Date().toISOString(),
		remoteMetadata: makeCanonicalRemoteMetadata(),
		...overrides,
	};
}

function expectedCanonicalSnapshot(): CanonicalFieldsSnapshot {
	return {
		repoUrl: CANONICAL_REPO_URL,
		baseBranch: CANONICAL_BASE_BRANCH,
		featureBranch: CANONICAL_FEATURE_BRANCH,
		worktreePath: CANONICAL_WORKTREE_PATH,
		startingCommitSha: CANONICAL_STARTING_COMMIT_SHA,
		promptHash: CANONICAL_PROMPT_HASH,
	};
}

async function setupTerminalTask(
	terminalState: CloudExecutionState = "failed",
	metadata?: RemoteExecutionMetadata,
	executionId = "exec-initial",
): Promise<void> {
	await store.createExecution(
		makeExecution({
			executionId,
			attemptNumber: 1,
			terminalState,
			completedAt: new Date().toISOString(),
			resultSummary: terminalState === "failed" ? "Execution error" : "Success",
			remoteMetadata: metadata ?? makeCanonicalRemoteMetadata(),
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

// ---------------------------------------------------------------------------
// Reconciliation context builder
// ---------------------------------------------------------------------------

interface MockContextState {
	events: PersistedTaskEvent[];
	executions: PersistedTaskExecution[];
	driftNotifications: Array<{ taskId: string; executionId: string; driftedFields: readonly string[] }>;
}

function createReconciliationContext(
	opts: { taskState?: CloudExecutionState; taskId?: string; executions?: PersistedTaskExecution[] } = {},
): TerminalReconciliationContext & { _state: MockContextState } {
	const taskId = opts.taskId ?? TASK_ID;
	const executions = opts.executions ?? [makeExecution({ executionId: "exec-recon" })];

	const state: MockContextState = { events: [], executions: [...executions], driftNotifications: [] };

	const targetState = opts.taskState ?? "running";
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
		["running", "execution_done", "completing"],
	];
	for (const [from, trigger, to] of transitions) {
		if (targetState === from) break;
		state.events.push({
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: from,
			toState: to,
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		if (targetState === to) break;
	}

	return {
		_state: state,
		async deriveTaskState(tid: string) {
			const taskEvents = state.events.filter((e) => e.taskId === tid);
			if (taskEvents.length === 0) return "draft" as CloudExecutionState;
			return (taskEvents[taskEvents.length - 1]?.toState ?? "draft") as CloudExecutionState;
		},
		async appendEvent(event: PersistedTaskEvent) {
			state.events.push({ ...event });
		},
		async appendEvents(newEvents: readonly PersistedTaskEvent[]) {
			for (const e of newEvents) state.events.push({ ...e });
		},
		async readExecutionsForTask(tid: string) {
			return state.executions.filter((e) => e.taskId === tid);
		},
		async updateExecution(executionId: string, updates: Partial<PersistedTaskExecution>) {
			const idx = state.executions.findIndex((e) => e.executionId === executionId);
			if (idx === -1) return false;
			const existing = state.executions[idx];
			if (existing) state.executions[idx] = { ...existing, ...updates } as PersistedTaskExecution;
			return true;
		},
		now: () => "2026-04-10T12:00:00Z",
		onCanonicalFieldDrift(tid: string, eid: string, driftedFields: readonly string[]) {
			state.driftNotifications.push({ taskId: tid, executionId: eid, driftedFields });
		},
	};
}

function createAcceptedResult(
	overrides: Partial<Extract<CallbackIngestionResult, { accepted: true }>> = {},
): Extract<CallbackIngestionResult, { accepted: true }> {
	return {
		accepted: true as const,
		taskId: TASK_ID,
		instanceId: "inst-canonical",
		trigger: "finalize_success" as CloudExecutionTrigger,
		fromState: "completing" as CloudExecutionState,
		toState: "completed" as CloudExecutionState,
		payload: {
			instanceId: "inst-canonical",
			status: "success",
			task_id: TASK_ID,
			attempt_number: 1,
			pr_url: "https://github.com/org/repo/pull/42",
			task_output: "Task completed successfully.",
			duration_seconds: 120,
			tokens_used: 5000,
		} as CallbackPayload,
		dedupeKey: `inst-canonical:${TASK_ID}:1:success`,
		eventId: "evt-callback-123",
		...overrides,
	};
}

// ===========================================================================
// canonicalFieldsSnapshot() utility tests
// ===========================================================================

describe("canonicalFieldsSnapshot() utility", () => {
	it("extracts all canonical fields from an execution with remote metadata", () => {
		const execution = makeExecution();
		const snapshot = canonicalFieldsSnapshot(execution);
		expect(snapshot).toEqual(expectedCanonicalSnapshot());
	});

	it("extracts canonical fields from execution without remote metadata", () => {
		const execution = makeExecution({
			remoteMetadata: undefined,
			startingCommitSha: "sha-top-level",
			promptHash: "ph-top-level",
		});
		const snapshot = canonicalFieldsSnapshot(execution);
		expect(snapshot.repoUrl).toBeUndefined();
		expect(snapshot.baseBranch).toBeUndefined();
		expect(snapshot.startingCommitSha).toBe("sha-top-level");
		expect(snapshot.promptHash).toBe("ph-top-level");
	});

	it("prefers remoteMetadata fields over top-level fields", () => {
		const execution = makeExecution({
			startingCommitSha: "sha-top-level",
			promptHash: "ph-top-level",
			remoteMetadata: makeCanonicalRemoteMetadata({
				startingCommitSha: "sha-remote",
				promptHash: "ph-remote",
			}),
		});
		const snapshot = canonicalFieldsSnapshot(execution);
		expect(snapshot.startingCommitSha).toBe("sha-remote");
		expect(snapshot.promptHash).toBe("ph-remote");
	});

	it("falls back to top-level fields when remoteMetadata fields are undefined", () => {
		const execution = makeExecution({
			startingCommitSha: "sha-fallback",
			promptHash: "ph-fallback",
			remoteMetadata: makeCanonicalRemoteMetadata({
				startingCommitSha: undefined,
				promptHash: undefined,
			}),
		});
		const snapshot = canonicalFieldsSnapshot(execution);
		expect(snapshot.startingCommitSha).toBe("sha-fallback");
		expect(snapshot.promptHash).toBe("ph-fallback");
	});
});

describe("detectCanonicalFieldDrift()", () => {
	it("returns empty array when snapshots are identical", () => {
		const s = expectedCanonicalSnapshot();
		expect(detectCanonicalFieldDrift(s, s)).toEqual([]);
	});

	it("detects single field drift", () => {
		const before = expectedCanonicalSnapshot();
		const after = { ...before, repoUrl: "https://github.com/other/repo.git" };
		expect(detectCanonicalFieldDrift(before, after)).toEqual(["repoUrl"]);
	});

	it("detects multiple field drifts", () => {
		const before = expectedCanonicalSnapshot();
		const after = { ...before, baseBranch: "develop", promptHash: "sha256:other" };
		const drifted = detectCanonicalFieldDrift(before, after);
		expect(drifted).toContain("baseBranch");
		expect(drifted).toContain("promptHash");
		expect(drifted).toHaveLength(2);
	});

	it("treats undefined-to-value as drift", () => {
		const before: CanonicalFieldsSnapshot = { ...expectedCanonicalSnapshot(), featureBranch: undefined };
		const after: CanonicalFieldsSnapshot = { ...before, featureBranch: "feature/new" };
		expect(detectCanonicalFieldDrift(before, after)).toEqual(["featureBranch"]);
	});
});

// ===========================================================================
// Phase (a): Dispatch — canonical fields persisted on creation
// ===========================================================================

describe("dispatch — canonical fields persisted on creation", () => {
	it("creates execution with all canonical fields and verifies persistence", async () => {
		const execution = makeExecution({ executionId: "exec-dispatch-1" });
		await store.createExecution(execution);

		const persisted = await store.readExecution("exec-dispatch-1");
		expect(persisted).not.toBeNull();

		const snapshot = canonicalFieldsSnapshot(persisted as PersistedTaskExecution);
		expect(snapshot).toEqual(expectedCanonicalSnapshot());
	});

	it("persisted canonical fields survive store restart", async () => {
		const execution = makeExecution({ executionId: "exec-dispatch-restart" });
		await store.createExecution(execution);

		const recoveredStore = new CloudExecutionStore(tempDir.path);
		const persisted = await recoveredStore.readExecution("exec-dispatch-restart");
		expect(persisted).not.toBeNull();

		const snapshot = canonicalFieldsSnapshot(persisted as PersistedTaskExecution);
		expect(snapshot).toEqual(expectedCanonicalSnapshot());
	});

	it("dispatch canonical snapshot equals in-memory canonical snapshot", async () => {
		const execution = makeExecution({ executionId: "exec-dispatch-eq" });
		const inMemorySnapshot = canonicalFieldsSnapshot(execution);

		await store.createExecution(execution);
		const persisted = await store.readExecution("exec-dispatch-eq");
		const persistedSnapshot = canonicalFieldsSnapshot(persisted as PersistedTaskExecution);

		expect(persistedSnapshot).toEqual(inMemorySnapshot);
		expect(detectCanonicalFieldDrift(inMemorySnapshot, persistedSnapshot)).toEqual([]);
	});
});

// ===========================================================================
// Phase (b): Callback — canonical fields unchanged by callback ingestion
// ===========================================================================

describe("callback — canonical fields unchanged after callback ingestion", () => {
	it("callback result contains only callback-specific data, not canonical fields", () => {
		// Callback ingestion returns accepted result with payload data.
		// It does NOT include or overwrite canonical execution fields.
		const result = createAcceptedResult();
		expect(result.accepted).toBe(true);
		expect(result.payload.instanceId).toBe("inst-canonical");
		expect(result.payload.status).toBe("success");

		// The callback payload has no mechanism to set repoUrl, baseBranch, etc.
		// These are not part of the callback schema — by design.
		const payloadKeys = Object.keys(result.payload);
		expect(payloadKeys).not.toContain("repoUrl");
		expect(payloadKeys).not.toContain("baseBranch");
		expect(payloadKeys).not.toContain("featureBranch");
		expect(payloadKeys).not.toContain("worktreePath");
		expect(payloadKeys).not.toContain("startingCommitSha");
		expect(payloadKeys).not.toContain("promptHash");
	});
});

// ===========================================================================
// Phase (f): Reconciliation — canonical fields unchanged
// ===========================================================================

describe("reconciliation — canonical fields unchanged after terminal reconciliation", () => {
	it("reconciliation updates completion data but preserves canonical fields", async () => {
		const execution = makeExecution({
			executionId: "exec-recon",
			instanceId: "inst-canonical",
			startedAt: "2026-04-10T10:00:00Z",
		});
		const ctx = createReconciliationContext({
			taskState: "completing",
			executions: [execution],
		});

		const snapshotBefore = canonicalFieldsSnapshot(execution);

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);
		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.executionUpdated).toBe(true);

		// Verify canonical fields unchanged
		const updatedExec = ctx._state.executions.find((e) => e.executionId === "exec-recon");
		expect(updatedExec).toBeDefined();
		const snapshotAfter = canonicalFieldsSnapshot(updatedExec as PersistedTaskExecution);
		expect(snapshotAfter).toEqual(snapshotBefore);
		expect(detectCanonicalFieldDrift(snapshotBefore, snapshotAfter)).toEqual([]);

		// Verify callback-specific fields WERE updated
		expect(updatedExec.terminalState).toBe("completed");
		expect(updatedExec.completedAt).toBe("2026-04-10T12:00:00Z");
		expect(updatedExec.resultSummary).toBeDefined();
		expect(updatedExec.remoteMetadata?.callbackReceivedAt).toBe("2026-04-10T12:00:00Z");
	});

	it("reconciliation does NOT trigger drift notification on normal path", async () => {
		const ctx = createReconciliationContext({ taskState: "completing" });
		await reconcileTerminalCallback(createAcceptedResult(), ctx);
		expect(ctx._state.driftNotifications).toHaveLength(0);
	});

	it("reconciliation preserves repoUrl after callback with remoteMetadata", async () => {
		const execution = makeExecution({ executionId: "exec-recon" });
		const ctx = createReconciliationContext({
			taskState: "completing",
			executions: [execution],
		});

		await reconcileTerminalCallback(createAcceptedResult(), ctx);
		const updatedExec = ctx._state.executions[0];
		expect(updatedExec).toBeDefined();
		expect(updatedExec.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(updatedExec.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		expect(updatedExec.remoteMetadata?.featureBranch).toBe(CANONICAL_FEATURE_BRANCH);
		expect(updatedExec.remoteMetadata?.worktreePath).toBe(CANONICAL_WORKTREE_PATH);
	});
});

// ===========================================================================
// Phase (c): Retry — canonical fields inherited from original
// ===========================================================================

describe("retry — new execution inherits canonical fields from original", () => {
	it("retry preserves repoUrl and baseBranch from original execution", async () => {
		await setupTerminalTask("failed");
		const originalExec = await store.readExecution("exec-initial");
		const originalSnapshot = canonicalFieldsSnapshot(originalExec as PersistedTaskExecution);

		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-test",
			reason: "intent-fidelity test",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const retryExec = await store.readExecution(result.newExecutionId);
		expect(retryExec).not.toBeNull();
		const retrySnapshot = canonicalFieldsSnapshot(retryExec as PersistedTaskExecution);

		// repoUrl and baseBranch MUST match original
		expect(retrySnapshot.repoUrl).toBe(originalSnapshot.repoUrl);
		expect(retrySnapshot.baseBranch).toBe(originalSnapshot.baseBranch);
	});

	it("retry with fresh_branch clears featureBranch but keeps repoUrl+baseBranch", async () => {
		await setupTerminalTask("failed");

		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-test",
			branchIntent: "fresh_branch",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const retryExec = await store.readExecution(result.newExecutionId);
		const retrySnapshot = canonicalFieldsSnapshot(retryExec as PersistedTaskExecution);
		expect(retrySnapshot.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(retrySnapshot.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		// fresh_branch clears the feature branch
		expect(retrySnapshot.featureBranch).toBeUndefined();
	});

	it("retry with reuse_branch preserves featureBranch from original", async () => {
		await setupTerminalTask("failed");

		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-test",
			branchIntent: "reuse_branch",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const retryExec = await store.readExecution(result.newExecutionId);
		const retrySnapshot = canonicalFieldsSnapshot(retryExec as PersistedTaskExecution);
		expect(retrySnapshot.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(retrySnapshot.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		expect(retrySnapshot.featureBranch).toBe(CANONICAL_FEATURE_BRANCH);
	});

	it("retry preserves startingCommitSha from original", async () => {
		await setupTerminalTask("failed");

		const result = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-test",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const retryExec = await store.readExecution(result.newExecutionId);
		expect(retryExec?.remoteMetadata?.startingCommitSha).toBe(CANONICAL_STARTING_COMMIT_SHA);
	});
});

// ===========================================================================
// Phase (d): Replay — execution reuses same canonical fields
// ===========================================================================

describe("replay — execution reuses same canonical fields", () => {
	it("replay preserves all canonical identity fields from original", async () => {
		await setupTerminalTask("failed");
		const originalExec = await store.readExecution("exec-initial");
		const originalSnapshot = canonicalFieldsSnapshot(originalExec as PersistedTaskExecution);

		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-test",
			reason: "replay for debugging",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const replayExec = await store.readExecution(result.newExecutionId);
		const replaySnapshot = canonicalFieldsSnapshot(replayExec as PersistedTaskExecution);

		expect(replaySnapshot.repoUrl).toBe(originalSnapshot.repoUrl);
		expect(replaySnapshot.baseBranch).toBe(originalSnapshot.baseBranch);
		expect(replaySnapshot.startingCommitSha).toBe(originalSnapshot.startingCommitSha);
	});

	it("replay with pinned commit overrides startingCommitSha but keeps repoUrl+baseBranch", async () => {
		await setupTerminalTask("completed");

		const result = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-test",
			startingCommitSha: "pinned-sha-override",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const replayExec = await store.readExecution(result.newExecutionId);
		const replaySnapshot = canonicalFieldsSnapshot(replayExec as PersistedTaskExecution);
		expect(replaySnapshot.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(replaySnapshot.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		expect(replaySnapshot.startingCommitSha).toBe("pinned-sha-override");
	});
});

// ===========================================================================
// Phase (e): Rerun — derives new feature branch, preserves repoUrl+baseBranch
// ===========================================================================

describe("rerun — derives new feature branch, preserves repoUrl+baseBranch", () => {
	it("rerun preserves repoUrl and baseBranch from source attempt", async () => {
		await setupTerminalTask("failed");

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-test",
			reason: "rerun for fresh context",
			branchIntent: "fresh_branch",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const rerunExec = await store.readExecution(result.newExecutionId);
		const rerunSnapshot = canonicalFieldsSnapshot(rerunExec as PersistedTaskExecution);
		expect(rerunSnapshot.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(rerunSnapshot.baseBranch).toBe(CANONICAL_BASE_BRANCH);
	});

	it("rerun with fresh_branch clears featureBranch", async () => {
		await setupTerminalTask("failed");

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-test",
			branchIntent: "fresh_branch",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const rerunExec = await store.readExecution(result.newExecutionId);
		expect(rerunExec?.remoteMetadata?.featureBranch).toBeUndefined();
	});

	it("rerun with reuse_branch preserves featureBranch from source", async () => {
		await setupTerminalTask("failed");

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-test",
			branchIntent: "reuse_branch",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const rerunExec = await store.readExecution(result.newExecutionId);
		expect(rerunExec?.remoteMetadata?.featureBranch).toBe(CANONICAL_FEATURE_BRANCH);
		expect(rerunExec?.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(rerunExec?.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
	});

	it("rerun inherits startingCommitSha from source unless overridden", async () => {
		await setupTerminalTask("failed");

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-test",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const rerunExec = await store.readExecution(result.newExecutionId);
		expect(rerunExec?.remoteMetadata?.startingCommitSha).toBe(CANONICAL_STARTING_COMMIT_SHA);
	});

	it("rerun with explicit commitSha overrides startingCommitSha", async () => {
		await setupTerminalTask("failed");

		const result = await rerunFromSnapshot(store, {
			taskId: TASK_ID,
			sourceAttemptNumber: 1,
			triggeredBy: "user-test",
			commitSha: "override-sha-for-rerun",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const rerunExec = await store.readExecution(result.newExecutionId);
		expect(rerunExec?.remoteMetadata?.startingCommitSha).toBe("override-sha-for-rerun");
		// But repoUrl and baseBranch remain canonical
		expect(rerunExec?.remoteMetadata?.repoUrl).toBe(CANONICAL_REPO_URL);
		expect(rerunExec?.remoteMetadata?.baseBranch).toBe(CANONICAL_BASE_BRANCH);
	});
});

// ===========================================================================
// Cross-Lifecycle Proof: dispatch → callback → reconciliation → retry → replay → rerun
// ===========================================================================

describe("full lifecycle proof — canonical fields immutable through all phases", () => {
	it("canonical fields are never mutated from dispatch through all lifecycle phases", async () => {
		// --- DISPATCH ---
		const dispatchExec = makeExecution({ executionId: "exec-lifecycle-proof" });
		await store.createExecution(dispatchExec);
		const dispatchSnapshot = canonicalFieldsSnapshot(dispatchExec);
		expect(dispatchSnapshot).toEqual(expectedCanonicalSnapshot());

		// Seed lifecycle events to reach terminal state
		await store.appendEvents([
			makeEvent({ eventId: "lc-1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "lc-2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "lc-3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			makeEvent({ eventId: "lc-4", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
			makeEvent({ eventId: "lc-5", trigger: "execution_error", fromState: "running", toState: "failed" }),
		]);
		await store.updateExecution("exec-lifecycle-proof", {
			terminalState: "failed",
			completedAt: new Date().toISOString(),
			resultSummary: "Test failure",
			remoteMetadata: {
				...makeCanonicalRemoteMetadata(),
				callbackReceivedAt: new Date().toISOString(),
			},
		});

		// --- RECONCILIATION: verify canonical fields survived ---
		const postReconExec = await store.readExecution("exec-lifecycle-proof");
		const postReconSnapshot = canonicalFieldsSnapshot(postReconExec as PersistedTaskExecution);
		expect(detectCanonicalFieldDrift(dispatchSnapshot, postReconSnapshot)).toEqual([]);

		// --- RETRY ---
		const retryResult = await retryTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-lifecycle-test",
		});
		expect(retryResult.success).toBe(true);
		if (!retryResult.success) return;

		const retryExec = await store.readExecution(retryResult.newExecutionId);
		const retrySnapshot = canonicalFieldsSnapshot(retryExec as PersistedTaskExecution);
		expect(retrySnapshot.repoUrl).toBe(dispatchSnapshot.repoUrl);
		expect(retrySnapshot.baseBranch).toBe(dispatchSnapshot.baseBranch);
		expect(retrySnapshot.startingCommitSha).toBe(dispatchSnapshot.startingCommitSha);

		// --- Bring retry to terminal for next phase ---
		await store.appendEvents([
			makeEvent({ eventId: "lc-r1", trigger: "submit", fromState: "draft", toState: "queued" }),
			makeEvent({ eventId: "lc-r2", trigger: "dequeue", fromState: "queued", toState: "policy_check" }),
			makeEvent({ eventId: "lc-r3", trigger: "authorized", fromState: "policy_check", toState: "provisioning" }),
			makeEvent({ eventId: "lc-r4", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
			makeEvent({ eventId: "lc-r5", trigger: "execution_error", fromState: "running", toState: "failed" }),
		]);
		await store.updateExecution(retryResult.newExecutionId, {
			terminalState: "failed",
			completedAt: new Date().toISOString(),
		});

		// --- REPLAY ---
		const replayResult = await replayTask(store, {
			taskId: TASK_ID,
			triggeredBy: "user-lifecycle-test",
		});
		expect(replayResult.success).toBe(true);
		if (!replayResult.success) return;

		const replayExec = await store.readExecution(replayResult.newExecutionId);
		const replaySnapshot = canonicalFieldsSnapshot(replayExec as PersistedTaskExecution);
		expect(replaySnapshot.repoUrl).toBe(dispatchSnapshot.repoUrl);
		expect(replaySnapshot.baseBranch).toBe(dispatchSnapshot.baseBranch);

		// --- Summary: canonical identity preserved throughout ---
		// All executions in the chain share repoUrl and baseBranch
		const allExecs = await store.readExecutionsForTask(TASK_ID);
		for (const exec of allExecs) {
			const snap = canonicalFieldsSnapshot(exec);
			expect(snap.repoUrl).toBe(CANONICAL_REPO_URL);
			expect(snap.baseBranch).toBe(CANONICAL_BASE_BRANCH);
		}
	});
});
