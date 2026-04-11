import { describe, expect, it } from "vitest";
import { callbackPayloadSchema, callbackTerminalStatusSchema } from "../../../src/cloud/cloud-callback-ingestion";
import {
	CLOUD_EXECUTION_TRANSITIONS,
	cloudExecutionStateSchema,
	cloudExecutionTriggerSchema,
	validateCloudExecutionTransition,
} from "../../../src/cloud/cloud-execution-lifecycle";
import {
	cloudInstanceCreatedResponseSchema,
	cloudInstanceCreateRequestSchema,
	cloudInstanceStateSchema,
	cloudInstanceStatusResponseSchema,
} from "../../../src/cloud/cloud-instance-client";
import {
	getAllCloudInstanceStates,
	isInstanceFailed,
	isInstanceReady,
	mapCloudInstanceState,
} from "../../../src/cloud/cloud-instance-state-mapping";

// ===========================================================================
// Instance API request/response shape validation
// ===========================================================================

describe("Contract Tests \u2014 Instance API request shape", () => {
	it("valid create request passes schema", () => {
		const valid = {
			user_id: "user-123",
			repo_url: "https://github.com/cline/kanban",
			api_key: "sk-test-key",
			instance_type: "task-runner" as const,
			pr_base_branch: "main",
		};
		expect(cloudInstanceCreateRequestSchema.safeParse(valid).success).toBe(true);
	});

	it("rejects create request missing required fields", () => {
		expect(cloudInstanceCreateRequestSchema.safeParse({}).success).toBe(false);
		expect(cloudInstanceCreateRequestSchema.safeParse({ user_id: "u" }).success).toBe(false);
		expect(cloudInstanceCreateRequestSchema.safeParse({ user_id: "u", repo_url: "r" }).success).toBe(false);
	});

	it("rejects create request with empty strings", () => {
		const invalid = { user_id: "", repo_url: "r", api_key: "k", instance_type: "task-runner" };
		expect(cloudInstanceCreateRequestSchema.safeParse(invalid).success).toBe(false);
	});

	it("accepts optional github_pat as null", () => {
		const valid = {
			user_id: "u",
			repo_url: "r",
			api_key: "k",
			instance_type: "task-runner" as const,
			github_pat: null,
		};
		expect(cloudInstanceCreateRequestSchema.safeParse(valid).success).toBe(true);
	});
});

describe("Contract Tests \u2014 Instance API response shapes", () => {
	it("valid created response passes schema", () => {
		const valid = {
			instance_id: "inst-abc",
			user_id: "user-123",
			namespace: "ns-abc",
			hostname: "inst-abc.runner.test",
		};
		expect(cloudInstanceCreatedResponseSchema.safeParse(valid).success).toBe(true);
	});

	it("rejects created response missing fields", () => {
		expect(cloudInstanceCreatedResponseSchema.safeParse({}).success).toBe(false);
		expect(cloudInstanceCreatedResponseSchema.safeParse({ instance_id: "i" }).success).toBe(false);
	});

	it("valid status response passes schema for each instance state", () => {
		const states = cloudInstanceStateSchema.options;
		for (const state of states) {
			const valid = {
				instance_id: "inst-abc",
				user_id: "user-123",
				namespace: "ns-abc",
				state,
				hostname: "inst-abc.runner.test",
			};
			expect(cloudInstanceStatusResponseSchema.safeParse(valid).success).toBe(true);
		}
	});

	it("rejects status response with invalid state", () => {
		const invalid = {
			instance_id: "inst-abc",
			user_id: "user-123",
			namespace: "ns-abc",
			state: "unknown_state",
			hostname: "inst-abc.runner.test",
		};
		expect(cloudInstanceStatusResponseSchema.safeParse(invalid).success).toBe(false);
	});
});

// ===========================================================================
// Callback payload shape validation
// ===========================================================================

