// cloud-execution-detail-view.test.ts — P3-1 integration tests
import { describe, expect, it } from "vitest";

import type { CloudExecutionState } from "../../../src/cloud/cloud-execution-lifecycle";
import { deriveCurrentState } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";

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
			return deriveCurrentState(data.events.filter((e) => e.taskId === taskId));
		},
	};
}

let evtN = 0;
function makeEvent(o: Partial<PersistedTaskEvent> = {}): PersistedTaskEvent {
	evtN++;
	return {
		eventId: `evt-d${evtN}`,
		taskId: "task-p3",
		trigger: "submit",
		fromState: "draft",
		toState: "queued",
		timestamp: `2026-04-09T0${evtN < 10 ? evtN : 9}:00:00Z`,
		triggerSource: "user",
		...o,
	};
}
function makeExec(o: Partial<PersistedTaskExecution> = {}): PersistedTaskExecution {
	return {
		executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
		taskId: "task-p3",
		attemptNumber: 1,
		executionMode: "cloud_agent",
		createdAt: "2026-04-09T00:00:00Z",
		...o,
	};
}

async function callTimeline(store: ReturnType<typeof createMockStore>, taskId: string) {
	const { queryExecutionTimeline } = await import("../../../src/cloud/cloud-execution-timeline");
	const tl = await queryExecutionTimeline(store, taskId);
	const found = tl.totalEntries > 0;
	return { found, timeline: found ? tl : null };
}
async function callSummary(store: ReturnType<typeof createMockStore>, taskId: string) {
	const { buildExecutionSummary } = await import("../../../src/cloud/cloud-execution-timeline");
	const s = await buildExecutionSummary(store, taskId);
	return { found: s !== null, summary: s };
}

describe("getCloudExecutionTimeline — no data", () => {
	it("returns found=false when no events", async () => {
		const r = await callTimeline(createMockStore(), "task-p3");
		expect(r.found).toBe(false);
		expect(r.timeline).toBeNull();
	});
});

describe("getCloudExecutionTimeline — with events", () => {
	it("returns found=true and populated timeline", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "e1", timestamp: "2026-04-09T00:01:00Z" }),
				makeEvent({
					eventId: "e2",
					trigger: "dequeue",
					fromState: "queued",
					toState: "policy_check",
					timestamp: "2026-04-09T00:02:00Z",
				}),
			],
			executions: [makeExec({ createdAt: "2026-04-09T00:00:00Z" })],
		});
		const r = await callTimeline(store, "task-p3");
		expect(r.found).toBe(true);
		expect(r.timeline?.totalEntries).toBe(2);
	});

	it("timeline entries ordered by timestamp ascending", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "late", timestamp: "2026-04-09T01:00:00Z" }),
				makeEvent({ eventId: "early", timestamp: "2026-04-09T00:00:01Z" }),
			],
			executions: [],
		});
		const r = await callTimeline(store, "task-p3");
		expect(r.timeline?.entries.map((e) => e.eventId)).toEqual(["early", "late"]);
	});

	it("classifies cancel events", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1", trigger: "user_cancel", fromState: "running", toState: "canceled" })],
			executions: [],
		});
		const r = await callTimeline(store, "task-p3");
		expect(r.timeline?.entries[0]?.category).toBe("cancel");
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
					metadata: { reconcilerAction: "stale_recovery", reason: "Stale task timeout" },
				}),
			],
			executions: [],
		});
		const r = await callTimeline(store, "task-p3");
		expect(r.timeline?.entries[0]?.category).toBe("reconciler");
		expect(r.timeline?.entries[0]?.summary).toContain("Stale task timeout");
	});

	it("does not expose board column fields", async () => {
		const store = createMockStore({ events: [makeEvent({ eventId: "e1" })], executions: [] });
		const r = await callTimeline(store, "task-p3");
		const keys = Object.keys(r.timeline?.entries[0] ?? {});
		expect(keys).not.toContain("column");
		expect(keys).not.toContain("prompt");
	});
});

describe("getCloudExecutionSummary — no data", () => {
	it("returns found=false when no history", async () => {
		const r = await callSummary(createMockStore(), "task-p3");
		expect(r.found).toBe(false);
		expect(r.summary).toBeNull();
	});
});

describe("getCloudExecutionSummary — with data", () => {
	it("returns summary with correct aggregates", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExec({ trigger: "initial", durationSeconds: 45, tokenUsage: 1000 })],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.found).toBe(true);
		expect(r.summary?.totalAttempts).toBe(1);
		expect(r.summary?.totalDurationSeconds).toBe(45);
		expect(r.summary?.totalTokenUsage).toBe(1000);
	});

	it("derives current state from events", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "s1", trigger: "submit", fromState: "draft", toState: "queued" }),
				makeEvent({ eventId: "s2", trigger: "sandbox_ready", fromState: "provisioning", toState: "running" }),
			],
			executions: [makeExec()],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.summary?.currentState).toBe("running");
	});

	it("detects retry flag", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExec({ attemptNumber: 1, trigger: "initial", terminalState: "failed" }),
				makeExec({ attemptNumber: 2, trigger: "retry" }),
			],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.summary?.hasBeenRetried).toBe(true);
		expect(r.summary?.totalAttempts).toBe(2);
	});

	it("detects replay flag", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExec({ attemptNumber: 1, trigger: "initial", terminalState: "failed" }),
				makeExec({ attemptNumber: 2, trigger: "replay" }),
			],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.summary?.hasBeenReplayed).toBe(true);
	});

	it("includes outcome pattern", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [
				makeExec({ attemptNumber: 1, terminalState: "failed" }),
				makeExec({ attemptNumber: 2, terminalState: "completed" }),
			],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.summary?.outcomePattern).toEqual(["failed", "completed"]);
	});

	it("includes time in states", async () => {
		const store = createMockStore({
			events: [
				makeEvent({ eventId: "t1", toState: "queued", timestamp: "2026-04-09T00:00:00Z" }),
				makeEvent({ eventId: "t2", toState: "policy_check", timestamp: "2026-04-09T00:00:10Z" }),
				makeEvent({ eventId: "t3", toState: "provisioning", timestamp: "2026-04-09T00:00:30Z" }),
			],
			executions: [makeExec()],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.summary?.timeInStates.queued).toBe(10);
		expect(r.summary?.timeInStates.policy_check).toBe(20);
	});

	it("surfaces debug-preserve teardown decision", async () => {
		const store = createMockStore({
			events: [makeEvent({ eventId: "e1" })],
			executions: [makeExec({ teardownDecision: "debug-preserve" })],
		});
		const r = await callSummary(store, "task-p3");
		expect(r.summary?.teardownDecision).toBe("debug-preserve");
	});

	it("does not expose board column semantics", async () => {
		const store = createMockStore({ events: [makeEvent({ eventId: "e1" })], executions: [makeExec()] });
		const r = await callSummary(store, "task-p3");
		const keys = Object.keys(r.summary ?? {});
		expect(keys).not.toContain("column");
		expect(keys).not.toContain("columnId");
		expect(keys).not.toContain("prompt");
	});
});
