import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ConcurrencyStoreInterface, OrgResolver } from "../../../src/cloud/cloud-concurrency-limiter";
import {
	CLOUD_MAX_CONCURRENT_ENV,
	CONCURRENCY_OCCUPYING_STATES,
	DEFAULT_CONCURRENCY_CONFIG,
	DEFAULT_MAX_CONCURRENT_PER_ORG,
	OrgConcurrencyLimiter,
	parseConcurrencyConfig,
} from "../../../src/cloud/cloud-concurrency-limiter";
import type { CloudExecutionState, CloudExecutionTrigger } from "../../../src/cloud/cloud-execution-lifecycle";
import type { PersistedTaskEvent } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockStore(): ConcurrencyStoreInterface & { _events: PersistedTaskEvent[] } {
	const events: PersistedTaskEvent[] = [];
	return {
		async readEvents() {
			return [...events];
		},
		_events: events,
	};
}

/** Seed a task through lifecycle states up to (and including) the target state. */
function seedTaskToState(
	store: { _events: PersistedTaskEvent[] },
	taskId: string,
	targetState: CloudExecutionState,
	timestamp?: string,
): void {
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState]> = [
		["draft", "submit", "queued"],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running"],
		["running", "execution_done", "completing"],
		["completing", "finalize_success", "completed"],
	];

	const ts = timestamp ?? "2026-01-01T00:00:00Z";
	let counter = 0;
	for (const [from, trigger, to] of transitions) {
		if (targetState === from) break;
		counter++;
		store._events.push({
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: from,
			toState: to,
			timestamp: `${ts.slice(0, -1)}.${String(counter).padStart(3, "0")}Z`,
			triggerSource: "system",
		});
		if (targetState === to) break;
	}
}

/** Seed a task to a terminal state (failed/canceled). */
function seedTaskToTerminal(
	store: { _events: PersistedTaskEvent[] },
	taskId: string,
	terminalState: "failed" | "canceled",
	timestamp?: string,
): void {
	seedTaskToState(store, taskId, "running", timestamp);
	const ts = timestamp ?? "2026-01-01T00:00:00Z";
	const trigger = terminalState === "failed" ? "execution_error" : "user_cancel";
	store._events.push({
		eventId: randomUUID(),
		taskId,
		trigger,
		fromState: "running",
		toState: terminalState,
		timestamp: `${ts.slice(0, -1)}.999Z`,
		triggerSource: "system",
	});
}

function createOrgResolver(mapping: Record<string, string>): OrgResolver {
	return (taskId) => mapping[taskId];
}

// ===========================================================================
// Tests: Constants and Configuration
// ===========================================================================

describe("Constants", () => {
	it("default max concurrent per org is 5", () => {
		expect(DEFAULT_MAX_CONCURRENT_PER_ORG).toBe(5);
	});

	it("CONCURRENCY_OCCUPYING_STATES includes expected states", () => {
		expect(CONCURRENCY_OCCUPYING_STATES.has("policy_check")).toBe(true);
		expect(CONCURRENCY_OCCUPYING_STATES.has("provisioning")).toBe(true);
		expect(CONCURRENCY_OCCUPYING_STATES.has("running")).toBe(true);
		expect(CONCURRENCY_OCCUPYING_STATES.has("completing")).toBe(true);
	});

	it("CONCURRENCY_OCCUPYING_STATES excludes non-active states", () => {
		expect(CONCURRENCY_OCCUPYING_STATES.has("draft")).toBe(false);
		expect(CONCURRENCY_OCCUPYING_STATES.has("queued")).toBe(false);
		expect(CONCURRENCY_OCCUPYING_STATES.has("completed")).toBe(false);
		expect(CONCURRENCY_OCCUPYING_STATES.has("failed")).toBe(false);
		expect(CONCURRENCY_OCCUPYING_STATES.has("canceled")).toBe(false);
		expect(CONCURRENCY_OCCUPYING_STATES.has("teardown")).toBe(false);
		expect(CONCURRENCY_OCCUPYING_STATES.has("archived")).toBe(false);
	});
});

