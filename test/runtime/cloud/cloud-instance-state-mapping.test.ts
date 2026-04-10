import { describe, expect, it } from "vitest";

import { type CloudInstanceState, cloudInstanceStateSchema } from "../../../src/cloud/cloud-instance-client";
import {
	getAllCloudInstanceStates,
	isInstanceFailed,
	isInstanceReady,
	mapCloudInstanceState,
} from "../../../src/cloud/cloud-instance-state-mapping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CLOUD_STATES = cloudInstanceStateSchema.options as readonly CloudInstanceState[];

// ---------------------------------------------------------------------------
// Coverage: every cloud state is mapped
// ---------------------------------------------------------------------------

describe("mapCloudInstanceState", () => {
	it("returns a mapping for every recognised cloud instance state", () => {
		for (const state of ALL_CLOUD_STATES) {
			const mapping = mapCloudInstanceState(state);
			expect(mapping.cloudState).toBe(state);
			expect(mapping.kanbanPhase).toBeTruthy();
		}
	});

	it("is deterministic — same input always produces same output", () => {
		for (const state of ALL_CLOUD_STATES) {
			const a = mapCloudInstanceState(state);
			const b = mapCloudInstanceState(state);
			expect(a).toEqual(b);
		}
	});
});

// ---------------------------------------------------------------------------
// PRD Section 4 mapping table
// ---------------------------------------------------------------------------

describe("PRD Section 4 mapping — provisioning states", () => {
	const provisioningStates: CloudInstanceState[] = ["requested", "creating", "provisioning", "starting"];

	for (const state of provisioningStates) {
		it(`${state} → kanbanPhase "provisioning", no trigger`, () => {
			const mapping = mapCloudInstanceState(state);
			expect(mapping.kanbanPhase).toBe("provisioning");
			expect(mapping.trigger).toBeNull();
			expect(mapping.isCloudTerminal).toBe(false);
		});
	}
});

describe("PRD Section 4 mapping — ready triggers transition", () => {
	it('ready → kanbanPhase "provisioning", trigger "sandbox_ready"', () => {
		const mapping = mapCloudInstanceState("ready");
		expect(mapping.kanbanPhase).toBe("provisioning");
		expect(mapping.trigger).toBe("sandbox_ready");
		expect(mapping.isCloudTerminal).toBe(true);
	});
});

describe("PRD Section 4 mapping — executing", () => {
	it('executing → kanbanPhase "running", no trigger', () => {
		const mapping = mapCloudInstanceState("executing");
		expect(mapping.kanbanPhase).toBe("running");
		expect(mapping.trigger).toBeNull();
		expect(mapping.isCloudTerminal).toBe(false);
	});
});

describe("PRD Section 4 mapping — teardown states", () => {
	const teardownStates: CloudInstanceState[] = ["stopping", "terminated"];

	for (const state of teardownStates) {
		it(`${state} → kanbanPhase "teardown"`, () => {
			const mapping = mapCloudInstanceState(state);
			expect(mapping.kanbanPhase).toBe("teardown");
			expect(mapping.isCloudTerminal).toBe(true);
		});
	}
});

describe("PRD Section 4 mapping — failure states", () => {
	const failureStates: CloudInstanceState[] = ["failed", "unhealthy"];

	for (const state of failureStates) {
		it(`${state} → kanbanPhase "failed", trigger "provision_timeout"`, () => {
			const mapping = mapCloudInstanceState(state);
			expect(mapping.kanbanPhase).toBe("failed");
			expect(mapping.trigger).toBe("provision_timeout");
			expect(mapping.isCloudTerminal).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// isInstanceReady / isInstanceFailed
// ---------------------------------------------------------------------------

describe("isInstanceReady", () => {
	it("returns true only for ready", () => {
		for (const state of ALL_CLOUD_STATES) {
			expect(isInstanceReady(state)).toBe(state === "ready");
		}
	});
});

describe("isInstanceFailed", () => {
	it("returns true for failed and unhealthy", () => {
		expect(isInstanceFailed("failed")).toBe(true);
		expect(isInstanceFailed("unhealthy")).toBe(true);
	});

	it("returns false for all other states", () => {
		for (const state of ALL_CLOUD_STATES) {
			if (state !== "failed" && state !== "unhealthy") {
				expect(isInstanceFailed(state)).toBe(false);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// getAllCloudInstanceStates
// ---------------------------------------------------------------------------

describe("getAllCloudInstanceStates", () => {
	it("returns every state from the schema", () => {
		expect(getAllCloudInstanceStates()).toEqual(ALL_CLOUD_STATES);
	});

	it("has at least 10 states (both current API + target values)", () => {
		expect(getAllCloudInstanceStates().length).toBeGreaterThanOrEqual(10);
	});
});
