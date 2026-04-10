import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CallbackIngestionResult, CallbackPayload } from "../../../src/cloud/cloud-callback-ingestion";
import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import {
	buildResultSummary,
	buildTerminalEventMetadata,
	reconcileTerminalCallback,
	type TerminalReconciliationContext,
} from "../../../src/cloud/cloud-terminal-reconciliation";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createBasePayload(overrides: Partial<CallbackPayload> = {}): CallbackPayload {
	return {
		instanceId: "inst_abc",
		status: "success",
		task_id: "task-1",
		attempt_number: 1,
		pr_url: "https://github.com/org/repo/pull/42",
		task_output: "Task completed successfully.",
		error: "",
		duration_seconds: 120,
		tokens_used: 5000,
		...overrides,
	};
}

function createAcceptedResult(
	overrides: Partial<Extract<CallbackIngestionResult, { accepted: true }>> = {},
): Extract<CallbackIngestionResult, { accepted: true }> {
	return {
		accepted: true as const,
		taskId: "task-1",
		instanceId: "inst_abc",
		trigger: "execution_done" as CloudExecutionTrigger,
		fromState: "running" as CloudExecutionState,
		toState: "completing" as CloudExecutionState,
		payload: createBasePayload(),
		dedupeKey: "inst_abc:task-1:1:success",
		eventId: "evt-123",
		...overrides,
	};
}

function makeExecution(overrides: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: overrides.executionId ?? randomUUID(),
		taskId: "task-1",
		attemptNumber: 1,
		instanceId: "inst_abc",
		executionMode: "cloud_agent",
		createdAt: "2026-04-09T10:00:00Z",
		startedAt: "2026-04-09T10:01:00Z",
		remoteMetadata: {
			instanceId: "inst_abc",
			repoUrl: "https://github.com/org/repo",
			baseBranch: "main",
			debugPreserve: false,
		},
		...overrides,
	};
}