describe("parseConcurrencyConfig", () => {
	it("returns default when env is empty", () => {
		const cfg = parseConcurrencyConfig({});
		expect(cfg.maxConcurrentPerOrg).toBe(DEFAULT_MAX_CONCURRENT_PER_ORG);
	});

	it("reads from environment variable", () => {
		const cfg = parseConcurrencyConfig({ [CLOUD_MAX_CONCURRENT_ENV]: "10" });
		expect(cfg.maxConcurrentPerOrg).toBe(10);
	});

	it("ignores invalid env values", () => {
		expect(parseConcurrencyConfig({ [CLOUD_MAX_CONCURRENT_ENV]: "abc" }).maxConcurrentPerOrg).toBe(5);
		expect(parseConcurrencyConfig({ [CLOUD_MAX_CONCURRENT_ENV]: "0" }).maxConcurrentPerOrg).toBe(5);
		expect(parseConcurrencyConfig({ [CLOUD_MAX_CONCURRENT_ENV]: "-1" }).maxConcurrentPerOrg).toBe(5);
	});

	it("overrides take precedence over env", () => {
		const cfg = parseConcurrencyConfig({ [CLOUD_MAX_CONCURRENT_ENV]: "10" }, { maxConcurrentPerOrg: 3 });
		expect(cfg.maxConcurrentPerOrg).toBe(3);
	});

	it("DEFAULT_CONCURRENCY_CONFIG matches default", () => {
		expect(DEFAULT_CONCURRENCY_CONFIG.maxConcurrentPerOrg).toBe(5);
	});
});

// ===========================================================================
// Tests: Admission Control — Limit Enforcement
// ===========================================================================

describe("OrgConcurrencyLimiter — limit enforcement", () => {
	it("admits task when org has no active tasks", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ "task-1": "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 2 });

		seedTaskToState(store, "task-1", "queued");

		const decision = await limiter.checkAdmission("task-1");
		expect(decision.admitted).toBe(true);
		expect(decision.orgId).toBe("org-A");
		expect(decision.activeCount).toBe(0);
		expect(decision.queuePosition).toBe(0);
	});

	it("admits task when org is under limit", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ "task-1": "org-A", "task-2": "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 2 });

		seedTaskToState(store, "task-1", "running"); // occupies 1 slot
		seedTaskToState(store, "task-2", "queued");

		const decision = await limiter.checkAdmission("task-2");
		expect(decision.admitted).toBe(true);
		expect(decision.activeCount).toBe(1);
	});

	it("rejects task when org is at limit", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			"task-1": "org-A",
			"task-2": "org-A",
			"task-3": "org-A",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 2 });

		seedTaskToState(store, "task-1", "running");
		seedTaskToState(store, "task-2", "provisioning");
		seedTaskToState(store, "task-3", "queued");

		const decision = await limiter.checkAdmission("task-3");
		expect(decision.admitted).toBe(false);
		expect(decision.activeCount).toBe(2);
		expect(decision.limit).toBe(2);
		expect(decision.queuePosition).toBe(1);
		expect(decision.reason).toContain("concurrency limit");
	});

	it("counts all occupying states toward limit", async () => {
		const store = createMockStore();
		const mapping: Record<string, string> = {};
		for (let i = 1; i <= 6; i++) mapping[`task-${i}`] = "org-A";
		const resolver = createOrgResolver(mapping);
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 5 });

		seedTaskToState(store, "task-1", "policy_check");
		seedTaskToState(store, "task-2", "provisioning");
		seedTaskToState(store, "task-3", "running");
		seedTaskToState(store, "task-4", "completing");
		seedTaskToState(store, "task-5", "running");
		seedTaskToState(store, "task-6", "queued");

		const decision = await limiter.checkAdmission("task-6");
		expect(decision.admitted).toBe(false);
		expect(decision.activeCount).toBe(5);
	});

	it("does not count terminal states toward limit", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			"task-1": "org-A",
			"task-2": "org-A",
			"task-3": "org-A",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-1", "completed");
		seedTaskToTerminal(store, "task-2", "failed");
		seedTaskToState(store, "task-3", "queued");

		const decision = await limiter.checkAdmission("task-3");
		expect(decision.admitted).toBe(true);
		expect(decision.activeCount).toBe(0);
	});

	it("admits task with no org context (gating skipped)", async () => {
		const store = createMockStore();
		const resolver: OrgResolver = () => undefined;
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-1", "queued");

		const decision = await limiter.checkAdmission("task-1");
		expect(decision.admitted).toBe(true);
		expect(decision.orgId).toBe("");
		expect(decision.reason).toContain("No org context");
	});

	it("isolates concurrency between different orgs", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			"task-A1": "org-A",
			"task-A2": "org-A",
			"task-B1": "org-B",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-A1", "running"); // org-A at limit
		seedTaskToState(store, "task-A2", "queued");
		seedTaskToState(store, "task-B1", "queued");

		const decisionA = await limiter.checkAdmission("task-A2");
		expect(decisionA.admitted).toBe(false);

		const decisionB = await limiter.checkAdmission("task-B1");
		expect(decisionB.admitted).toBe(true);
	});
});

