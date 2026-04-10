// ---------------------------------------------------------------------------
// Cloud Concurrency Limiter — Per-org admission control — P2-4
// @phase Phase2
// @prd-section 8, 10, 12
// ---------------------------------------------------------------------------
//
// Enforces bounded concurrency per organization at the Kanban dispatch layer.
//
// Architecture rules (PRD Section 12, Rule 5):
//   - Concurrency decisions are Kanban control-plane decisions
//   - Cloud-platform does not enforce Kanban concurrency limits
//   - Concurrency limits must be auditable
//   - Queued tasks must not silently drop
//
// PRD Section 10 Phase 2: N concurrent tasks -> N isolated sandboxes reliably
// PRD Section 8: Reliability — bounded failure recovery
// ---------------------------------------------------------------------------

import type { CloudExecutionState } from "./cloud-execution-lifecycle";
import { deriveCurrentState } from "./cloud-execution-lifecycle";
import type { PersistedTaskEvent } from "./cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum concurrent cloud-agent tasks per organization. */
export const DEFAULT_MAX_CONCURRENT_PER_ORG = 5;

/** Environment variable for per-org concurrency limit override. */
export const CLOUD_MAX_CONCURRENT_ENV = "KANBAN_CLOUD_MAX_CONCURRENT_PER_ORG";

/**
 * States that occupy a concurrency slot.
 *
 * A task occupies a slot from the moment it is dequeued (enters policy_check)
 * until it reaches a terminal state. Tasks in `queued` do NOT occupy a slot.
 */
