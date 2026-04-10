import { describe, expect, it } from "vitest";

import {
	CLOUD_EXECUTION_TRANSITIONS,
	type CloudExecutionState,
	CloudExecutionTransitionError,
	type CloudExecutionTrigger,
	cloudExecutionStateSchema,
	cloudExecutionTriggerSchema,
	deriveCurrentState,
	getValidTriggers,
	isActiveSandboxState,
	isFinalState,
	isPreTerminalState,
	isTerminalState,
	validateCloudExecutionTransition,
} from "../../../src/cloud/cloud-execution-lifecycle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_STATES = cloudExecutionStateSchema.options as readonly CloudExecutionState[];
const ALL_TRIGGERS = cloudExecutionTriggerSchema.options as readonly CloudExecutionTrigger[];

// ---------------------------------------------------------------------------
// Schema completeness
// ---------------------------------------------------------------------------

describe("cloudExecutionStateSchema", () => {
	it("defines exactly 11 states", () => {
		expect(ALL_STATES).toHaveLength(11);
	});

	it("includes all PRD-specified states", () => {
		const expected: CloudExecutionState[] = [
			"draft",
			"queued",
			"policy_check",
			"provisioning",
			"running",
			"completing",
			"completed",
			"failed",
			"canceled",
			"teardown",
			"archived",
		];
		expect(ALL_STATES).toEqual(expected);
	});
});

describe("cloudExecutionTriggerSchema", () => {
	it("defines exactly 13 triggers", () => {
		expect(ALL_TRIGGERS).toHaveLength(13);
	});
});

// ---------------------------------------------------------------------------
// Transition table completeness
// ---------------------------------------------------------------------------