// ===========================================================================
// Tests: FIFO Queuing
// ===========================================================================

describe("OrgConcurrencyLimiter — FIFO queuing", () => {
	it("admits earliest queued task first when under limit", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			"task-early": "org-A",
			"task-late": "org-A",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		// task-early submitted first
		seedTaskToState(store, "task-early", "queued", "2026-01-01T00:01:00Z");
		seedTaskToState(store, "task-late", "queued", "2026-01-01T00:02:00Z");

		// task-early should be admitted
		const d1 = await limiter.checkAdmission("task-early");
		expect(d1.admitted).toBe(true);

		// task-late should be held (FIFO: early goes first)
		const d2 = await limiter.checkAdmission("task-late");
		expect(d2.admitted).toBe(false);
		expect(d2.reason).toContain("FIFO");
	});

	it("queue position reflects FIFO order", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			"task-active": "org-A",
			"task-q1": "org-A",
			"task-q2": "org-A",
			"task-q3": "org-A",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-active", "running");
		seedTaskToState(store, "task-q1", "queued", "2026-01-01T00:01:00Z");
		seedTaskToState(store, "task-q2", "queued", "2026-01-01T00:02:00Z");
		seedTaskToState(store, "task-q3", "queued", "2026-01-01T00:03:00Z");

		const d1 = await limiter.checkAdmission("task-q1");
		expect(d1.queuePosition).toBe(1);

		const d2 = await limiter.checkAdmission("task-q2");
		expect(d2.queuePosition).toBe(2);

		const d3 = await limiter.checkAdmission("task-q3");
		expect(d3.queuePosition).toBe(3);
	});
});

// ===========================================================================
// Tests: Slot Release (completion/failure/cancel frees a slot)
// ===========================================================================

describe("OrgConcurrencyLimiter — slot release", () => {
	it("admits next task after active task completes", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ "task-done": "org-A", "task-w": "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-done", "running");
		seedTaskToState(store, "task-w", "queued");

		let d = await limiter.checkAdmission("task-w");
		expect(d.admitted).toBe(false);

		// Simulate completion
		store._events.push({
			eventId: randomUUID(),
			taskId: "task-done",
			trigger: "execution_done",
			fromState: "running",
			toState: "completing",
			timestamp: "2026-01-01T01:00:00Z",
			triggerSource: "callback",
		});
		store._events.push({
			eventId: randomUUID(),
			taskId: "task-done",
			trigger: "finalize_success",
			fromState: "completing",
			toState: "completed",
			timestamp: "2026-01-01T01:00:01Z",
			triggerSource: "system",
		});

		d = await limiter.checkAdmission("task-w");
		expect(d.admitted).toBe(true);
		expect(d.activeCount).toBe(0);
	});

	it("admits next task after active task fails", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ "task-f": "org-A", "task-w": "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-f", "running");
		seedTaskToState(store, "task-w", "queued");

		store._events.push({
			eventId: randomUUID(),
			taskId: "task-f",
			trigger: "execution_error",
			fromState: "running",
			toState: "failed",
			timestamp: "2026-01-01T01:00:00Z",
			triggerSource: "system",
		});

		const d = await limiter.checkAdmission("task-w");
		expect(d.admitted).toBe(true);
	});

	it("admits next task after active task is canceled", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ "task-c": "org-A", "task-w": "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "task-c", "running");
		seedTaskToState(store, "task-w", "queued");

		store._events.push({
			eventId: randomUUID(),
			taskId: "task-c",
			trigger: "user_cancel",
			fromState: "running",
			toState: "canceled",
			timestamp: "2026-01-01T01:00:00Z",
			triggerSource: "user",
		});

		const d = await limiter.checkAdmission("task-w");
		expect(d.admitted).toBe(true);
	});
});