export const CONCURRENCY_OCCUPYING_STATES: ReadonlySet<CloudExecutionState> = new Set([
	"policy_check",
	"provisioning",
	"running",
	"completing",
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ConcurrencyConfig {
	/** Maximum concurrent cloud-agent tasks per organization. @default 5 */
	readonly maxConcurrentPerOrg: number;
}

export const DEFAULT_CONCURRENCY_CONFIG: Readonly<ConcurrencyConfig> = {
	maxConcurrentPerOrg: DEFAULT_MAX_CONCURRENT_PER_ORG,
};

/** Parse concurrency config from environment variables with optional overrides. */
export function parseConcurrencyConfig(
	env: Record<string, string | undefined>,
	overrides?: Partial<ConcurrencyConfig>,
): ConcurrencyConfig {
	let maxConcurrent = DEFAULT_MAX_CONCURRENT_PER_ORG;
	const envVal = env[CLOUD_MAX_CONCURRENT_ENV];
	if (envVal !== undefined) {
		const parsed = Number.parseInt(envVal, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			maxConcurrent = parsed;
		}
	}
	return { maxConcurrentPerOrg: overrides?.maxConcurrentPerOrg ?? maxConcurrent };
}

// ---------------------------------------------------------------------------
// Org Resolver
// ---------------------------------------------------------------------------

/** Resolves the organization ID for a given task. */
export type OrgResolver = (taskId: string) => string | undefined;

// ---------------------------------------------------------------------------
// Admission Decision
// ---------------------------------------------------------------------------

export interface AdmissionDecision {
	readonly admitted: boolean;
	readonly orgId: string;
	readonly activeCount: number;
	readonly limit: number;
	/** 1-based queue position if not admitted; 0 if admitted. */
	readonly queuePosition: number;
	readonly reason: string;
}

// ---------------------------------------------------------------------------
// Concurrency Status
// ---------------------------------------------------------------------------

export interface OrgConcurrencyStatus {
	readonly orgId: string;
	readonly activeCount: number;
	readonly limit: number;
	readonly queuedCount: number;
	readonly availableSlots: number;
}

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

export interface ConcurrencyStoreInterface {
	readEvents(): Promise<readonly PersistedTaskEvent[]>;
}

// ---------------------------------------------------------------------------
// OrgConcurrencyLimiter
// ---------------------------------------------------------------------------

/**
 * Per-organization concurrency limiter for cloud execution dispatch.
 *
 * Stateless decision module — all state derived from persistent events.
 * FIFO ordering: queued tasks dispatch by submit-event timestamp.
 */
export class OrgConcurrencyLimiter {
	private readonly config: ConcurrencyConfig;
	private readonly orgResolver: OrgResolver;
	private readonly store: ConcurrencyStoreInterface;

	constructor(store: ConcurrencyStoreInterface, orgResolver: OrgResolver, config?: ConcurrencyConfig) {
		this.store = store;
		this.orgResolver = orgResolver;
		this.config = config ?? DEFAULT_CONCURRENCY_CONFIG;
	}

	/** Check whether a task can be admitted for dispatch (dequeued). */
	async checkAdmission(taskId: string): Promise<AdmissionDecision> {
		const orgId = this.orgResolver(taskId);
		if (!orgId) {
			return {
				admitted: true,
				orgId: "",
				activeCount: 0,
				limit: this.config.maxConcurrentPerOrg,
				queuePosition: 0,
				reason: "No org context — concurrency gating skipped.",
			};
		}
		const allEvents = await this.store.readEvents();
		const info = this.deriveTaskInfo(allEvents);
		const activeCount = this.countActiveForOrg(orgId, info);

		if (activeCount >= this.config.maxConcurrentPerOrg) {
			const queuePosition = this.getQueuePosition(taskId, orgId, allEvents, info);
			return {
				admitted: false,
				orgId,
				activeCount,
				limit: this.config.maxConcurrentPerOrg,
				queuePosition,
				reason: `Org ${orgId} at concurrency limit (${activeCount}/${this.config.maxConcurrentPerOrg}). Task queued at position ${queuePosition}.`,
			};
		}

		// Under limit — enforce FIFO
		const queued = this.getQueuedTasksForOrg(orgId, allEvents, info);
		if (queued.length > 0 && queued[0] !== taskId) {
			const idx = queued.indexOf(taskId);
			const pos = idx >= 0 ? idx + 1 : queued.length + 1;
			return {
				admitted: false,
				orgId,
				activeCount,
				limit: this.config.maxConcurrentPerOrg,
				queuePosition: pos,
				reason: `FIFO: earlier queued task(s) for org ${orgId} must dispatch first.`,
			};
		}

		return {
			admitted: true,
			orgId,
			activeCount,
			limit: this.config.maxConcurrentPerOrg,
			queuePosition: 0,
			reason: `Admitted. Org ${orgId} has capacity (${activeCount}/${this.config.maxConcurrentPerOrg}).`,
		};
	}
	/** Get concurrency status for an organization. */
	async getOrgStatus(orgId: string): Promise<OrgConcurrencyStatus> {
		const allEvents = await this.store.readEvents();
		const info = this.deriveTaskInfo(allEvents);
		const activeCount = this.countActiveForOrg(orgId, info);
		const queuedTasks = this.getQueuedTasksForOrg(orgId, allEvents, info);
		return {
			orgId,
			activeCount,
			limit: this.config.maxConcurrentPerOrg,
			queuedCount: queuedTasks.length,
			availableSlots: Math.max(0, this.config.maxConcurrentPerOrg - activeCount),
		};
	}

	/** Get queued tasks eligible for dispatch after a slot opens, FIFO order. */
	async getNextDispatchableTasksForOrg(orgId: string): Promise<readonly string[]> {
		const allEvents = await this.store.readEvents();
		const info = this.deriveTaskInfo(allEvents);
		const activeCount = this.countActiveForOrg(orgId, info);
		const available = Math.max(0, this.config.maxConcurrentPerOrg - activeCount);
		if (available === 0) return [];
		return this.getQueuedTasksForOrg(orgId, allEvents, info).slice(0, available);
	}

	/** Get the current concurrency config. */
	getConfig(): ConcurrencyConfig {
		return { ...this.config };
	}

	// -- internal helpers ---------------------------------------------------

	private deriveTaskInfo(allEvents: readonly PersistedTaskEvent[]): TaskInfo {
		const byTask = new Map<string, PersistedTaskEvent[]>();
		for (const e of allEvents) {
			const arr = byTask.get(e.taskId) ?? [];
			arr.push(e);
			byTask.set(e.taskId, arr);
		}
		const taskStates = new Map<string, CloudExecutionState>();
		for (const [id, evts] of byTask) {
			taskStates.set(id, deriveCurrentState(evts));
		}
		const taskOrgs = new Map<string, string>();
		for (const taskId of taskStates.keys()) {
			const org = this.orgResolver(taskId);
			if (org) taskOrgs.set(taskId, org);
		}
		return { taskStates, taskOrgs };
	}

	private countActiveForOrg(orgId: string, info: TaskInfo): number {
		let count = 0;
		for (const [taskId, state] of info.taskStates) {
			if (info.taskOrgs.get(taskId) === orgId && CONCURRENCY_OCCUPYING_STATES.has(state)) {
				count++;
			}
		}
		return count;
	}

	private getQueuedTasksForOrg(orgId: string, allEvents: readonly PersistedTaskEvent[], info: TaskInfo): string[] {
		const ids: string[] = [];
		for (const [taskId, state] of info.taskStates) {
			if (state === "queued" && info.taskOrgs.get(taskId) === orgId) ids.push(taskId);
		}
		if (ids.length <= 1) return ids;

		const submitTs = new Map<string, string>();
		for (const e of allEvents) {
			if (e.trigger === "submit" && e.toState === "queued" && ids.includes(e.taskId)) {
				if (!submitTs.has(e.taskId)) submitTs.set(e.taskId, e.timestamp);
			}
		}
		return ids.sort((a, b) => (submitTs.get(a) ?? "").localeCompare(submitTs.get(b) ?? ""));
	}

	private getQueuePosition(
		taskId: string,
		orgId: string,
		allEvents: readonly PersistedTaskEvent[],
		info: TaskInfo,
	): number {
		const q = this.getQueuedTasksForOrg(orgId, allEvents, info);
		const idx = q.indexOf(taskId);
		return idx >= 0 ? idx + 1 : q.length + 1;
	}
}

interface TaskInfo {
	taskStates: Map<string, CloudExecutionState>;
	taskOrgs: Map<string, string>;
}
