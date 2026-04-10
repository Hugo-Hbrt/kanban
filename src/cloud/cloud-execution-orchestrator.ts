import { randomUUID } from "node:crypto";

import type { CloudExecutionState, CloudExecutionTrigger } from "./cloud-execution-lifecycle";
import {
	deriveCurrentState,
	isFinalState,
	isTerminalState,
	validateCloudExecutionTransition,
} from "./cloud-execution-lifecycle";
import type { EventTriggerSource, PersistedTaskEvent, PersistedTaskExecution } from "./cloud-execution-persistence";
import type { CloudInstanceClient, CloudInstanceResponse } from "./cloud-instance-client";
import type { ReadinessPollerConfig } from "./cloud-readiness-poller";
import { DEFAULT_READINESS_POLLER_CONFIG, pollForReadiness } from "./cloud-readiness-poller";

// ---------------------------------------------------------------------------
// Store Interface (structural typing for testability)
// ---------------------------------------------------------------------------

/**
 * Interface for the persistence layer used by the orchestrator.
 * Structurally compatible with {@link CloudExecutionStore} from A2.
 */
export interface CloudExecutionStoreInterface {
	readEvents(): Promise<readonly PersistedTaskEvent[]>;
	readEventsForTask(taskId: string): Promise<readonly PersistedTaskEvent[]>;
	deriveTaskState(taskId: string): Promise<CloudExecutionState>;
	appendEvent(event: PersistedTaskEvent): Promise<void>;
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
// Extended Cloud Client Interface (B1 full contract)
// ---------------------------------------------------------------------------

export interface CreateInstanceRequest {
	readonly taskId: string;
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly featureBranch?: string;
}

export interface CloudInstanceFullClient extends CloudInstanceClient {
	createInstance(request: CreateInstanceRequest, signal?: AbortSignal): Promise<CloudInstanceResponse>;
	deleteInstance(instanceId: string, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Run Invocation Interface (B3 contract)
// ---------------------------------------------------------------------------

export interface InvokeRunRequest {
	readonly taskId: string;
	readonly executionId: string;
	readonly instanceId: string;
	readonly hostname: string;
	readonly prompt: string;
}

export interface InvokeRunResponse {
	readonly accepted: boolean;
	readonly runId?: string;
}

export interface CloudRunInvoker {
	composePrompt(taskId: string): Promise<string>;
	invokeRun(request: InvokeRunRequest, signal?: AbortSignal): Promise<InvokeRunResponse>;
}

// ---------------------------------------------------------------------------
// Orchestrator Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	readonly tickIntervalMs: number;
	readonly pollerConfig: ReadinessPollerConfig;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: Readonly<OrchestratorConfig> = {
	tickIntervalMs: 5_000,
	pollerConfig: DEFAULT_READINESS_POLLER_CONFIG,
};

// ---------------------------------------------------------------------------
// Task Context (per in-flight task)
// ---------------------------------------------------------------------------

interface TaskContext {
	readonly taskId: string;
	executionId: string;
	instanceId?: string;
	hostname?: string;
	cancelRequested: boolean;
	abortController: AbortController;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface OrchestratorLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: OrchestratorLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface TaskStepResult {
	readonly taskId: string;
	readonly previousState: CloudExecutionState;
	readonly newState: CloudExecutionState;
	readonly trigger: CloudExecutionTrigger;
	readonly success: boolean;
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// Cloud Execution Orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestration worker that drives cloud-agent tasks through the complete
 * execution lifecycle from `queued` through terminal states.
 *
 * Architecture invariants:
 * - All transitions go through the lifecycle validator (A1)
 * - All transitions are persisted as events (A2)
 * - Worker is idempotent and safe to restart (state from persistence)
 * - Worker handles concurrent tasks in different lifecycle stages
 * - Kanban orchestrates; it never executes task workload
 * - One task = one remote task-runner instance
 */
export class CloudExecutionOrchestrator {
	private readonly store: CloudExecutionStoreInterface;
	private readonly client: CloudInstanceFullClient;
	private readonly runInvoker: CloudRunInvoker;
	private readonly config: OrchestratorConfig;
	private readonly logger: OrchestratorLogger;
	private readonly activeTasks = new Map<string, TaskContext>();
	private readonly pendingCancellations = new Set<string>();
	private running = false;
	private tickTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		store: CloudExecutionStoreInterface,
		client: CloudInstanceFullClient,
		runInvoker: CloudRunInvoker,
		config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
		logger: OrchestratorLogger = noopLogger,
	) {
		this.store = store;
		this.client = client;
		this.runInvoker = runInvoker;
		this.config = config;
		this.logger = logger;
	}

	/** Start the worker loop. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.scheduleNextTick();
	}

	/** Stop the worker loop and abort in-flight operations. */
	stop(): void {
		this.running = false;
		if (this.tickTimer !== null) {
			clearTimeout(this.tickTimer);
			this.tickTimer = null;
		}
		for (const ctx of this.activeTasks.values()) {
			ctx.abortController.abort();
		}
	}

	/** Request cancellation of a task at the next safe lifecycle point. */
	requestCancellation(taskId: string): void {
		this.pendingCancellations.add(taskId);
		const ctx = this.activeTasks.get(taskId);
		if (ctx) {
			ctx.cancelRequested = true;
			ctx.abortController.abort();
		}
	}

	/** Process a single tick — the core idempotent operation. */
	async processTick(): Promise<TaskStepResult[]> {
		const results: TaskStepResult[] = [];
		const allEvents = await this.store.readEvents();
		const taskStates = this.deriveTaskStates(allEvents);

		for (const taskId of [...this.pendingCancellations]) {
			const s = taskStates.get(taskId);
			if (s && !isTerminalState(s) && !isFinalState(s)) {
				const r = await this.applyCancellation(taskId, s);
				if (r) {
					results.push(r);
					taskStates.set(taskId, r.newState);
				}
			}
			this.pendingCancellations.delete(taskId);
		}

		for (const [taskId, state] of taskStates) {
			if (isTerminalState(state) || isFinalState(state)) continue;
			const r = await this.advanceTask(taskId, state);
			if (r) results.push(r);
		}
		return results;
	}

	/** Process a single task without waiting for the next tick. */
	async processTask(taskId: string): Promise<TaskStepResult | null> {
		const s = await this.store.deriveTaskState(taskId);
		if (this.pendingCancellations.has(taskId)) {
			this.pendingCancellations.delete(taskId);
			if (!isTerminalState(s) && !isFinalState(s)) {
				return this.applyCancellation(taskId, s);
			}
		}
		if (isTerminalState(s) || isFinalState(s)) return null;
		return this.advanceTask(taskId, s);
	}

	// -- internal: worker loop -----------------------------------------------

	private scheduleNextTick(): void {
		if (!this.running) return;
		this.tickTimer = setTimeout(async () => {
			try {
				await this.processTick();
			} catch (e) {
				this.logger.error("Tick failed", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
			this.scheduleNextTick();
		}, this.config.tickIntervalMs);
	}

	// -- internal: state derivation ------------------------------------------

	private deriveTaskStates(events: readonly PersistedTaskEvent[]): Map<string, CloudExecutionState> {
		const byTask = new Map<string, PersistedTaskEvent[]>();
		for (const e of events) {
			const arr = byTask.get(e.taskId) ?? [];
			arr.push(e);
			byTask.set(e.taskId, arr);
		}
		const m = new Map<string, CloudExecutionState>();
		for (const [id, evts] of byTask) {
			m.set(id, deriveCurrentState(evts));
		}
		return m;
	}

	// -- internal: task advancement ------------------------------------------

	private async advanceTask(taskId: string, state: CloudExecutionState): Promise<TaskStepResult | null> {
		switch (state) {
			case "queued":
				return this.handleQueued(taskId);
			case "policy_check":
				return this.handlePolicyCheck(taskId);
			case "provisioning":
				return this.handleProvisioning(taskId);
			case "running":
				return this.handleRunning(taskId);
			default:
				return null;
		}
	}

	// -- queued -> policy_check ----------------------------------------------

	private handleQueued(taskId: string): Promise<TaskStepResult> {
		return this.applyTransition(taskId, "queued", "dequeue", "system");
	}

	// -- policy_check -> provisioning (stub authorized for MVP) --------------

	private handlePolicyCheck(taskId: string): Promise<TaskStepResult> {
		// MVP stub: always authorized. D-track adds real governance.
		return this.applyTransition(taskId, "policy_check", "authorized", "system");
	}

	// -- provisioning -> running ---------------------------------------------

	private async handleProvisioning(taskId: string): Promise<TaskStepResult> {
		const ctx = this.getOrCreateCtx(taskId);
		if (ctx.cancelRequested) return this.cancelProvision(taskId);

		try {
			if (!ctx.instanceId) {
				const execs = await this.store.readExecutionsForTask(taskId);
				const latest = execs[execs.length - 1];
				const meta = latest?.remoteMetadata;

				const req: CreateInstanceRequest = {
					taskId,
					repoUrl: meta?.repoUrl ?? "",
					baseBranch: meta?.baseBranch ?? "main",
					featureBranch: meta?.featureBranch,
				};

				const inst = await this.client.createInstance(req, ctx.abortController.signal);
				ctx.instanceId = inst.instance_id;
				ctx.hostname = inst.hostname;

				if (latest) {
					await this.store.updateExecution(latest.executionId, {
						instanceId: inst.instance_id,
						remoteMetadata: {
							...(meta ?? {
								instanceId: inst.instance_id,
								repoUrl: req.repoUrl,
								baseBranch: req.baseBranch,
							}),
							instanceId: inst.instance_id,
							instanceHostname: inst.hostname,
							instanceStatus: inst.state,
						},
					});
				}
				this.logger.info("Instance created", {
					taskId,
					instanceId: inst.instance_id,
				});
			}

			if (ctx.cancelRequested) return this.cancelProvision(taskId);

			const poll = await pollForReadiness(
				this.client,
				ctx.instanceId,
				this.config.pollerConfig,
				ctx.abortController.signal,
			);

			if (ctx.cancelRequested) return this.cancelProvision(taskId);

			if (poll.status === "ready") {
				ctx.hostname = poll.hostname;
				this.logger.info("Instance ready", {
					taskId,
					instanceId: ctx.instanceId,
				});
				return this.applyTransition(taskId, "provisioning", "sandbox_ready", "system", {
					instanceId: ctx.instanceId,
					hostname: ctx.hostname,
				});
			}

			this.cleanupCtx(taskId);
			return this.applyTransition(taskId, "provisioning", "provision_timeout", "system", { reason: poll.reason });
		} catch (e) {
			if (ctx.cancelRequested) return this.cancelProvision(taskId);
			this.cleanupCtx(taskId);
			return this.applyTransition(taskId, "provisioning", "provision_timeout", "system", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	private cancelProvision(taskId: string): Promise<TaskStepResult> {
		this.cleanupCtx(taskId);
		this.pendingCancellations.delete(taskId);
		return this.applyTransition(taskId, "provisioning", "provision_timeout", "user", {
			cancelledDuringProvisioning: true,
		});
	}

	// -- running -> wait for terminal callback (invoke /run first) -----------

	private async handleRunning(taskId: string): Promise<TaskStepResult | null> {
		const ctx = this.getOrCreateCtx(taskId);
		const execs = await this.store.readExecutionsForTask(taskId);
		const latest = execs[execs.length - 1];

		// Idempotency: if /run already invoked, wait for callback
		if (latest?.startedAt) return null;

		if (ctx.cancelRequested) {
			return this.applyTransition(taskId, "running", "user_cancel", "user");
		}

		try {
			const prompt = await this.runInvoker.composePrompt(taskId);
			if (ctx.cancelRequested) {
				return this.applyTransition(taskId, "running", "user_cancel", "user");
			}

			const hostname = ctx.hostname ?? latest?.remoteMetadata?.instanceHostname;
			const instanceId = ctx.instanceId ?? latest?.remoteMetadata?.instanceId ?? latest?.instanceId;

			if (!hostname || !instanceId) {
				this.cleanupCtx(taskId);
				return this.applyTransition(taskId, "running", "execution_error", "system", {
					error: "Missing hostname or instanceId",
				});
			}

			const resp = await this.runInvoker.invokeRun(
				{
					taskId,
					executionId: latest?.executionId ?? ctx.executionId,
					instanceId,
					hostname,
					prompt,
				},
				ctx.abortController.signal,
			);

			if (!resp.accepted) {
				this.cleanupCtx(taskId);
				return this.applyTransition(taskId, "running", "execution_error", "system", { error: "/run rejected" });
			}

			if (latest) {
				await this.store.updateExecution(latest.executionId, {
					startedAt: new Date().toISOString(),
				});
			}
			this.logger.info("/run accepted", { taskId, instanceId });
			return null;
		} catch (e) {
			if (ctx.cancelRequested) {
				return this.applyTransition(taskId, "running", "user_cancel", "user");
			}
			this.cleanupCtx(taskId);
			return this.applyTransition(taskId, "running", "execution_error", "system", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// -- cancellation --------------------------------------------------------

	private async applyCancellation(taskId: string, state: CloudExecutionState): Promise<TaskStepResult | null> {
		this.cleanupCtx(taskId);
		switch (state) {
			case "queued": {
				await this.applyTransition(taskId, "queued", "dequeue", "system");
				return this.applyTransition(taskId, "policy_check", "denied", "user", { cancelledByUser: true });
			}
			case "policy_check":
				return this.applyTransition(taskId, "policy_check", "denied", "user", { cancelledByUser: true });
			case "provisioning":
				return this.applyTransition(taskId, "provisioning", "provision_timeout", "user", { cancelledByUser: true });
			case "running":
				return this.applyTransition(taskId, "running", "user_cancel", "user");
			case "completing":
				this.logger.warn("Cannot cancel completing", { taskId });
				return null;
			default:
				return null;
		}
	}

	// -- transition application (single point of truth) ----------------------

	private async applyTransition(
		taskId: string,
		fromState: CloudExecutionState,
		trigger: CloudExecutionTrigger,
		triggerSource: EventTriggerSource,
		metadata?: Record<string, unknown>,
	): Promise<TaskStepResult> {
		const result = validateCloudExecutionTransition(fromState, trigger);

		if (!result.valid) {
			this.logger.error("Invalid transition", {
				taskId,
				from: fromState,
				trigger,
				reason: result.reason,
			});
			return {
				taskId,
				previousState: fromState,
				newState: fromState,
				trigger,
				success: false,
				error: result.reason,
			};
		}

		const event: PersistedTaskEvent = {
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: result.from,
			toState: result.to,
			timestamp: new Date().toISOString(),
			triggerSource,
			metadata,
		};

		try {
			await this.store.appendEvent(event);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.logger.error("Persist failed", {
				taskId,
				trigger,
				error: msg,
			});
			return {
				taskId,
				previousState: fromState,
				newState: fromState,
				trigger,
				success: false,
				error: `Persistence failed: ${msg}`,
			};
		}

		this.logger.info("Transition", {
			taskId,
			from: result.from,
			to: result.to,
			trigger,
		});
		return {
			taskId,
			previousState: result.from,
			newState: result.to,
			trigger,
			success: true,
		};
	}

	// -- context management --------------------------------------------------

	private getOrCreateCtx(taskId: string): TaskContext {
		let ctx = this.activeTasks.get(taskId);
		if (!ctx) {
			ctx = {
				taskId,
				executionId: randomUUID(),
				cancelRequested: this.pendingCancellations.has(taskId),
				abortController: new AbortController(),
			};
			this.activeTasks.set(taskId, ctx);
		}
		return ctx;
	}

	private cleanupCtx(taskId: string): void {
		const ctx = this.activeTasks.get(taskId);
		if (ctx) {
			ctx.abortController.abort();
			this.activeTasks.delete(taskId);
		}
	}
}