/** Seed events to put a task in a specific state. */
function buildEventsToState(taskId: string, targetState: CloudExecutionState): PersistedTaskEvent[] {
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
	];

	const events: PersistedTaskEvent[] = [];
	for (const [from, trigger, to] of transitions) {
		if (targetState === from) break;
		events.push({
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
	return events;
}

interface MockContextState {
	events: PersistedTaskEvent[];
	executions: PersistedTaskExecution[];
	boardColumns: Record<string, string>;
}

function createMockContext(
	opts: {
		taskState?: CloudExecutionState;
		taskId?: string;
		executions?: PersistedTaskExecution[];
		boardColumns?: Record<string, string>;
		withBoardCheck?: boolean;
	} = {},
): TerminalReconciliationContext & { _state: MockContextState } {
	const taskId = opts.taskId ?? "task-1";
	const events = buildEventsToState(taskId, opts.taskState ?? "running");
	const executions = opts.executions ?? [makeExecution()];
	const boardColumns = opts.boardColumns ?? {};

	const state: MockContextState = { events: [...events], executions: [...executions], boardColumns };

	const ctx: TerminalReconciliationContext & { _state: MockContextState } = {
		_state: state,
		async deriveTaskState(tid: string): Promise<CloudExecutionState> {
			const taskEvents = state.events.filter((e) => e.taskId === tid);
			if (taskEvents.length === 0) return "draft";
			const lastEvent = taskEvents[taskEvents.length - 1];
			return lastEvent?.toState ?? "draft";
		},
		async appendEvent(event: PersistedTaskEvent): Promise<void> {
			if (state.events.some((e) => e.eventId === event.eventId)) {
				throw new Error(`Duplicate event: ${event.eventId}`);
			}
			state.events.push({ ...event });
		},
		async appendEvents(newEvents: readonly PersistedTaskEvent[]): Promise<void> {
			for (const e of newEvents) {
				if (state.events.some((ex) => ex.eventId === e.eventId)) {
					throw new Error(`Duplicate event: ${e.eventId}`);
				}
				state.events.push({ ...e });
			}
		},
		async readExecutionsForTask(tid: string): Promise<readonly PersistedTaskExecution[]> {
			return state.executions.filter((e) => e.taskId === tid);
		},
		async updateExecution(executionId: string, updates: Partial<PersistedTaskExecution>): Promise<boolean> {
			const idx = state.executions.findIndex((e) => e.executionId === executionId);
			if (idx === -1) return false;
			const existing = state.executions[idx];
			if (existing) state.executions[idx] = { ...existing, ...updates } as PersistedTaskExecution;
			return true;
		},
		now: () => "2026-04-09T12:00:00Z",
	};

	if (opts.withBoardCheck) {
		ctx.getTaskBoardColumn = async (tid: string) => state.boardColumns[tid] ?? null;
	}

	return ctx;
}

// ---------------------------------------------------------------------------
// buildResultSummary
// ---------------------------------------------------------------------------

describe("buildResultSummary", () => {
	it("includes status for minimal payload", () => {
		const summary = buildResultSummary({ instanceId: "i", status: "success" });
		expect(summary).toBe("status=success");
	});

	it("includes all fields when present", () => {
		const summary = buildResultSummary(createBasePayload());
		expect(summary).toContain("status=success");
		expect(summary).toContain("pr=https://github.com/org/repo/pull/42");
		expect(summary).toContain("duration=120s");
		expect(summary).toContain("tokens=5000");
		expect(summary).toContain("output=Task completed successfully.");
	});

	it("includes error output for failed callbacks (PRD 15.11)", () => {
		const summary = buildResultSummary(
			createBasePayload({
				status: "failed",
				error: "OOM killed",
				task_output: "partial output",
			}),
		);
		expect(summary).toContain("error=OOM killed");
		expect(summary).toContain("output=partial output");
	});

	it("omits empty error string from summary", () => {
		const summary = buildResultSummary(createBasePayload({ error: "" }));
		expect(summary).not.toContain("error=");
	});
});

// ---------------------------------------------------------------------------
// buildTerminalEventMetadata
// ---------------------------------------------------------------------------

describe("buildTerminalEventMetadata", () => {
	it("includes core fields", () => {
		const meta = buildTerminalEventMetadata(createBasePayload());
		expect(meta.instanceId).toBe("inst_abc");
		expect(meta.callbackStatus).toBe("success");
		expect(meta.prUrl).toBe("https://github.com/org/repo/pull/42");
		expect(meta.durationSeconds).toBe(120);
		expect(meta.tokensUsed).toBe(5000);
	});

	it("includes error for failed callbacks", () => {
		const meta = buildTerminalEventMetadata(
			createBasePayload({
				status: "failed",
				error: "segfault",
			}),
		);
		expect(meta.error).toBe("segfault");
		expect(meta.callbackStatus).toBe("failed");
	});

	it("merges extra metadata", () => {
		const meta = buildTerminalEventMetadata(createBasePayload(), { dedupeKey: "key-1" });
		expect(meta.dedupeKey).toBe("key-1");
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — success callback (completed path)
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — success (completed path)", () => {
	it("reconciles a success callback for a running task", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.taskId).toBe("task-1");
		expect(result.terminalState).toBe("completing");
		expect(result.eventsAppended).toBeGreaterThanOrEqual(1);
		expect(result.executionUpdated).toBe(true);
	});

	it("appends terminal event to the event log", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const eventsBefore = ctx._state.events.length;
		await reconcileTerminalCallback(createAcceptedResult(), ctx);

		const newEvents = ctx._state.events.slice(eventsBefore);
		expect(newEvents.length).toBeGreaterThanOrEqual(1);

		const terminalEvent = newEvents[0];
		if (!terminalEvent) throw new Error("Expected terminal event");
		expect(terminalEvent.trigger).toBe("execution_done");
		expect(terminalEvent.fromState).toBe("running");
		expect(terminalEvent.toState).toBe("completing");
		expect(terminalEvent.triggerSource).toBe("callback");
		expect(terminalEvent.taskId).toBe("task-1");
	});

	it("uses eventId from ingestion result when available", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const eventsBefore = ctx._state.events.length;
		await reconcileTerminalCallback(createAcceptedResult({ eventId: "evt-custom" }), ctx);

		const newEvents = ctx._state.events.slice(eventsBefore);
		expect(newEvents[0]?.eventId).toBe("evt-custom");
	});

	it("generates eventId when not provided", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const eventsBefore = ctx._state.events.length;
		await reconcileTerminalCallback(createAcceptedResult({ eventId: null }), ctx);

		const newEvents = ctx._state.events.slice(eventsBefore);
		expect(newEvents[0]?.eventId).toBeTruthy();
		expect(newEvents[0]?.eventId).not.toBe("null");
	});

	it("updates task execution with terminal state and metadata", async () => {
		const execId = "exec-1";
		const ctx = createMockContext({
			taskState: "running",
			executions: [makeExecution({ executionId: execId })],
		});

		await reconcileTerminalCallback(createAcceptedResult(), ctx);

		const exec = ctx._state.executions.find((e) => e.executionId === execId);
		if (!exec) throw new Error("Expected execution");
		expect(exec.terminalState).toBe("completing");
		expect(exec.completedAt).toBe("2026-04-09T12:00:00Z");
		expect(exec.resultSummary).toContain("status=success");
		expect(exec.resultSummary).toContain("pr=https://github.com/org/repo/pull/42");
	});

	it("records callbackReceivedAt in remote metadata", async () => {
		const execId = "exec-1";
		const ctx = createMockContext({
			taskState: "running",
			executions: [makeExecution({ executionId: execId })],
		});

		await reconcileTerminalCallback(createAcceptedResult(), ctx);

		const exec = ctx._state.executions.find((e) => e.executionId === execId);
		if (!exec) throw new Error("Expected execution");
		expect(exec.remoteMetadata?.callbackReceivedAt).toBe("2026-04-09T12:00:00Z");
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — failed callback path
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — failed callback", () => {
	it("reconciles a failed callback for a running task", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({ status: "failed", error: "OOM killed" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.terminalState).toBe("failed");
		expect(result.teardownTriggered).toBe(true);
		expect(result.teardownState).toBe("teardown");
	});

	it("preserves error output in execution result summary (PRD 15.11)", async () => {
		const execId = "exec-fail";
		const ctx = createMockContext({
			taskState: "running",
			executions: [makeExecution({ executionId: execId })],
		});

		await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({
					status: "failed",
					error: "Segmentation fault at 0x00000001",
					task_output: "Partial output before crash",
				}),
			}),
			ctx,
		);

		const exec = ctx._state.executions.find((e) => e.executionId === execId);
		if (!exec) throw new Error("Expected execution");
		expect(exec.resultSummary).toContain("error=Segmentation fault at 0x00000001");
		expect(exec.resultSummary).toContain("output=Partial output before crash");
		expect(exec.terminalState).toBe("failed");
	});

	it("preserves error in event metadata (PRD 15.11)", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const eventsBefore = ctx._state.events.length;

		await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({ status: "failed", error: "stack overflow" }),
			}),
			ctx,
		);

		const newEvents = ctx._state.events.slice(eventsBefore);
		const terminalEvent = newEvents[0];
		if (!terminalEvent) throw new Error("Expected terminal event");
		expect((terminalEvent.metadata as Record<string, unknown>)?.error).toBe("stack overflow");
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — canceled callback path
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — canceled callback", () => {
	it("reconciles a canceled callback for a running task", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "user_cancel",
				toState: "canceled",
				payload: createBasePayload({ status: "canceled" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.terminalState).toBe("canceled");
		expect(result.teardownTriggered).toBe(true);
		expect(result.teardownState).toBe("teardown");
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — automatic teardown transition
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — auto teardown", () => {
	it("triggers teardown for completed terminal state", async () => {
		const ctx = createMockContext({ taskState: "running" });
		// execution_error -> failed is a terminal state that triggers auto_teardown
		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({ status: "failed" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.teardownTriggered).toBe(true);
		expect(result.teardownState).toBe("teardown");
		expect(result.eventsAppended).toBe(2); // terminal + teardown
	});

	it("appends auto_teardown event with correct metadata", async () => {
		const ctx = createMockContext({ taskState: "running" });
		const eventsBefore = ctx._state.events.length;

		await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({ status: "failed" }),
			}),
			ctx,
		);

		const newEvents = ctx._state.events.slice(eventsBefore);
		const teardownEvent = newEvents.find((e) => e.trigger === "auto_teardown");
		expect(teardownEvent).toBeDefined();
		expect(teardownEvent?.fromState).toBe("failed");
		expect(teardownEvent?.toState).toBe("teardown");
		expect(teardownEvent?.triggerSource).toBe("system");
		expect((teardownEvent?.metadata as Record<string, unknown>)?.autoTeardown).toBe(true);
		expect((teardownEvent?.metadata as Record<string, unknown>)?.triggeredByTerminalState).toBe("failed");
	});

	it("does not trigger teardown for non-terminal states (completing)", async () => {
		const ctx = createMockContext({ taskState: "running" });
		// execution_done -> completing is NOT a terminal state
		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		// completing is NOT terminal (completed/failed/canceled are), so no auto teardown
		expect(result.terminalState).toBe("completing");
		expect(result.teardownTriggered).toBe(false);
		expect(result.teardownState).toBeNull();
		expect(result.eventsAppended).toBe(1);
	});

	it("skips teardown for failed task with debug-preserve enabled", async () => {
		const ctx = createMockContext({
			taskState: "running",
			executions: [
				makeExecution({
					remoteMetadata: {
						instanceId: "inst_abc",
						repoUrl: "https://github.com/org/repo",
						baseBranch: "main",
						debugPreserve: true,
					},
				}),
			],
		});

		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({ status: "failed", error: "crash" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.terminalState).toBe("failed");
		expect(result.teardownTriggered).toBe(false);
		expect(result.teardownState).toBeNull();
		expect(result.eventsAppended).toBe(1); // only terminal event, no teardown
	});

	it("triggers teardown for canceled task even with debug-preserve", async () => {
		const ctx = createMockContext({
			taskState: "running",
			executions: [
				makeExecution({
					remoteMetadata: {
						instanceId: "inst_abc",
						repoUrl: "https://github.com/org/repo",
						baseBranch: "main",
						debugPreserve: true,
					},
				}),
			],
		});

		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "user_cancel",
				toState: "canceled",
				payload: createBasePayload({ status: "canceled" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.terminalState).toBe("canceled");
		expect(result.teardownTriggered).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — edge cases (idempotent / already-terminal)
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — already-terminal (idempotent no-op)", () => {
	it("returns idempotent no-op for task already in completed state", async () => {
		const ctx = createMockContext({ taskState: "running" });
		// Manually push events to get to completed
		ctx._state.events.push({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "execution_done",
			fromState: "running",
			toState: "completing",
			timestamp: "2026-04-09T11:00:00Z",
			triggerSource: "callback",
		});
		ctx._state.events.push({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "finalize_success",
			fromState: "completing",
			toState: "completed",
			timestamp: "2026-04-09T11:01:00Z",
			triggerSource: "system",
		});

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(true);
		expect(result.reason).toContain("already in state");
		expect(result.reason).toContain("completed");
	});

	it("returns idempotent no-op for task already in failed state", async () => {
		const ctx = createMockContext({ taskState: "running" });
		ctx._state.events.push({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "execution_error",
			fromState: "running",
			toState: "failed",
			timestamp: "2026-04-09T11:00:00Z",
			triggerSource: "callback",
		});

		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "execution_error",
				toState: "failed",
				payload: createBasePayload({ status: "failed" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(true);
	});

	it("returns idempotent no-op for task already in canceled state", async () => {
		const ctx = createMockContext({ taskState: "running" });
		ctx._state.events.push({
			eventId: randomUUID(),
			taskId: "task-1",
			trigger: "user_cancel",
			fromState: "running",
			toState: "canceled",
			timestamp: "2026-04-09T11:00:00Z",
			triggerSource: "user",
		});

		const result = await reconcileTerminalCallback(
			createAcceptedResult({
				trigger: "user_cancel",
				toState: "canceled",
				payload: createBasePayload({ status: "canceled" }),
			}),
			ctx,
		);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(true);
	});

	it("returns idempotent no-op for task already in teardown state", async () => {
		const ctx = createMockContext({ taskState: "running" });
		ctx._state.events.push(
			{
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "execution_error",
				fromState: "running",
				toState: "failed",
				timestamp: "2026-04-09T11:00:00Z",
				triggerSource: "callback",
			},
			{
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "auto_teardown",
				fromState: "failed",
				toState: "teardown",
				timestamp: "2026-04-09T11:01:00Z",
				triggerSource: "system",
			},
		);

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(true);
		expect(result.reason).toContain("teardown");
	});

	it("returns idempotent no-op for task in archived state", async () => {
		const ctx = createMockContext({ taskState: "running" });
		ctx._state.events.push(
			{
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "execution_error",
				fromState: "running",
				toState: "failed",
				timestamp: "2026-04-09T11:00:00Z",
				triggerSource: "callback",
			},
			{
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "auto_teardown",
				fromState: "failed",
				toState: "teardown",
				timestamp: "2026-04-09T11:01:00Z",
				triggerSource: "system",
			},
			{
				eventId: randomUUID(),
				taskId: "task-1",
				trigger: "sandbox_terminated",
				fromState: "teardown",
				toState: "archived",
				timestamp: "2026-04-09T11:02:00Z",
				triggerSource: "system",
			},
		);

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(true);
		expect(result.reason).toContain("archived");
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — trashed task rejection
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — trashed task", () => {
	it("rejects callback for a trashed task when board check is available", async () => {
		const ctx = createMockContext({
			taskState: "running",
			boardColumns: { "task-1": "trash" },
			withBoardCheck: true,
		});

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(false);
		expect(result.reason).toContain("trashed");
	});

	it("proceeds normally when board check is not available", async () => {
		const ctx = createMockContext({ taskState: "running" });
		// No getTaskBoardColumn provided (default)
		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);
		expect(result.reconciled).toBe(true);
	});

	it("proceeds when task is on board but not trashed", async () => {
		const ctx = createMockContext({
			taskState: "running",
			boardColumns: { "task-1": "in_progress" },
			withBoardCheck: true,
		});

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);
		expect(result.reconciled).toBe(true);
	});

	it("proceeds when task is unknown to board", async () => {
		const ctx = createMockContext({
			taskState: "running",
			boardColumns: {},
			withBoardCheck: true,
		});

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);
		expect(result.reconciled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — invalid transition
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — invalid transition", () => {
	it("rejects callback when transition is invalid from current state", async () => {
		// Task is in "provisioning" state, execution_done is not valid from there
		const ctx = createMockContext({ taskState: "provisioning" });
		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(false);
		if (result.reconciled) return;
		expect(result.idempotentNoOp).toBe(false);
		expect(result.reason).toContain("Invalid terminal transition");
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — no execution record
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — no execution record", () => {
	it("reconciles events but reports executionUpdated=false when no execution exists", async () => {
		const ctx = createMockContext({
			taskState: "running",
			executions: [],
		});

		const result = await reconcileTerminalCallback(createAcceptedResult(), ctx);

		expect(result.reconciled).toBe(true);
		if (!result.reconciled) return;
		expect(result.executionUpdated).toBe(false);
		expect(result.eventsAppended).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// reconcileTerminalCallback — execution metadata fields
// ---------------------------------------------------------------------------

describe("reconcileTerminalCallback — execution metadata", () => {
	it("records duration and token usage from callback", async () => {
		const execId = "exec-meta";
		const ctx = createMockContext({
			taskState: "running",
			executions: [makeExecution({ executionId: execId })],
		});

		await reconcileTerminalCallback(
			createAcceptedResult({
				payload: createBasePayload({
					duration_seconds: 300,
					tokens_used: 15000,
				}),
			}),
			ctx,
		);

		const exec = ctx._state.executions.find((e) => e.executionId === execId);
		if (!exec) throw new Error("Expected execution");
		expect(exec.resultSummary).toContain("duration=300s");
		expect(exec.resultSummary).toContain("tokens=15000");
	});

	it("sets instanceId on execution when not already set", async () => {
		const execId = "exec-no-inst";
		const ctx = createMockContext({
			taskState: "running",
			executions: [
				makeExecution({
					executionId: execId,
					instanceId: undefined,
					remoteMetadata: {
						instanceId: "inst_abc",
						repoUrl: "https://github.com/org/repo",
						baseBranch: "main",
					},
				}),
			],
		});

		await reconcileTerminalCallback(
			createAcceptedResult({
				instanceId: "inst_from_callback",
				payload: createBasePayload({ instanceId: "inst_from_callback" }),
			}),
			ctx,
		);

		const exec = ctx._state.executions.find((e) => e.executionId === execId);
		if (!exec) throw new Error("Expected execution");
		expect(exec.instanceId).toBe("inst_from_callback");
	});

	it("does not overwrite existing instanceId on execution", async () => {
		const execId = "exec-has-inst";
		const ctx = createMockContext({
			taskState: "running",
			executions: [makeExecution({ executionId: execId, instanceId: "original-inst" })],
		});

		await reconcileTerminalCallback(
			createAcceptedResult({
				instanceId: "different-inst",
				payload: createBasePayload({ instanceId: "different-inst" }),
			}),
			ctx,
		);

		const exec = ctx._state.executions.find((e) => e.executionId === execId);
		if (!exec) throw new Error("Expected execution");
		expect(exec.instanceId).toBe("original-inst");
	});
});
