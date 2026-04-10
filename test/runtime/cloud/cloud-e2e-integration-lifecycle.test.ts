import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import { deriveCurrentState, validateCloudExecutionTransition } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import type { CloudInstanceStatusResponse } from "../../../src/cloud/cloud-instance-client";
import { mapCloudInstanceState } from "../../../src/cloud/cloud-instance-state-mapping";

// ---------------------------------------------------------------------------
// In-memory lifecycle simulator
// ---------------------------------------------------------------------------

interface LifecycleState {
	events: PersistedTaskEvent[];
	executions: PersistedTaskExecution[];
	instances: Map<string, CloudInstanceStatusResponse>;
	deletedInstances: string[];
}

function createLifecycle(): LifecycleState {
	return { events: [], executions: [], instances: new Map(), deletedInstances: [] };
}

function appendTransition(
	lc: LifecycleState,
	taskId: string,
	trigger: CloudExecutionTrigger,
	from: CloudExecutionState,
	to: CloudExecutionState,
): void {
	lc.events.push({
		eventId: randomUUID(),
		taskId,
		trigger,
		fromState: from,
		toState: to,
		timestamp: new Date().toISOString(),
		triggerSource: "system",
	});
}

function currentState(lc: LifecycleState, taskId: string): CloudExecutionState {
	const taskEvents = lc.events.filter((e) => e.taskId === taskId);
	return deriveCurrentState(taskEvents);
}

// ===========================================================================
// Full happy-path lifecycle
// ===========================================================================

describe("Integration Lifecycle \u2014 Full happy path: create -> provision -> run -> callback -> teardown", () => {
	it("progresses through all states to archived", () => {
		const lc = createLifecycle();
		const taskId = "task-happy-1";

		// draft -> queued
		const t1 = validateCloudExecutionTransition("draft", "submit");
		expect(t1.valid).toBe(true);
		if (t1.valid) appendTransition(lc, taskId, t1.trigger, t1.from, t1.to);
		expect(currentState(lc, taskId)).toBe("queued");

		// queued -> policy_check
		const t2 = validateCloudExecutionTransition("queued", "dequeue");
		expect(t2.valid).toBe(true);
		if (t2.valid) appendTransition(lc, taskId, t2.trigger, t2.from, t2.to);
		expect(currentState(lc, taskId)).toBe("policy_check");

		// policy_check -> provisioning
		const t3 = validateCloudExecutionTransition("policy_check", "authorized");
		expect(t3.valid).toBe(true);
		if (t3.valid) appendTransition(lc, taskId, t3.trigger, t3.from, t3.to);
		expect(currentState(lc, taskId)).toBe("provisioning");

		// Simulate cloud instance becoming ready
		const mapping = mapCloudInstanceState("ready");
		expect(mapping.trigger).toBe("sandbox_ready");

		// provisioning -> running
		const t4 = validateCloudExecutionTransition("provisioning", "sandbox_ready");
		expect(t4.valid).toBe(true);
		if (t4.valid) appendTransition(lc, taskId, t4.trigger, t4.from, t4.to);
		expect(currentState(lc, taskId)).toBe("running");

		// running -> completing (callback success)
		const t5 = validateCloudExecutionTransition("running", "execution_done");
		expect(t5.valid).toBe(true);
		if (t5.valid) appendTransition(lc, taskId, t5.trigger, t5.from, t5.to);
		expect(currentState(lc, taskId)).toBe("completing");

		// completing -> completed
		const t6 = validateCloudExecutionTransition("completing", "finalize_success");
		expect(t6.valid).toBe(true);
		if (t6.valid) appendTransition(lc, taskId, t6.trigger, t6.from, t6.to);
		expect(currentState(lc, taskId)).toBe("completed");

		// completed -> teardown
		const t7 = validateCloudExecutionTransition("completed", "auto_teardown");
		expect(t7.valid).toBe(true);
		if (t7.valid) appendTransition(lc, taskId, t7.trigger, t7.from, t7.to);
		expect(currentState(lc, taskId)).toBe("teardown");

		// teardown -> archived
		const t8 = validateCloudExecutionTransition("teardown", "sandbox_terminated");
		expect(t8.valid).toBe(true);
		if (t8.valid) appendTransition(lc, taskId, t8.trigger, t8.from, t8.to);
		expect(currentState(lc, taskId)).toBe("archived");

		expect(lc.events).toHaveLength(8);
	});
});

// ===========================================================================
// Failed lifecycle: create -> provision -> timeout -> failed -> teardown
// ===========================================================================

