// ---------------------------------------------------------------------------
// Cloud Stuck-Task Reconciler — P2-3
// @phase Phase2
// @prd-section 8, 10
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { CloudExecutionState, CloudExecutionTrigger } from "./cloud-execution-lifecycle";
import {
	deriveCurrentState,
	isFinalState,
	isTerminalState,
	validateCloudExecutionTransition,
} from "./cloud-execution-lifecycle";
import type { EventTriggerSource, PersistedTaskEvent, PersistedTaskExecution } from "./cloud-execution-persistence";
import type { CloudPlatformExecutionClient } from "./cloud-platform-execution-client";
import { isTerminalExecutionStatus } from "./cloud-platform-execution-client";

// ---------------------------------------------------------------------------
// Reconciler Store Interface
// ---------------------------------------------------------------------------

export interface ReconcilerStoreInterface {
	readEvents(): Promise<readonly PersistedTaskEvent[]>;
	readEventsForTask(taskId: string): Promise<readonly PersistedTaskEvent[]>;
	deriveTaskState(taskId: string): Promise<CloudExecutionState>;
	appendEvent(event: PersistedTaskEvent): Promise<void>;
	readExecutions(): Promise<readonly PersistedTaskExecution[]>;
	readExecutionsForTask(taskId: string): Promise<readonly PersistedTaskExecution[]>;
	updateExecution(
		executionId: string,
		updates: Partial<
			Pick<
				PersistedTaskExecution,
				"instanceId" | "startedAt" | "completedAt" | "terminalState" | "resultSummary" | "remoteMetadata"
			>
		>,
	): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Reconciler Cloud Client Interface
// ---------------------------------------------------------------------------

/**
 * Cloud client interface for the reconciler.
 * KB-AUTH-4: Now uses cloud-platform execution status instead of direct instance queries.
 * The `executionId` parameter maps to the cloud-platform execution ID stored
 * in the task's remoteMetadata.instanceId field.
 */
export interface ReconcilerCloudClient {
	getExecutionStatus(executionId: string, signal?: AbortSignal): Promise<{ status: string }>;
	cancelExecution(executionId: string, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Logger / Timers
// ---------------------------------------------------------------------------

export interface ReconcilerLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: ReconcilerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface ReconcilerTimers {
	now(): number;
	delay(ms: number): Promise<void>;
}

export const realReconcilerTimers: ReconcilerTimers = {
	now: () => Date.now(),
	delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Reconciler Configuration (PRD Section 8 defaults)
// ---------------------------------------------------------------------------

export interface ReconcilerConfig {
	/** Reconciler scan interval. @default 30_000 */
	readonly scanIntervalMs: number;
	/** Stale threshold for running tasks. PRD: 90s. @default 90_000 */
	readonly staleThresholdMs: number;
	/** Provision timeout. PRD: 3 min. @default 180_000 */
	readonly provisionTimeoutMs: number;
	/** Teardown timeout. @default 120_000 */
	readonly teardownTimeoutMs: number;
	/** Completing/finalization timeout. @default 120_000 */
	readonly completingTimeoutMs: number;
	/** Execution hard timeout. PRD: max 2h. @default 7_200_000 */
	readonly executionHardTimeoutMs: number;
	/** Max reconnect attempts before failing. @default 3 */
	readonly maxReconnectAttempts: number;
	/** Heartbeat interval (informational). PRD: 15s. @default 15_000 */
	readonly heartbeatIntervalMs: number;
}

export const DEFAULT_RECONCILER_CONFIG: Readonly<ReconcilerConfig> = {
	scanIntervalMs: 30_000,
	staleThresholdMs: 90_000,
	provisionTimeoutMs: 180_000,
	teardownTimeoutMs: 120_000,
	completingTimeoutMs: 120_000,
	executionHardTimeoutMs: 7_200_000,
	maxReconnectAttempts: 3,
	heartbeatIntervalMs: 15_000,
};

// ---------------------------------------------------------------------------
// Lease Entry
// ---------------------------------------------------------------------------

export interface LeaseEntry {
	readonly taskId: string;
	readonly executionId: string;
	readonly instanceId: string | undefined;
	expiresAt: number;
	reconnectAttempts: number;
	markedStale: boolean;
}

// ---------------------------------------------------------------------------
// Reconciler Result Types
// ---------------------------------------------------------------------------

export interface ReconcilerAction {
	readonly taskId: string;
	readonly action:
		| "marked_stale"
		| "lease_extended"
		| "failed_timeout"
		| "failed_provision_timeout"
		| "failed_teardown_timeout"
		| "failed_completing_timeout"
		| "failed_unreachable"
		| "failed_execution_timeout"
		| "resumed_monitoring"
		| "orphan_flagged";
	readonly reason: string;
	readonly instanceId?: string;
	readonly previousState?: CloudExecutionState;
	readonly newState?: CloudExecutionState;
}

export interface ReconcilerScanResult {
	readonly scannedAt: string;
	readonly tasksScanned: number;
	readonly actions: readonly ReconcilerAction[];
}

export interface OrphanedInstance {
	readonly instanceId: string;
	readonly detectedAt: string;
	readonly reason: string;
}

// ---------------------------------------------------------------------------
// Stuck Task Reconciler
// ---------------------------------------------------------------------------

/**
 * Periodic reconciler that detects stuck/stale cloud executions,
 * attempts recovery, and transitions unrecoverable tasks to failed.
 *
 * PRD Section 6.3, 8, 10, 12 Rule 4, 15.12.
 */
export class StuckTaskReconciler {
	private readonly store: ReconcilerStoreInterface;
	private readonly client: ReconcilerCloudClient;
	private readonly config: ReconcilerConfig;
	private readonly logger: ReconcilerLogger;
	private readonly timers: ReconcilerTimers;
	private readonly leases = new Map<string, LeaseEntry>();
	private readonly orphanedInstances = new Map<string, OrphanedInstance>();
	private readonly expectedInstances = new Set<string>();
	private running = false;
	private scanTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		store: ReconcilerStoreInterface,
		client: ReconcilerCloudClient,
		config: ReconcilerConfig = DEFAULT_RECONCILER_CONFIG,
		logger: ReconcilerLogger = noopLogger,
		timers: ReconcilerTimers = realReconcilerTimers,
	) {
		this.store = store;
		this.client = client;
		this.config = config;
		this.logger = logger;
		this.timers = timers;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.scheduleNextScan();
	}

	stop(): void {
		this.running = false;
		if (this.scanTimer !== null) {
			clearTimeout(this.scanTimer);
			this.scanTimer = null;
		}
	}

	get isRunning(): boolean {
		return this.running;
	}

	// -- Lease Management ---------------------------------------------------

	renewLease(taskId: string, executionId: string, instanceId?: string): void {
		const existing = this.leases.get(taskId);
		const entry: LeaseEntry = {
			taskId,
			executionId: executionId || existing?.executionId || "",
			instanceId: instanceId || existing?.instanceId,
			expiresAt: this.timers.now() + this.config.staleThresholdMs,
			reconnectAttempts: 0,
			markedStale: false,
		};
		this.leases.set(taskId, entry);
		if (instanceId) this.expectedInstances.add(instanceId);
	}

	registerTask(taskId: string, executionId: string, instanceId?: string): void {
		this.renewLease(taskId, executionId, instanceId);
	}

	removeLease(taskId: string): void {
		const entry = this.leases.get(taskId);
		if (entry?.instanceId) this.expectedInstances.delete(entry.instanceId);
		this.leases.delete(taskId);
	}

	getLease(taskId: string): LeaseEntry | undefined {
		return this.leases.get(taskId);
	}

	getAllLeases(): ReadonlyMap<string, LeaseEntry> {
		return this.leases;
	}

	getOrphanedInstances(): ReadonlyMap<string, OrphanedInstance> {
		return this.orphanedInstances;
	}

	// -- Startup Recovery ---------------------------------------------------

	async recoverOnStartup(): Promise<ReconcilerScanResult> {
		const actions: ReconcilerAction[] = [];
		const now = this.timers.now();
		const allEvents = await this.store.readEvents();
		const taskStates = this.deriveAllTaskStates(allEvents);
		const allExecutions = await this.store.readExecutions();
		const latestByTask = this.getLatestExecutionByTask(allExecutions);

		for (const [taskId, state] of taskStates) {
			if (isFinalState(state) || state === "archived") continue;
			const exec = latestByTask.get(taskId);
			const instId = exec?.instanceId ?? exec?.remoteMetadata?.instanceId;

			if (state === "running" || state === "completing") {
				if (!instId) {
					const trigger: CloudExecutionTrigger = state === "running" ? "execution_error" : "finalize_error";
					const a = await this.failTask(taskId, state, trigger, "No execution ID during restart recovery");
					if (a) actions.push(a);
					continue;
				}
				try {
					const statusResp = await this.client.getExecutionStatus(instId);
					if (isTerminalExecutionStatus(statusResp.status) && statusResp.status !== "succeeded") {
						const trigger: CloudExecutionTrigger = state === "running" ? "execution_error" : "finalize_error";
						const a = await this.failTask(
							taskId,
							state,
							trigger,
							`Execution ${instId} is ${statusResp.status} during restart recovery`,
						);
						if (a) actions.push(a);
					} else if (!isTerminalExecutionStatus(statusResp.status)) {
						this.registerTask(taskId, exec?.executionId ?? "", instId);
						actions.push({
							taskId,
							action: "resumed_monitoring",
							reason: `Execution ${instId} still active (${statusResp.status})`,
							instanceId: instId,
							previousState: state,
						});
					}
				} catch {
					const trigger: CloudExecutionTrigger = state === "running" ? "execution_error" : "finalize_error";
					const a = await this.failTask(
						taskId,
						state,
						trigger,
						`Execution ${instId} unreachable during restart recovery`,
					);
					if (a) actions.push(a);
				}
			} else if (state === "provisioning" || state === "teardown" || isTerminalState(state)) {
				if (exec) this.registerTask(taskId, exec.executionId, instId);
				actions.push({
					taskId,
					action: "resumed_monitoring",
					reason: `Task in ${state}, re-registered for monitoring`,
					instanceId: instId,
					previousState: state,
				});
			}
		}

		this.logger.info("Startup recovery complete", { tasksScanned: taskStates.size, actionsCount: actions.length });
		return { scannedAt: new Date(now).toISOString(), tasksScanned: taskStates.size, actions };
	}

	// -- Core Scan ----------------------------------------------------------

	async scan(): Promise<ReconcilerScanResult> {
		const actions: ReconcilerAction[] = [];
		const now = this.timers.now();
		const allEvents = await this.store.readEvents();
		const taskStates = this.deriveAllTaskStates(allEvents);
		const allExecutions = await this.store.readExecutions();
		const latestByTask = this.getLatestExecutionByTask(allExecutions);
		const lastEventTs = this.getLastEventTimestampByTask(allEvents);

		for (const [taskId, state] of taskStates) {
			if (isFinalState(state) || state === "archived") {
				this.removeLease(taskId);
				continue;
			}
			const exec = latestByTask.get(taskId);
			const evtTs = lastEventTs.get(taskId) ?? 0;
			const instId = exec?.instanceId ?? exec?.remoteMetadata?.instanceId;

			if (state === "running") {
				actions.push(...(await this.reconcileRunning(taskId, exec, evtTs, now)));
			} else if (state === "provisioning") {
				actions.push(...(await this.reconcileProvisioning(taskId, evtTs, now)));
			} else if (state === "completing") {
				actions.push(...(await this.reconcileCompleting(taskId, evtTs, now)));
			} else if (state === "teardown") {
				actions.push(...(await this.reconcileTeardown(taskId, evtTs, now)));
			}

			if (instId && !isFinalState(state)) {
				this.expectedInstances.add(instId);
			}
		}

		return { scannedAt: new Date(now).toISOString(), tasksScanned: taskStates.size, actions };
	}

	// -- Orphan Detection ---------------------------------------------------

	flagOrphanedInstance(instanceId: string, reason: string): void {
		if (this.orphanedInstances.has(instanceId)) return;
		this.orphanedInstances.set(instanceId, {
			instanceId,
			detectedAt: new Date(this.timers.now()).toISOString(),
			reason,
		});
		this.logger.warn("Orphaned instance detected", { instanceId, reason });
	}

	detectOrphans(actualInstanceIds: readonly string[]): ReconcilerAction[] {
		const actions: ReconcilerAction[] = [];
		for (const instanceId of actualInstanceIds) {
			if (!this.expectedInstances.has(instanceId)) {
				this.flagOrphanedInstance(instanceId, "Instance not associated with any active Kanban task");
				actions.push({
					taskId: "",
					action: "orphan_flagged",
					reason: `Instance ${instanceId} has no associated Kanban task`,
					instanceId,
				});
			}
		}
		return actions;
	}

	// -- State Reconciliation -----------------------------------------------

	private async reconcileRunning(
		taskId: string,
		execution: PersistedTaskExecution | undefined,
		lastEventTs: number,
		now: number,
	): Promise<ReconcilerAction[]> {
		const actions: ReconcilerAction[] = [];
		const lease = this.leases.get(taskId);
		const instanceId = execution?.instanceId ?? execution?.remoteMetadata?.instanceId;
		const startedAt = execution?.startedAt ? Date.parse(execution.startedAt) : lastEventTs;
		if (startedAt > 0 && now - startedAt >= this.config.executionHardTimeoutMs) {
			const a = await this.failTask(
				taskId,
				"running",
				"execution_error",
				`Execution hard timeout exceeded (${Math.round(this.config.executionHardTimeoutMs / 1000)}s)`,
			);
			if (a) actions.push({ ...a, action: "failed_execution_timeout" });
			this.removeLease(taskId);
			return actions;
		}
		if (lease && lease.expiresAt > now) return actions;
		const timeSince = now - lastEventTs;
		if (timeSince < this.config.staleThresholdMs && !lease) {
			this.registerTask(taskId, execution?.executionId ?? "", instanceId);
			return actions;
		}
		if (!lease?.markedStale) {
			const entry: LeaseEntry = lease ?? {
				taskId,
				executionId: execution?.executionId ?? "",
				instanceId,
				expiresAt: 0,
				reconnectAttempts: 0,
				markedStale: false,
			};
			entry.markedStale = true;
			this.leases.set(taskId, entry);
			this.logger.warn("Task marked stale", { taskId, instanceId, timeSince });
			actions.push({
				taskId,
				action: "marked_stale",
				reason: `No heartbeat/update for ${Math.round(timeSince / 1000)}s`,
				instanceId,
				previousState: "running",
			});
		}
		if (!instanceId) {
			const a = await this.failTask(taskId, "running", "execution_error", "Stale task with no instance ID");
			if (a) actions.push(a);
			this.removeLease(taskId);
			return actions;
		}
		const currentLease = this.leases.get(taskId);
		if (!currentLease) return actions;
		if (currentLease.reconnectAttempts >= this.config.maxReconnectAttempts) {
			const a = await this.failTask(
				taskId,
				"running",
				"execution_error",
				`Instance ${instanceId} unreachable after ${this.config.maxReconnectAttempts} attempts`,
			);
			if (a) actions.push({ ...a, action: "failed_unreachable" });
			this.removeLease(taskId);
			return actions;
		}
		try {
			const statusResp = await this.client.getExecutionStatus(instanceId);
			currentLease.reconnectAttempts += 1;
			if (!isTerminalExecutionStatus(statusResp.status)) {
				currentLease.expiresAt = now + this.config.staleThresholdMs;
				currentLease.markedStale = false;
				currentLease.reconnectAttempts = 0;
				actions.push({
					taskId,
					action: "lease_extended",
					reason: `Execution ${instanceId} still active (${statusResp.status})`,
					instanceId,
					previousState: "running",
				});
			} else if (statusResp.status === "failed" || statusResp.status === "canceled") {
				const a = await this.failTask(
					taskId,
					"running",
					"execution_error",
					`Execution ${instanceId} is ${statusResp.status}`,
				);
				if (a) actions.push({ ...a, action: "failed_timeout" });
				this.removeLease(taskId);
			}
		} catch {
			currentLease.reconnectAttempts += 1;
			this.logger.warn("Reconnect failed", { taskId, instanceId, attempt: currentLease.reconnectAttempts });
		}
		return actions;
	}

	private async reconcileProvisioning(taskId: string, lastEventTs: number, now: number): Promise<ReconcilerAction[]> {
		const actions: ReconcilerAction[] = [];
		if (now - lastEventTs >= this.config.provisionTimeoutMs) {
			const a = await this.failTask(
				taskId,
				"provisioning",
				"provision_timeout",
				`Provision timeout exceeded (${Math.round(this.config.provisionTimeoutMs / 1000)}s)`,
			);
			if (a) actions.push({ ...a, action: "failed_provision_timeout" });
			this.removeLease(taskId);
		}
		return actions;
	}

	private async reconcileCompleting(taskId: string, lastEventTs: number, now: number): Promise<ReconcilerAction[]> {
		const actions: ReconcilerAction[] = [];
		if (now - lastEventTs >= this.config.completingTimeoutMs) {
			const a = await this.failTask(
				taskId,
				"completing",
				"finalize_error",
				`Finalization timeout exceeded (${Math.round(this.config.completingTimeoutMs / 1000)}s)`,
			);
			if (a) actions.push({ ...a, action: "failed_completing_timeout" });
			this.removeLease(taskId);
		}
		return actions;
	}

	private async reconcileTeardown(taskId: string, lastEventTs: number, now: number): Promise<ReconcilerAction[]> {
		const actions: ReconcilerAction[] = [];
		if (now - lastEventTs >= this.config.teardownTimeoutMs) {
			const result = validateCloudExecutionTransition("teardown", "sandbox_terminated");
			if (result.valid) {
				await this.persistTransition(taskId, "teardown", "sandbox_terminated", "system", {
					reconcilerAction: "forced_teardown_completion",
					reason: `Teardown timeout exceeded (${Math.round(this.config.teardownTimeoutMs / 1000)}s)`,
				});
				actions.push({
					taskId,
					action: "failed_teardown_timeout",
					reason: "Teardown timeout exceeded, forced to archived",
					previousState: "teardown",
					newState: "archived",
				});
			}
			this.removeLease(taskId);
		}
		return actions;
	}

	// -- Transition Helpers -------------------------------------------------

	private async failTask(
		taskId: string,
		fromState: CloudExecutionState,
		trigger: CloudExecutionTrigger,
		reason: string,
	): Promise<ReconcilerAction | null> {
		const result = validateCloudExecutionTransition(fromState, trigger);
		if (!result.valid) {
			this.logger.error("Invalid reconciler transition", {
				taskId,
				from: fromState,
				trigger,
				reason: result.reason,
			});
			return null;
		}
		await this.persistTransition(taskId, fromState, trigger, "system", {
			reconcilerAction: "failed_by_reconciler",
			reason,
			staleRecovery: true,
		});
		const executions = await this.store.readExecutionsForTask(taskId);
		const latest = executions[executions.length - 1];
		if (latest) {
			await this.store.updateExecution(latest.executionId, {
				terminalState: result.to,
				completedAt: new Date(this.timers.now()).toISOString(),
				resultSummary: `Reconciler: ${reason}`,
			});
		}
		this.logger.info("Task failed by reconciler", { taskId, from: fromState, to: result.to, trigger, reason });
		return {
			taskId,
			action: "failed_timeout",
			reason,
			instanceId: latest?.instanceId ?? latest?.remoteMetadata?.instanceId,
			previousState: fromState,
			newState: result.to,
		};
	}

	private async persistTransition(
		taskId: string,
		fromState: CloudExecutionState,
		trigger: CloudExecutionTrigger,
		triggerSource: EventTriggerSource,
		metadata: Record<string, unknown>,
	): Promise<void> {
		const result = validateCloudExecutionTransition(fromState, trigger);
		if (!result.valid) return;
		const event: PersistedTaskEvent = {
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: result.from,
			toState: result.to,
			timestamp: new Date(this.timers.now()).toISOString(),
			triggerSource,
			metadata,
		};
		await this.store.appendEvent(event);
	}

	// -- Internal Helpers ---------------------------------------------------

	private scheduleNextScan(): void {
		if (!this.running) return;
		this.scanTimer = setTimeout(async () => {
			try {
				await this.scan();
			} catch (e) {
				this.logger.error("Reconciler scan failed", { error: e instanceof Error ? e.message : String(e) });
			}
			this.scheduleNextScan();
		}, this.config.scanIntervalMs);
	}

	private deriveAllTaskStates(events: readonly PersistedTaskEvent[]): Map<string, CloudExecutionState> {
		const byTask = new Map<string, PersistedTaskEvent[]>();
		for (const e of events) {
			const arr = byTask.get(e.taskId) ?? [];
			arr.push(e);
			byTask.set(e.taskId, arr);
		}
		const states = new Map<string, CloudExecutionState>();
		for (const [id, evts] of byTask) {
			states.set(id, deriveCurrentState(evts));
		}
		return states;
	}

	private getLatestExecutionByTask(
		executions: readonly PersistedTaskExecution[],
	): Map<string, PersistedTaskExecution> {
		const map = new Map<string, PersistedTaskExecution>();
		for (const exec of executions) {
			const existing = map.get(exec.taskId);
			if (!existing || exec.attemptNumber > existing.attemptNumber) map.set(exec.taskId, exec);
		}
		return map;
	}

	private getLastEventTimestampByTask(events: readonly PersistedTaskEvent[]): Map<string, number> {
		const map = new Map<string, number>();
		for (const e of events) {
			const ts = Date.parse(e.timestamp);
			const existing = map.get(e.taskId) ?? 0;
			if (ts > existing) map.set(e.taskId, ts);
		}
		return map;
	}
}