describe("CLOUD_EXECUTION_TRANSITIONS", () => {
	it("defines exactly 19 valid edges", () => {
		expect(CLOUD_EXECUTION_TRANSITIONS).toHaveLength(19);
	});

	it("contains no duplicate (from, trigger) pairs", () => {
		const keys = CLOUD_EXECUTION_TRANSITIONS.map((e) => `${e.from}::${e.trigger}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("only references valid states and triggers", () => {
		const stateSet = new Set<string>(ALL_STATES);
		const triggerSet = new Set<string>(ALL_TRIGGERS);
		for (const edge of CLOUD_EXECUTION_TRANSITIONS) {
			expect(stateSet.has(edge.from)).toBe(true);
			expect(stateSet.has(edge.to)).toBe(true);
			expect(triggerSet.has(edge.trigger)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Valid transitions — one test per edge
// ---------------------------------------------------------------------------

describe("validateCloudExecutionTransition — valid transitions", () => {
	const validCases: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["queued", "user_cancel", "canceled"],
		["policy_check", "authorized", "provisioning"],
		["policy_check", "denied", "failed"],
		["policy_check", "user_cancel", "canceled"],
		["provisioning", "sandbox_ready", "running"],
		["provisioning", "provision_timeout", "failed"],
		["provisioning", "user_cancel", "canceled"],
		["running", "execution_done", "completing"],
		["running", "execution_error", "failed"],
		["running", "user_cancel", "canceled"],
		["completing", "finalize_success", "completed"],
		["completing", "finalize_error", "failed"],
		["completing", "user_cancel", "canceled"],
		["completed", "auto_teardown", "teardown"],
		["failed", "auto_teardown", "teardown"],
		["canceled", "auto_teardown", "teardown"],
		["teardown", "sandbox_terminated", "archived"],
	];

	for (const [from, trigger, expectedTo] of validCases) {
		it(`${from} + ${trigger} -> ${expectedTo}`, () => {
			const result = validateCloudExecutionTransition(from, trigger);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.from).toBe(from);
				expect(result.to).toBe(expectedTo);
				expect(result.trigger).toBe(trigger);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("validateCloudExecutionTransition — invalid transitions", () => {
	const invalidCases: Array<[CloudExecutionState, CloudExecutionTrigger]> = [
		// draft only accepts "submit"
		["draft", "dequeue"],
		["draft", "authorized"],
		["draft", "sandbox_ready"],
		["draft", "execution_done"],
		["draft", "auto_teardown"],

		// queued only accepts "dequeue"
		["queued", "submit"],
		["queued", "authorized"],
		["queued", "auto_teardown"],

		// policy_check only accepts "authorized" or "denied"
		["policy_check", "submit"],
		["policy_check", "sandbox_ready"],
		["policy_check", "auto_teardown"],

		// provisioning only accepts "sandbox_ready" or "provision_timeout"
		["provisioning", "execution_done"],
		["provisioning", "auto_teardown"],
		["provisioning", "submit"],

		// running only accepts "execution_done", "execution_error", "user_cancel"
		["running", "submit"],
		["running", "sandbox_ready"],
		["running", "auto_teardown"],
		["running", "finalize_success"],

		// completing accepts "finalize_success", "finalize_error", or "user_cancel"
		["completing", "execution_done"],
		["completing", "auto_teardown"],

		// terminal states only accept "auto_teardown"
		["completed", "submit"],
		["completed", "sandbox_terminated"],
		["failed", "submit"],
		["failed", "sandbox_terminated"],
		["canceled", "submit"],
		["canceled", "sandbox_terminated"],

		// teardown only accepts "sandbox_terminated"
		["teardown", "auto_teardown"],
		["teardown", "submit"],

		// archived has no outgoing transitions
		["archived", "submit"],
		["archived", "auto_teardown"],
		["archived", "sandbox_terminated"],
	];

	for (const [from, trigger] of invalidCases) {
		it(`rejects ${from} + ${trigger}`, () => {
			const result = validateCloudExecutionTransition(from, trigger);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.from).toBe(from);
				expect(result.trigger).toBe(trigger);
				expect(result.reason).toBeTruthy();
			}
		});
	}

	it("rejects every trigger from archived with terminal-state message", () => {
		for (const trigger of ALL_TRIGGERS) {
			const result = validateCloudExecutionTransition("archived", trigger);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.reason).toContain("terminal state");
			}
		}
	});

	it("includes valid triggers in rejection message for non-terminal states", () => {
		const result = validateCloudExecutionTransition("running", "submit");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("execution_done");
			expect(result.reason).toContain("execution_error");
			expect(result.reason).toContain("user_cancel");
		}
	});
});

// ---------------------------------------------------------------------------
// State classification helpers
// ---------------------------------------------------------------------------

describe("isTerminalState", () => {
	it("returns true for completed, failed, canceled", () => {
		expect(isTerminalState("completed")).toBe(true);
		expect(isTerminalState("failed")).toBe(true);
		expect(isTerminalState("canceled")).toBe(true);
	});

	it("returns false for non-terminal states", () => {
		const nonTerminal: CloudExecutionState[] = [
			"draft",
			"queued",
			"policy_check",
			"provisioning",
			"running",
			"completing",
			"teardown",
			"archived",
		];
		for (const state of nonTerminal) {
			expect(isTerminalState(state)).toBe(false);
		}
	});
});

describe("isActiveSandboxState", () => {
	it("returns true for states with an active sandbox", () => {
		const active: CloudExecutionState[] = [
			"provisioning",
			"running",
			"completing",
			"completed",
			"failed",
			"canceled",
			"teardown",
		];
		for (const state of active) {
			expect(isActiveSandboxState(state)).toBe(true);
		}
	});

	it("returns false for states without an active sandbox", () => {
		expect(isActiveSandboxState("draft")).toBe(false);
		expect(isActiveSandboxState("queued")).toBe(false);
		expect(isActiveSandboxState("policy_check")).toBe(false);
		expect(isActiveSandboxState("archived")).toBe(false);
	});
});

describe("isFinalState", () => {
	it("returns true only for archived", () => {
		expect(isFinalState("archived")).toBe(true);
	});

	it("returns false for all other states", () => {
		for (const state of ALL_STATES) {
			if (state !== "archived") {
				expect(isFinalState(state)).toBe(false);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// getValidTriggers
// ---------------------------------------------------------------------------

describe("getValidTriggers", () => {
	it("returns [submit] for draft", () => {
		expect(getValidTriggers("draft")).toEqual(["submit"]);
	});

	it("returns [dequeue, user_cancel] for queued", () => {
		expect(getValidTriggers("queued")).toEqual(["dequeue", "user_cancel"]);
	});

	it("returns [authorized, denied, user_cancel] for policy_check", () => {
		expect(getValidTriggers("policy_check")).toEqual(["authorized", "denied", "user_cancel"]);
	});

	it("returns three triggers for running", () => {
		expect(getValidTriggers("running")).toEqual(["execution_done", "execution_error", "user_cancel"]);
	});

	it("returns [sandbox_ready, provision_timeout, user_cancel] for provisioning", () => {
		expect(getValidTriggers("provisioning")).toEqual(["provision_timeout", "sandbox_ready", "user_cancel"]);
	});

	it("returns [finalize_error, finalize_success, user_cancel] for completing", () => {
		expect(getValidTriggers("completing")).toEqual(["finalize_error", "finalize_success", "user_cancel"]);
	});

	it("returns [auto_teardown] for each terminal state", () => {
		expect(getValidTriggers("completed")).toEqual(["auto_teardown"]);
		expect(getValidTriggers("failed")).toEqual(["auto_teardown"]);
		expect(getValidTriggers("canceled")).toEqual(["auto_teardown"]);
	});

	it("returns empty array for archived", () => {
		expect(getValidTriggers("archived")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// deriveCurrentState
// ---------------------------------------------------------------------------

describe("deriveCurrentState", () => {
	it("returns draft for an empty event list", () => {
		expect(deriveCurrentState([])).toBe("draft");
	});

	it("returns the toState of the last event", () => {
		const events = [
			{ toState: "queued" as const },
			{ toState: "policy_check" as const },
			{ toState: "provisioning" as const },
		];
		expect(deriveCurrentState(events)).toBe("provisioning");
	});

	it("returns the toState of a single event", () => {
		expect(deriveCurrentState([{ toState: "queued" }])).toBe("queued");
	});
});

// ---------------------------------------------------------------------------
// CloudExecutionTransitionError
// ---------------------------------------------------------------------------

describe("CloudExecutionTransitionError", () => {
	it("captures from, trigger, and reason", () => {
		const result = validateCloudExecutionTransition("archived", "submit");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const error = new CloudExecutionTransitionError(result);
			expect(error.name).toBe("CloudExecutionTransitionError");
			expect(error.from).toBe("archived");
			expect(error.trigger).toBe("submit");
			expect(error.message).toBe(result.reason);
			expect(error).toBeInstanceOf(Error);
		}
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle path walkthroughs
// ---------------------------------------------------------------------------

describe("full lifecycle paths", () => {
	function walkPath(triggers: CloudExecutionTrigger[]): CloudExecutionState {
		let current: CloudExecutionState = "draft";
		for (const trigger of triggers) {
			const result = validateCloudExecutionTransition(current, trigger);
			if (!result.valid) {
				throw new Error(`Unexpected invalid transition: ${current} + ${trigger}: ${result.reason}`);
			}
			current = result.to;
		}
		return current;
	}

	it("happy path: draft -> ... -> archived", () => {
		const finalState = walkPath([
			"submit",
			"dequeue",
			"authorized",
			"sandbox_ready",
			"execution_done",
			"finalize_success",
			"auto_teardown",
			"sandbox_terminated",
		]);
		expect(finalState).toBe("archived");
	});

	it("policy denied path: draft -> ... -> archived", () => {
		const finalState = walkPath(["submit", "dequeue", "denied", "auto_teardown", "sandbox_terminated"]);
		expect(finalState).toBe("archived");
	});

	it("provision timeout path", () => {
		const finalState = walkPath([
			"submit",
			"dequeue",
			"authorized",
			"provision_timeout",
			"auto_teardown",
			"sandbox_terminated",
		]);
		expect(finalState).toBe("archived");
	});

	it("execution error path", () => {
		const finalState = walkPath([
			"submit",
			"dequeue",
			"authorized",
			"sandbox_ready",
			"execution_error",
			"auto_teardown",
			"sandbox_terminated",
		]);
		expect(finalState).toBe("archived");
	});

	it("user cancel path", () => {
		const finalState = walkPath([
			"submit",
			"dequeue",
			"authorized",
			"sandbox_ready",
			"user_cancel",
			"auto_teardown",
			"sandbox_terminated",
		]);
		expect(finalState).toBe("archived");
	});

	it("finalize error path", () => {
		const finalState = walkPath([
			"submit",
			"dequeue",
			"authorized",
			"sandbox_ready",
			"execution_done",
			"finalize_error",
			"auto_teardown",
			"sandbox_terminated",
		]);
		expect(finalState).toBe("archived");
	});
});

// ---------------------------------------------------------------------------
// PRD invariant: terminal states always reach teardown then archived
// ---------------------------------------------------------------------------

describe("terminal -> teardown -> archived invariant", () => {
	const terminalStates: CloudExecutionState[] = ["completed", "failed", "canceled"];

	for (const state of terminalStates) {
		it(`${state} -> teardown via auto_teardown`, () => {
			const result = validateCloudExecutionTransition(state, "auto_teardown");
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.to).toBe("teardown");
			}
		});
	}

	it("teardown -> archived via sandbox_terminated", () => {
		const result = validateCloudExecutionTransition("teardown", "sandbox_terminated");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.to).toBe("archived");
		}
	});

	it("terminal states have exactly one valid trigger (auto_teardown)", () => {
		for (const state of terminalStates) {
			const triggers = getValidTriggers(state);
			expect(triggers).toEqual(["auto_teardown"]);
		}
	});
});

// ---------------------------------------------------------------------------
// Exhaustive rejection: every (state, trigger) pair not in the table is invalid
// ---------------------------------------------------------------------------

describe("exhaustive invalid transition coverage", () => {
	const validSet = new Set(CLOUD_EXECUTION_TRANSITIONS.map((e) => `${e.from}::${e.trigger}`));

	it("rejects all (state, trigger) combinations not in the transition table", () => {
		let testedCount = 0;
		for (const state of ALL_STATES) {
			for (const trigger of ALL_TRIGGERS) {
				const key = `${state}::${trigger}`;
				if (validSet.has(key)) {
					continue;
				}
				const result = validateCloudExecutionTransition(state, trigger);
				expect(result.valid).toBe(false);
				testedCount += 1;
			}
		}
		// 11 states * 13 triggers = 143 total combinations
		// 19 valid edges -> 124 invalid combinations
		expect(testedCount).toBe(143 - 19);
	});
});

// ---------------------------------------------------------------------------
// isPreTerminalState
// ---------------------------------------------------------------------------

describe("isPreTerminalState", () => {
	it("returns true for queued, policy_check, provisioning, running, completing", () => {
		const preTerminal: CloudExecutionState[] = ["queued", "policy_check", "provisioning", "running", "completing"];
		for (const state of preTerminal) {
			expect(isPreTerminalState(state)).toBe(true);
		}
	});

	it("returns false for non-pre-terminal states", () => {
		const nonPreTerminal: CloudExecutionState[] = [
			"draft",
			"completed",
			"failed",
			"canceled",
			"teardown",
			"archived",
		];
		for (const state of nonPreTerminal) {
			expect(isPreTerminalState(state)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Cancel from every pre-terminal state (P2-1)
// ---------------------------------------------------------------------------

describe("user_cancel from every pre-terminal state", () => {
	const cancelableStates: CloudExecutionState[] = ["queued", "policy_check", "provisioning", "running", "completing"];

	for (const state of cancelableStates) {
		it(`${state} + user_cancel -> canceled`, () => {
			const result = validateCloudExecutionTransition(state, "user_cancel");
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.to).toBe("canceled");
			}
		});
	}

	it("canceled -> teardown -> archived after cancel", () => {
		const t1 = validateCloudExecutionTransition("canceled", "auto_teardown");
		expect(t1.valid).toBe(true);
		if (t1.valid) expect(t1.to).toBe("teardown");

		const t2 = validateCloudExecutionTransition("teardown", "sandbox_terminated");
		expect(t2.valid).toBe(true);
		if (t2.valid) expect(t2.to).toBe("archived");
	});

	it("user_cancel is not valid from terminal or post-terminal states", () => {
		const nonCancelable: CloudExecutionState[] = ["completed", "failed", "canceled", "teardown", "archived"];
		for (const state of nonCancelable) {
			const result = validateCloudExecutionTransition(state, "user_cancel");
			expect(result.valid).toBe(false);
		}
	});
});
