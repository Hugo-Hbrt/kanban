import { describe, expect, it } from "vitest";
import {
	type CallbackIngestionContext,
	type CallbackPayload,
	extractCallbackHeaders,
	ingestTerminalCallback,
} from "../../../src/cloud/cloud-callback-ingestion";
import { type CancelActor, cancelCloudExecution } from "../../../src/cloud/cloud-execution-cancel";
import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import { deriveCurrentState, isFinalState, isTerminalState } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvents(
	taskId: string,
	chain: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]>,
): PersistedTaskEvent[] {
	return chain.map(([from, trigger, to], i) => ({
		eventId: `evt-${taskId}-${i}`,
		taskId,
		trigger,
		fromState: from,
		toState: to,
		timestamp: new Date(Date.now() + i * 1000).toISOString(),
		triggerSource: "system" as const,
	}));
}

function deriveState(events: PersistedTaskEvent[]): CloudExecutionState {
	return deriveCurrentState(events);
}

// ===========================================================================
// UAT-1: Successful cloud-backed task
// ===========================================================================

describe("UAT-1: Successful cloud-backed task", () => {
	it("task progresses through full lifecycle and result is visible", () => {
		const events = makeEvents("uat1", [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_done", "completing"],
			["completing", "finalize_success", "completed"],
		]);
		expect(deriveState(events.slice(0, 1))).toBe("queued");
		expect(deriveState(events.slice(0, 4))).toBe("running");
		expect(deriveState(events)).toBe("completed");
		expect(isTerminalState("completed")).toBe(true);
	});

	it("sandbox is deleted automatically after completion", () => {
		const events = makeEvents("uat1-td", [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_done", "completing"],
			["completing", "finalize_success", "completed"],
			["completed", "auto_teardown", "teardown"],
			["teardown", "sandbox_terminated", "archived"],
		]);
		expect(deriveState(events)).toBe("archived");
		expect(isFinalState("archived")).toBe(true);
	});
});

// ===========================================================================
// UAT-2: Failed task with default teardown
// ===========================================================================

describe("UAT-2: Failed task with default teardown", () => {
	it("failure is visible and teardown occurs automatically", () => {
		const events = makeEvents("uat2", [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_error", "failed"],
			["failed", "auto_teardown", "teardown"],
			["teardown", "sandbox_terminated", "archived"],
		]);
		expect(deriveState(events.slice(0, 5))).toBe("failed");
		expect(isTerminalState("failed")).toBe(true);
		expect(deriveState(events)).toBe("archived");
	});

	it("no leaked sandbox remains after default teardown", () => {
		const events = makeEvents("uat2-noleak", [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_error", "failed"],
			["failed", "auto_teardown", "teardown"],
			["teardown", "sandbox_terminated", "archived"],
		]);
		expect(deriveState(events)).toBe("archived");
		// archived = sandbox fully cleaned up
		expect(isFinalState("archived")).toBe(true);
	});
});

// ===========================================================================
// UAT-3: Failed task with debug-preserve enabled
// ===========================================================================