describe("Integration Lifecycle \u2014 Failed: provision timeout", () => {
	it("provision timeout leads to failed then archived", () => {
		const lc = createLifecycle();
		const taskId = "task-fail-1";

		appendTransition(lc, taskId, "submit", "draft", "queued");
		appendTransition(lc, taskId, "dequeue", "queued", "policy_check");
		appendTransition(lc, taskId, "authorized", "policy_check", "provisioning");

		// provision_timeout -> failed
		const t = validateCloudExecutionTransition("provisioning", "provision_timeout");
		expect(t.valid).toBe(true);
		if (t.valid) appendTransition(lc, taskId, t.trigger, t.from, t.to);
		expect(currentState(lc, taskId)).toBe("failed");

		// failed -> teardown -> archived
		appendTransition(lc, taskId, "auto_teardown", "failed", "teardown");
		appendTransition(lc, taskId, "sandbox_terminated", "teardown", "archived");
		expect(currentState(lc, taskId)).toBe("archived");
	});

	it("execution error leads to failed then archived", () => {
		const lc = createLifecycle();
		const taskId = "task-exec-fail";

		appendTransition(lc, taskId, "submit", "draft", "queued");
		appendTransition(lc, taskId, "dequeue", "queued", "policy_check");
		appendTransition(lc, taskId, "authorized", "policy_check", "provisioning");
		appendTransition(lc, taskId, "sandbox_ready", "provisioning", "running");
		appendTransition(lc, taskId, "execution_error", "running", "failed");
		appendTransition(lc, taskId, "auto_teardown", "failed", "teardown");
		appendTransition(lc, taskId, "sandbox_terminated", "teardown", "archived");
		expect(currentState(lc, taskId)).toBe("archived");
	});
});

// ===========================================================================
// Cancel lifecycle: create -> provision -> run -> cancel -> teardown
// ===========================================================================

describe("Integration Lifecycle \u2014 Cancel: run -> cancel -> teardown", () => {
	it("cancel from running leads to canceled -> teardown -> archived", async () => {
		const lc = createLifecycle();
		const taskId = "task-cancel-lc";

		appendTransition(lc, taskId, "submit", "draft", "queued");
		appendTransition(lc, taskId, "dequeue", "queued", "policy_check");
		appendTransition(lc, taskId, "authorized", "policy_check", "provisioning");
		appendTransition(lc, taskId, "sandbox_ready", "provisioning", "running");
		expect(currentState(lc, taskId)).toBe("running");

		// Cancel
		appendTransition(lc, taskId, "user_cancel", "running", "canceled");
		expect(currentState(lc, taskId)).toBe("canceled");

		// Teardown
		appendTransition(lc, taskId, "auto_teardown", "canceled", "teardown");
		appendTransition(lc, taskId, "sandbox_terminated", "teardown", "archived");
		expect(currentState(lc, taskId)).toBe("archived");
	});
});

// ===========================================================================
// Retry lifecycle: failed -> retry -> run -> success -> teardown
// ===========================================================================

describe("Integration Lifecycle \u2014 Retry: failed -> retry -> success", () => {
	it("retry from failed creates new execution chain", () => {
		const lc = createLifecycle();
		const taskId = "task-retry-lc";

		// First attempt: fails
		appendTransition(lc, taskId, "submit", "draft", "queued");
		appendTransition(lc, taskId, "dequeue", "queued", "policy_check");
		appendTransition(lc, taskId, "authorized", "policy_check", "provisioning");
		appendTransition(lc, taskId, "sandbox_ready", "provisioning", "running");
		appendTransition(lc, taskId, "execution_error", "running", "failed");
		expect(currentState(lc, taskId)).toBe("failed");

		// Retry: re-submit (new lifecycle chain)
		// In practice, retry creates a new execution record, but the task events
		// continue from the current state. We simulate the retry by starting
		// a fresh event chain for the retry attempt.
		const retryTaskId = "task-retry-lc-attempt2";
		appendTransition(lc, retryTaskId, "submit", "draft", "queued");
		appendTransition(lc, retryTaskId, "dequeue", "queued", "policy_check");
		appendTransition(lc, retryTaskId, "authorized", "policy_check", "provisioning");
		appendTransition(lc, retryTaskId, "sandbox_ready", "provisioning", "running");
		appendTransition(lc, retryTaskId, "execution_done", "running", "completing");
		appendTransition(lc, retryTaskId, "finalize_success", "completing", "completed");
		appendTransition(lc, retryTaskId, "auto_teardown", "completed", "teardown");
		appendTransition(lc, retryTaskId, "sandbox_terminated", "teardown", "archived");

		expect(currentState(lc, taskId)).toBe("failed");
		expect(currentState(lc, retryTaskId)).toBe("archived");
	});
});