describe("Contract Tests \u2014 Callback payload shape", () => {
	it("valid callback payload passes schema", () => {
		const valid = {
			instanceId: "inst-abc",
			status: "success" as const,
			taskId: "task-123",
			attemptNumber: 1,
			prUrl: "https://github.com/cline/kanban/pull/42",
			taskOutput: "Completed successfully",
			durationSeconds: 120,
			tokensUsed: 5000,
		};
		expect(callbackPayloadSchema.safeParse(valid).success).toBe(true);
	});

	it("valid minimal callback payload", () => {
		const valid = { instanceId: "inst-abc", status: "failed" as const };
		expect(callbackPayloadSchema.safeParse(valid).success).toBe(true);
	});

	it("rejects callback without instanceId", () => {
		expect(callbackPayloadSchema.safeParse({ status: "success" }).success).toBe(false);
	});

	it("rejects callback without status", () => {
		expect(callbackPayloadSchema.safeParse({ instanceId: "i" }).success).toBe(false);
	});

	it("rejects callback with invalid status", () => {
		expect(callbackPayloadSchema.safeParse({ instanceId: "i", status: "running" }).success).toBe(false);
	});

	it("all terminal status values are valid", () => {
		for (const status of callbackTerminalStatusSchema.options) {
			expect(callbackPayloadSchema.safeParse({ instanceId: "i", status }).success).toBe(true);
		}
	});

	it("callback with error field passes", () => {
		const payload = { instanceId: "i", status: "failed" as const, error: "OOM killed" };
		expect(callbackPayloadSchema.safeParse(payload).success).toBe(true);
	});

	it("callback with idempotency_key passes", () => {
		const payload = { instanceId: "i", status: "success" as const, idempotencyKey: "idem-123" };
		expect(callbackPayloadSchema.safeParse(payload).success).toBe(true);
	});
});

// ===========================================================================
// State mapping consistency
// ===========================================================================

describe("Contract Tests \u2014 State mapping consistency", () => {
	it("every cloud instance state has a deterministic mapping", () => {
		const allStates = getAllCloudInstanceStates();
		for (const state of allStates) {
			const mapping = mapCloudInstanceState(state);
			expect(mapping.cloudState).toBe(state);
			expect(mapping.kanbanPhase).toBeDefined();
			expect(typeof mapping.isCloudTerminal).toBe("boolean");
		}
	});

	it("ready state maps to sandbox_ready trigger", () => {
		const mapping = mapCloudInstanceState("ready");
		expect(mapping.trigger).toBe("sandbox_ready");
		expect(mapping.isCloudTerminal).toBe(true);
		expect(isInstanceReady("ready")).toBe(true);
	});

	it("failed and unhealthy map to provision_timeout trigger", () => {
		for (const state of ["failed", "unhealthy"] as const) {
			const mapping = mapCloudInstanceState(state);
			expect(mapping.trigger).toBe("provision_timeout");
			expect(mapping.kanbanPhase).toBe("failed");
			expect(isInstanceFailed(state)).toBe(true);
		}
	});

	it("all lifecycle transitions are valid from->to pairs", () => {
		for (const edge of CLOUD_EXECUTION_TRANSITIONS) {
			const result = validateCloudExecutionTransition(edge.from, edge.trigger);
			expect(result.valid).toBe(true);
			if (result.valid) expect(result.to).toBe(edge.to);
		}
	});

	it("every cloud execution state is in the schema", () => {
		const allStates = cloudExecutionStateSchema.options;
		expect(allStates).toContain("draft");
		expect(allStates).toContain("queued");
		expect(allStates).toContain("running");
		expect(allStates).toContain("completed");
		expect(allStates).toContain("failed");
		expect(allStates).toContain("canceled");
		expect(allStates).toContain("teardown");
		expect(allStates).toContain("archived");
	});

	it("every trigger is in the schema", () => {
		const allTriggers = cloudExecutionTriggerSchema.options;
		expect(allTriggers).toContain("submit");
		expect(allTriggers).toContain("user_cancel");
		expect(allTriggers).toContain("auto_teardown");
		expect(allTriggers).toContain("sandbox_terminated");
	});
});