// ===========================================================================
// Tests: getOrgStatus & getNextDispatchableTasksForOrg
// ===========================================================================

describe("OrgConcurrencyLimiter — getOrgStatus", () => {
	it("returns correct status for an org", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			t1: "org-A",
			t2: "org-A",
			t3: "org-A",
			t4: "org-A",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 3 });

		seedTaskToState(store, "t1", "running");
		seedTaskToState(store, "t2", "provisioning");
		seedTaskToState(store, "t3", "queued", "2026-01-01T00:01:00Z");
		seedTaskToState(store, "t4", "queued", "2026-01-01T00:02:00Z");

		const s = await limiter.getOrgStatus("org-A");
		expect(s.activeCount).toBe(2);
		expect(s.limit).toBe(3);
		expect(s.queuedCount).toBe(2);
		expect(s.availableSlots).toBe(1);
	});

	it("returns zero counts for empty org", async () => {
		const store = createMockStore();
		const limiter = new OrgConcurrencyLimiter(store, () => undefined);
		const s = await limiter.getOrgStatus("org-empty");
		expect(s.activeCount).toBe(0);
		expect(s.queuedCount).toBe(0);
		expect(s.availableSlots).toBe(DEFAULT_MAX_CONCURRENT_PER_ORG);
	});
});

describe("OrgConcurrencyLimiter — getNextDispatchableTasksForOrg", () => {
	it("returns eligible tasks in FIFO order up to available slots", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({
			t1: "org-A",
			t2: "org-A",
			t3: "org-A",
			t4: "org-A",
		});
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 3 });

		seedTaskToState(store, "t1", "running"); // 1 active
		seedTaskToState(store, "t2", "queued", "2026-01-01T00:01:00Z");
		seedTaskToState(store, "t3", "queued", "2026-01-01T00:02:00Z");
		seedTaskToState(store, "t4", "queued", "2026-01-01T00:03:00Z");

		const tasks = await limiter.getNextDispatchableTasksForOrg("org-A");
		expect(tasks).toEqual(["t2", "t3"]); // 2 available slots
	});

	it("returns empty when at limit", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ t1: "org-A", t2: "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "t1", "running");
		seedTaskToState(store, "t2", "queued");

		const tasks = await limiter.getNextDispatchableTasksForOrg("org-A");
		expect(tasks).toEqual([]);
	});
});

// ===========================================================================
// Tests: Edge Cases
// ===========================================================================

describe("OrgConcurrencyLimiter — edge cases", () => {
	it("handles limit of 1 (serialized execution)", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ t1: "org-A", t2: "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 1 });

		seedTaskToState(store, "t1", "policy_check");
		seedTaskToState(store, "t2", "queued");

		const d = await limiter.checkAdmission("t2");
		expect(d.admitted).toBe(false);
		expect(d.activeCount).toBe(1);
	});

	it("getConfig returns a copy of the config", () => {
		const store = createMockStore();
		const limiter = new OrgConcurrencyLimiter(store, () => "org-A", { maxConcurrentPerOrg: 7 });
		const cfg = limiter.getConfig();
		expect(cfg.maxConcurrentPerOrg).toBe(7);
	});

	it("graceful adjustment when limit changes", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ t1: "org-A", t2: "org-A", t3: "org-A" });

		seedTaskToState(store, "t1", "running");
		seedTaskToState(store, "t2", "running");
		seedTaskToState(store, "t3", "queued");

		// limit=3: task-3 admitted
		let d = await new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 3 }).checkAdmission("t3");
		expect(d.admitted).toBe(true);

		// limit=2: task-3 blocked
		d = await new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 2 }).checkAdmission("t3");
		expect(d.admitted).toBe(false);

		// limit=5: task-3 admitted
		d = await new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 5 }).checkAdmission("t3");
		expect(d.admitted).toBe(true);
	});

	it("single queued task with no competition is admitted", async () => {
		const store = createMockStore();
		const resolver = createOrgResolver({ t1: "org-A" });
		const limiter = new OrgConcurrencyLimiter(store, resolver, { maxConcurrentPerOrg: 5 });
		seedTaskToState(store, "t1", "queued");
		const d = await limiter.checkAdmission("t1");
		expect(d.admitted).toBe(true);
	});

	it("uses default config when none provided", async () => {
		const store = createMockStore();
		const limiter = new OrgConcurrencyLimiter(store, () => "org-A");
		const cfg = limiter.getConfig();
		expect(cfg.maxConcurrentPerOrg).toBe(DEFAULT_MAX_CONCURRENT_PER_ORG);
	});
});