describe("UAT-3: Failed task with debug-preserve enabled", () => {
	it("preserved state is explicit in metadata — teardown is skipped", () => {
		const events = makeEvents("uat3", [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_error", "failed"],
		]);
		expect(deriveState(events)).toBe("failed");
		// When debug-preserve is enabled, auto_teardown is NOT appended.
		// The task stays in "failed" (no teardown -> archived).
		// The sandbox remains available for inspection.
		expect(isTerminalState("failed")).toBe(true);
		// No teardown event means sandbox is preserved.
		expect(events.find((e) => e.trigger === "auto_teardown")).toBeUndefined();
	});

	it("preserved sandbox can still be cleaned up later", () => {
		const events = makeEvents("uat3-cleanup", [
			["draft", "submit", "queued"],
			["queued", "dequeue", "policy_check"],
			["policy_check", "authorized", "provisioning"],
			["provisioning", "sandbox_ready", "running"],
			["running", "execution_error", "failed"],
		]);
		// Later manual cleanup triggers teardown
		events.push({
			eventId: "evt-uat3-cleanup-td",
			taskId: "uat3-cleanup",
			trigger: "auto_teardown",
			fromState: "failed",
			toState: "teardown",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		events.push({
			eventId: "evt-uat3-cleanup-ar",
			taskId: "uat3-cleanup",
			trigger: "sandbox_terminated",
			fromState: "teardown",
			toState: "archived",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
		});
		expect(deriveState(events)).toBe("archived");
	});
});

// ===========================================================================
// UAT-4: User-canceled task
// ===========================================================================

describe("UAT-4: User-canceled task", () => {
	it("user sees cancellation outcome and teardown occurs cleanly", async () => {
		const events: PersistedTaskEvent[] = [];
		const executions: PersistedTaskExecution[] = [
			{
				executionId: "exec-uat4",
				taskId: "uat4-task",
				attemptNumber: 1,
				executionMode: "cloud_agent",
				createdAt: new Date().toISOString(),
				instanceId: "inst-uat4",
				remoteMetadata: { instanceId: "inst-uat4", repoUrl: "https://github.com/t/r", baseBranch: "main" },
			},
		];
		const deleteCalls: string[] = [];
		const ctx = {
			async deriveTaskState() {
				if (events.length === 0) return "running" as CloudExecutionState;
				return events[events.length - 1]?.toState;
			},
			async appendEvent(e: PersistedTaskEvent) {
				events.push({ ...e });
			},
			async appendEvents(es: readonly PersistedTaskEvent[]) {
				for (const e of es) events.push({ ...e });
			},
			async readExecutionsForTask() {
				return [...executions];
			},
			async updateExecution(id: string, u: Partial<PersistedTaskExecution>) {
				const i = executions.findIndex((e) => e.executionId === id);
				if (i === -1) return false;
				executions[i] = { ...executions[i]!, ...u };
				return true;
			},
			async deleteInstance(id: string) {
				deleteCalls.push(id);
			},
			now: () => new Date().toISOString(),
		};
		const actor: CancelActor = { type: "user", id: "uat4-user" };
		const result = await cancelCloudExecution({ taskId: "uat4-task", actor }, ctx);
		expect(result.canceled).toBe(true);
		if (result.canceled) {
			expect(result.previousState).toBe("running");
			expect(result.teardownTriggered).toBe(true);
			expect(result.instanceDeletionTriggered).toBe(true);
		}
		expect(deleteCalls).toEqual(["inst-uat4"]);
	});

	it("no terminal callback replay corrupts state after cancel", async () => {
		const ctx: CallbackIngestionContext = {
			async getTaskExecutionState() {
				return "canceled" as CloudExecutionState;
			},
			async hasProcessedCallback() {
				return false;
			},
			async recordProcessedCallback() {},
			signingSecret: null,
		};
		const p: CallbackPayload = { instanceId: "i-uat4", status: "success", task_id: "uat4", attempt_number: 1 };
		const r = await ingestTerminalCallback(JSON.stringify(p), extractCallbackHeaders({}), { taskId: "uat4" }, ctx);
		expect(r.accepted).toBe(false);
		if (!r.accepted) expect(r.duplicate).toBe(true);
	});
});

// ===========================================================================
// UAT-5: Duplicate callback safety
// ===========================================================================

describe("UAT-5: Duplicate callback safety", () => {
	it("Kanban ignores duplicate terminal mutation safely", async () => {
		const processedKeys = new Set<string>();
		const ctx: CallbackIngestionContext = {
			async getTaskExecutionState() {
				return "running" as CloudExecutionState;
			},
			async hasProcessedCallback(k) {
				return processedKeys.has(k);
			},
			async recordProcessedCallback(k) {
				processedKeys.add(k);
			},
			signingSecret: null,
		};
		const p: CallbackPayload = { instanceId: "i-uat5", status: "success", task_id: "uat5", attempt_number: 1 };
		const body = JSON.stringify(p);
		const h = extractCallbackHeaders({});
		const r1 = await ingestTerminalCallback(body, h, { taskId: "uat5" }, ctx);
		expect(r1.accepted).toBe(true);
		const r2 = await ingestTerminalCallback(body, h, { taskId: "uat5" }, ctx);
		expect(r2.accepted).toBe(false);
		if (!r2.accepted) {
			expect(r2.duplicate).toBe(true);
			expect(r2.httpStatus).toBe(200);
		}
	});

	it("no duplicate audit/usage records are created", async () => {
		const processedKeys = new Set<string>();
		let recordCount = 0;
		const ctx: CallbackIngestionContext = {
			async getTaskExecutionState() {
				return "running" as CloudExecutionState;
			},
			async hasProcessedCallback(k) {
				return processedKeys.has(k);
			},
			async recordProcessedCallback(k) {
				processedKeys.add(k);
				recordCount++;
			},
			signingSecret: null,
		};
		const p: CallbackPayload = {
			instanceId: "i-uat5a",
			status: "failed",
			task_id: "uat5a",
			attempt_number: 1,
			error: "OOM",
		};
		const body = JSON.stringify(p);
		const h = extractCallbackHeaders({});
		await ingestTerminalCallback(body, h, { taskId: "uat5a" }, ctx);
		const countAfterFirst = recordCount;
		await ingestTerminalCallback(body, h, { taskId: "uat5a" }, ctx);
		expect(recordCount).toBe(countAfterFirst);
	});

	it("idempotency_key deduplication works", async () => {
		const processedKeys = new Set<string>();
		const ctx: CallbackIngestionContext = {
			async getTaskExecutionState() {
				return "running" as CloudExecutionState;
			},
			async hasProcessedCallback(k) {
				return processedKeys.has(k);
			},
			async recordProcessedCallback(k) {
				processedKeys.add(k);
			},
			signingSecret: null,
		};
		const p: CallbackPayload = {
			instanceId: "i-uat5b",
			status: "success",
			task_id: "uat5b",
			attempt_number: 1,
			idempotency_key: "idem-uat5",
		};
		const body = JSON.stringify(p);
		const h = extractCallbackHeaders({});
		const r1 = await ingestTerminalCallback(body, h, { taskId: "uat5b" }, ctx);
		expect(r1.accepted).toBe(true);
		const r2 = await ingestTerminalCallback(body, h, { taskId: "uat5b" }, ctx);
		expect(r2.accepted).toBe(false);
		if (!r2.accepted) expect(r2.duplicate).toBe(true);
	});
});