// ===========================================================================
// Tests: Orchestrator Integration (concurrency gate in handleQueued)
// ===========================================================================

describe("Orchestrator integration — concurrency gate in handleQueued", () => {
	// Use a lightweight inline import to avoid polluting the limiter test
	// file with the full orchestrator mock setup, but still verify wiring.

	it("orchestrator constructor accepts concurrencyLimiter as 6th arg", async () => {
		// This is a compile-time + runtime smoke test
		const { CloudExecutionOrchestrator } = await import("../../../src/cloud/cloud-execution-orchestrator");
		const store = createMockStore() as any;
		store.readEventsForTask = async () => [];
		store.deriveTaskState = async () => "draft";
		store.appendEvent = async () => {};
		store.readExecutionsForTask = async () => [];
		store.updateExecution = async () => false;

		const client = {
			createInstance: async () => ({
				instance_id: "",
				user_id: "",
				namespace: "",
				state: "ready" as const,
				hostname: "",
			}),
			getInstance: async () => ({
				instance_id: "",
				user_id: "",
				namespace: "",
				state: "ready" as const,
				hostname: "",
			}),
			deleteInstance: async () => {},
		};
		const invoker = {
			composePrompt: async () => "",
			invokeRun: async () => ({ accepted: true }),
		};
		const limiter = new OrgConcurrencyLimiter(store, () => "org-A", { maxConcurrentPerOrg: 2 });

		const orch = new CloudExecutionOrchestrator(store, client, invoker, undefined, undefined, limiter);
		expect(orch).toBeDefined();
	});

	it("orchestrator without limiter still works (backward compatible)", async () => {
		const { CloudExecutionOrchestrator } = await import("../../../src/cloud/cloud-execution-orchestrator");
		const store = createMockStore() as any;
		store.readEventsForTask = async (id: string) => store._events.filter((e: any) => e.taskId === id);
		store.deriveTaskState = async (id: string) => {
			const evts = store._events.filter((e: any) => e.taskId === id);
			if (evts.length === 0) return "draft";
			return evts[evts.length - 1]?.toState;
		};
		store.appendEvent = async (evt: any) => {
			store._events.push(evt);
		};
		store.readExecutionsForTask = async () => [];
		store.updateExecution = async () => false;

		const client = {
			createInstance: async () => ({
				instance_id: "inst-1",
				user_id: "",
				namespace: "",
				state: "ready" as const,
				hostname: "h",
			}),
			getInstance: async () => ({
				instance_id: "inst-1",
				user_id: "",
				namespace: "",
				state: "ready" as const,
				hostname: "h",
			}),
			deleteInstance: async () => {},
		};
		const invoker = {
			composePrompt: async () => "prompt",
			invokeRun: async () => ({ accepted: true }),
		};

		// No limiter argument — backward compatible
		const orch = new CloudExecutionOrchestrator(store, client, invoker);
		seedTaskToState(store, "task-1", "queued");

		const result = await orch.processTask("task-1");
		expect(result?.success).toBe(true);
		expect(result?.newState).toBe("policy_check");
	});
});
