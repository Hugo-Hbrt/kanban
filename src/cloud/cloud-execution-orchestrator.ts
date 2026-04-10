// ---------------------------------------------------------------------------
// Cloud Execution Orchestrator — A3
// @phase MVP (core lifecycle); Phase 2+ features via extension points
// @prd-section 6, 15.6
//
// Phase boundary:
//   MVP: task lifecycle (queued → policy_check → provisioning → running →
//        completing → terminal → teardown → archived), cancel, /run invocation
//   Phase 2+ (extension points):
//     - ConcurrencyLimiterExtension (P2-4): optional ctor param, null = no gating
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Phase 2+ Extension Point: Concurrency Limiter
// @phase Phase2 (P2-4) — optional, loaded via extension interface below
// The orchestrator never hard-depends on cloud-concurrency-limiter.ts.
// When no limiter is provided, all tasks are admitted immediately.
// ---------------------------------------------------------------------------

/**
 * Admission decision returned by a concurrency limiter extension.
 * Structurally compatible with {@link OrgConcurrencyLimiter.checkAdmission}
 * from cloud-concurrency-limiter.ts (Phase 2).
 */
export interface ConcurrencyAdmissionDecision {
	readonly admitted: boolean;
	readonly orgId: string;
	readonly activeCount: number;
	readonly limit: number;
	readonly queuePosition: number;
	readonly reason: string;
}

/**
 * Extension point interface for per-org concurrency limiting (Phase 2+).
 *
 * MVP orchestrator accepts `null` — no concurrency gating applied.
 * Phase 2 injects an {@link OrgConcurrencyLimiter} instance from
 * `cloud-concurrency-limiter.ts` at construction time.
 */
export interface ConcurrencyLimiterExtension {
	checkAdmission(taskId: string): Promise<ConcurrencyAdmissionDecision>;
}

import type { CloudExecutionState, CloudExecutionTrigger } from "./cloud-execution-lifecycle";
import {
	deriveCurrentState,
	isFinalState,
	isTerminalState,
	validateCloudExecutionTransition,
} from "./cloud-execution-lifecycle";
import type { CloudExecutionLogStoreInterface } from "./cloud-execution-log-store";
import type { CloudExecutionLogStreamClient, LogStreamClientFactory } from "./cloud-execution-log-stream";
import { defaultLogStreamClientFactory } from "./cloud-execution-log-stream";
import type { EventTriggerSource, PersistedTaskEvent, PersistedTaskExecution } from "./cloud-execution-persistence";
import type { GovernanceClient } from "./cloud-governance-client";
import type { CloudInstanceResponse } from "./cloud-instance-client";
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

/**
 * Orchestrator-level cloud client interface.
 *
 * This is a simplified interface used internally by the orchestrator.
 * It is structurally compatible with, but intentionally does not extend,
 * {@link CloudInstanceClient} because the orchestrator uses its own
 * {@link CreateInstanceRequest} shape for provisioning.
 */
export interface CloudInstanceFullClient {
	createInstance(request: CreateInstanceRequest, signal?: AbortSignal): Promise<CloudInstanceResponse>;
	getInstance(instanceId: string, signal?: AbortSignal): Promise<CloudInstanceResponse>;
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
// Teardown Configuration (PRD Section 15.6 + Section 15.11)
// ---------------------------------------------------------------------------

export interface TeardownConfig {
	/** Maximum number of retry attempts for instance deletion. @default 3 */
	readonly maxRetries: number;
	/** Base delay in milliseconds for exponential backoff. @default 1000 */
	readonly baseDelayMs: number;
	/** Maximum delay in milliseconds between retries. @default 15_000 */
	readonly maxDelayMs: number;
	/** Custom delay function for dependency injection / testing. */
	readonly delay?: (ms: number) => Promise<void>;
}

export const DEFAULT_TEARDOWN_CONFIG: Readonly<TeardownConfig> = {
	maxRetries: 3,
	baseDelayMs: 1_000,
	maxDelayMs: 15_000,
};

// ---------------------------------------------------------------------------
// Orchestrator Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	readonly tickIntervalMs: number;
	readonly pollerConfig: ReadinessPollerConfig;
	readonly teardownConfig: TeardownConfig;
	readonly projectId?: string;
	readonly orgId?: string;
	readonly requestedLimits?: Record<string, unknown>;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: Readonly<OrchestratorConfig> = {
	tickIntervalMs: 5_000,
	pollerConfig: DEFAULT_READINESS_POLLER_CONFIG,
	teardownConfig: DEFAULT_TEARDOWN_CONFIG,
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
	/** @phase Phase2 — SSE log stream client for this task (when running). */
	logStreamClient?: CloudExecutionLogStreamClient;
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
// Execution Identity Fidelity Validation
// ---------------------------------------------------------------------------

/**
 * Canonical identity fields that define an execution's relationship to the
 * original dispatch. These fields must be consistent across retry/replay/rerun
 * flows unless explicitly overridden (e.g. rerun-from-snapshot creating a
 * fresh feature branch).
 */
export interface ExecutionCanonicalIdentity {
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly featureBranch?: string;
	readonly worktreePath?: string;
	readonly attemptNumber: number;
}

export interface IdentityDriftViolation {
	readonly field: string;
	readonly expected: string | number | undefined;
	readonly actual: string | number | undefined;
	readonly severity: "error" | "warning";
}

export interface ExecutionIdentityFidelityResult {
	readonly valid: boolean;
	readonly violations: readonly IdentityDriftViolation[];
	readonly taskId: string;
	readonly executionId: string;
	readonly flowType: "retry" | "replay" | "rerun_snapshot" | "initial";
}

/**
 * Derive a deterministic worktree path from taskId and attemptNumber.
 *
 * Format: `{taskId}/attempt-{attemptNumber}`
 */
export function deriveWorktreePath(taskId: string, attemptNumber: number): string {
	return `${taskId}/attempt-${attemptNumber}`;
}

/**
 * Validate that a new execution record's canonical identity fields match
 * expectations relative to the source execution.
 *
 * Rules:
 * - repoUrl must match (never drifts)
 * - baseBranch must match (reflects original base ref, not current HEAD)
 * - featureBranch: reuse_branch must match source; fresh_branch must be undefined
 * - worktreePath: must be deterministic from taskId + attemptNumber
 * - attemptNumber: must be greater than source
 */
export function validateExecutionIdentityFidelity(
	newExecution: PersistedTaskExecution,
	sourceExecution: PersistedTaskExecution,
	flowType: "retry" | "replay" | "rerun_snapshot",
	logger?: OrchestratorLogger,
): ExecutionIdentityFidelityResult {
	const violations: IdentityDriftViolation[] = [];
	const newMeta = newExecution.remoteMetadata;
	const srcMeta = sourceExecution.remoteMetadata;

	// 1. repoUrl — must always match
	if (newMeta?.repoUrl !== undefined && srcMeta?.repoUrl !== undefined) {
		if (newMeta.repoUrl !== srcMeta.repoUrl) {
			violations.push({ field: "repoUrl", expected: srcMeta.repoUrl, actual: newMeta.repoUrl, severity: "error" });
		}
	}

	// 2. baseBranch — must always match
	if (newMeta?.baseBranch !== undefined && srcMeta?.baseBranch !== undefined) {
		if (newMeta.baseBranch !== srcMeta.baseBranch) {
			violations.push({
				field: "baseBranch",
				expected: srcMeta.baseBranch,
				actual: newMeta.baseBranch,
				severity: "error",
			});
		}
	}

	// 3. featureBranch — depends on branchIntent
	const branchIntent = newExecution.branchIntent;
	if (branchIntent === "reuse_branch") {
		if (newMeta?.featureBranch !== srcMeta?.featureBranch) {
			violations.push({
				field: "featureBranch",
				expected: srcMeta?.featureBranch,
				actual: newMeta?.featureBranch,
				severity: "error",
			});
		}
	} else if (branchIntent === "fresh_branch" && newMeta?.featureBranch !== undefined) {
		violations.push({
			field: "featureBranch",
			expected: undefined,
			actual: newMeta?.featureBranch,
			severity: "warning",
		});
	}

	// 4. worktreePath — deterministic from taskId + attemptNumber
	const expectedWt = deriveWorktreePath(newExecution.taskId, newExecution.attemptNumber);
	const actualWt = newMeta?.worktreePath ?? newExecution.worktreeIntent;
	if (actualWt !== undefined && actualWt !== expectedWt) {
		violations.push({ field: "worktreePath", expected: expectedWt, actual: actualWt, severity: "warning" });
	}

	// 5. attemptNumber — must be greater than source
	if (newExecution.attemptNumber <= sourceExecution.attemptNumber) {
		violations.push({
			field: "attemptNumber",
			expected: sourceExecution.attemptNumber + 1,
			actual: newExecution.attemptNumber,
			severity: "error",
		});
	}

	if (violations.length > 0 && logger) {
		for (const v of violations) {
			const logFn = v.severity === "error" ? logger.error : logger.warn;
			logFn.call(logger, `Execution identity drift: ${v.field}`, {
				taskId: newExecution.taskId,
				executionId: newExecution.executionId,
				flowType,
				expected: v.expected,
				actual: v.actual,
			});
		}
	}

	return {
		valid: violations.filter((v) => v.severity === "error").length === 0,
		violations,
		taskId: newExecution.taskId,
		executionId: newExecution.executionId,
		flowType,
	};
}

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
	private readonly concurrencyLimiter: ConcurrencyLimiterExtension | null;
	private readonly governanceClient: GovernanceClient | null;
	/** @phase Phase2 — Log store for persisting SSE log entries. */
	private readonly logStore: CloudExecutionLogStoreInterface | null;
	/** @phase Phase2 — Factory for creating SSE log stream clients. */
	private readonly logStreamFactory: LogStreamClientFactory;
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
		concurrencyLimiter?: ConcurrencyLimiterExtension | null,
		governanceClient?: GovernanceClient | null,
		logStore?: CloudExecutionLogStoreInterface | null,
		logStreamFactory?: LogStreamClientFactory | null,
	) {
		this.store = store;
		this.client = client;
		this.runInvoker = runInvoker;
		this.config = config;
		this.logger = logger;
		this.concurrencyLimiter = concurrencyLimiter ?? null;
		this.governanceClient = governanceClient ?? null;
		this.logStore = logStore ?? null;
		this.logStreamFactory = logStreamFactory ?? defaultLogStreamClientFactory;
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
			if (s && !isTerminalState(s) && !isFinalState(s) && s !== "teardown") {
				const r = await this.applyCancellation(taskId, s);
				if (r) {
					results.push(r);
					taskStates.set(taskId, r.newState);
				}
			}
			this.pendingCancellations.delete(taskId);
		}

		for (const [taskId, state] of taskStates) {
			if (isFinalState(state)) continue;
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
			if (!isTerminalState(s) && !isFinalState(s) && s !== "teardown") {
				return this.applyCancellation(taskId, s);
			}
		}
		if (isFinalState(s)) return null;
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
			case "completed":
			case "failed":
			case "canceled":
				return this.handleTerminal(taskId, state);
			case "teardown":
				return this.handleTeardown(taskId);
			default:
				return null;
		}
	}

	// -- queued -> policy_check (with concurrency gate) ----------------------

	private async handleQueued(taskId: string): Promise<TaskStepResult | null> {
		// P2-4: Check per-org concurrency before dequeuing
		if (this.concurrencyLimiter) {
			const decision = await this.concurrencyLimiter.checkAdmission(taskId);
			if (!decision.admitted) {
				this.logger.info("Concurrency limit: task stays queued", {
					taskId,
					orgId: decision.orgId,
					activeCount: decision.activeCount,
					limit: decision.limit,
					queuePosition: decision.queuePosition,
					reason: decision.reason,
				});
				return null; // Stay queued — will be re-evaluated on next tick
			}
			this.logger.info("Concurrency check passed", {
				taskId,
				orgId: decision.orgId,
				activeCount: decision.activeCount,
				limit: decision.limit,
			});
		}
		return this.applyTransition(taskId, "queued", "dequeue", "system", {
			...(this.concurrencyLimiter ? { concurrencyAdmitted: true } : {}),
		});
	}

	// -- policy_check -> provisioning (real governance or fallback) -----------

	private async handlePolicyCheck(taskId: string): Promise<TaskStepResult> {
		if (!this.governanceClient) {
			// No governance client configured — auto-authorize (backward-compatible).
			return this.applyTransition(taskId, "policy_check", "authorized", "system");
		}

		try {
			const execs = await this.store.readExecutionsForTask(taskId);
			const latest = execs[execs.length - 1];
			const meta = latest?.remoteMetadata;
			const decision = await this.governanceClient.checkAuthorization({
				taskId,
				projectId: this.config.projectId ?? "default",
				taskSpec: {
					prompt: latest?.resultSummary ?? "",
					baseRef: meta?.baseBranch,
					executionMode: latest?.executionMode,
				},
				requestedLimits: this.config.requestedLimits,
				orgId: this.config.orgId,
				executionMode: latest?.executionMode,
			});

			if (decision.decision === "authorized") {
				this.logger.info("Policy check authorized", { taskId, reason: decision.reason });
				return this.applyTransition(taskId, "policy_check", "authorized", "system", {
					governanceDecision: "authorized",
					policySnapshotId: decision.policySnapshotId,
					reason: decision.reason,
				});
			}

			this.logger.info("Policy check denied", { taskId, reason: decision.reason });
			return this.applyTransition(taskId, "policy_check", "denied", "system", {
				governanceDecision: "denied",
				reason: decision.reason,
				policySnapshotId: decision.policySnapshotId,
			});
		} catch (e) {
			// Governance client already handles fail-open/fail-closed internally,
			// but if an unexpected error escapes, log and auto-authorize.
			this.logger.error("Unexpected governance error, auto-authorizing", {
				taskId,
				error: e instanceof Error ? e.message : String(e),
			});
			return this.applyTransition(taskId, "policy_check", "authorized", "system", {
				governanceFallback: true,
			});
		}
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

			// Cast is safe: pollForReadiness only uses getInstance(), which
			// CloudInstanceFullClient provides with a compatible signature.
			const poll = await pollForReadiness(
				this.client as unknown as Parameters<typeof pollForReadiness>[0],
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
		return this.applyTransition(taskId, "provisioning", "user_cancel", "user", {
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

			// Phase 2: Start SSE log stream for real-time log consumption
			this.startLogStream(ctx, taskId, instanceId, hostname, latest?.executionId ?? ctx.executionId);

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

	// -- terminal -> teardown (A4) -------------------------------------------

	/**
	 * Handle terminal states (completed, failed, canceled).
	 * Transitions to teardown via auto_teardown trigger.
	 * PRD: Terminal states always transition to teardown then archived.
	 */
	private async handleTerminal(taskId: string, state: "completed" | "failed" | "canceled"): Promise<TaskStepResult> {
		this.logger.info("Terminal state reached, initiating teardown", { taskId, state });

		// Emit usage event before teardown (best-effort, never blocks transition)
		if (this.governanceClient) {
			try {
				const execs = await this.store.readExecutionsForTask(taskId);
				const latest = execs[execs.length - 1];
				await this.governanceClient.reportUsage({
					taskId,
					executionId: latest?.executionId,
					terminalState: state,
					executionMode: latest?.executionMode ?? "cloud_agent",
					durationSeconds: latest?.durationSeconds ?? undefined,
					tokensIn: latest?.remoteMetadata?.tokenUsage,
				});
				this.logger.info("Usage event reported", { taskId, state });
			} catch (e) {
				this.logger.warn("Usage event reporting failed (best-effort)", {
					taskId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		return this.applyTransition(taskId, state, "auto_teardown", "system");
	}

	// -- teardown -> archived (A4) -------------------------------------------

	/**
	 * Handle teardown state:
	 * - Look up the instance ID from execution metadata
	 * - If debug-preserve is enabled on a failed task, skip deletion
	 * - Otherwise, delete the cloud instance with retry/backoff
	 * - Transition to archived via sandbox_terminated
	 *
	 * PRD Section 15.11: Failure preservation rule — when debug-preserve is
	 * enabled, teardown intentionally skips instance deletion so the sandbox
	 * remains available for inspection.
	 */
	private async handleTeardown(taskId: string): Promise<TaskStepResult> {
		const execs = await this.store.readExecutionsForTask(taskId);
		const latest = execs[execs.length - 1];
		const instanceId = latest?.instanceId ?? latest?.remoteMetadata?.instanceId;
		const debugPreserve = latest?.remoteMetadata?.debugPreserve === true;
		const terminalState = latest?.terminalState;

		// Check debug-preserve mode: only applies to failed tasks
		if (debugPreserve && terminalState === "failed") {
			this.logger.info("Debug-preserve enabled, skipping instance deletion", {
				taskId,
				instanceId,
			});

			// Record that teardown was intentionally skipped
			return this.applyTransition(taskId, "teardown", "sandbox_terminated", "system", {
				teardownSkipped: true,
				debugPreserve: true,
				reason: "Debug-preserve mode: sandbox preserved for inspection",
				instanceId,
			});
		}

		// Delete the cloud instance
		if (instanceId) {
			try {
				await this.deleteInstanceWithRetry(instanceId, taskId);
				this.logger.info("Instance deleted during teardown", { taskId, instanceId });
			} catch (e) {
				// Even if all retries fail, we still transition to archived
				// to avoid leaving the task stuck in teardown forever.
				// Cloud-platform has TTL auto-cleanup as a safety net.
				this.logger.error("Teardown deletion failed after retries, proceeding to archived", {
					taskId,
					instanceId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		} else {
			this.logger.warn("No instance ID found during teardown, proceeding to archived", { taskId });
		}

		this.cleanupCtx(taskId);
		return this.applyTransition(taskId, "teardown", "sandbox_terminated", "system", {
			instanceId,
			instanceDeleted: !!instanceId,
		});
	}

	/**
	 * Delete a cloud instance with retry and exponential backoff.
	 *
	 * Handles special cases:
	 * - If instance is already terminated (404/410), treat as success
	 * - If cloud-platform is unreachable, retry with backoff
	 * - After maxRetries, throw to let the caller handle gracefully
	 */
	private async deleteInstanceWithRetry(instanceId: string, taskId: string): Promise<void> {
		const { maxRetries, baseDelayMs, maxDelayMs } = this.config.teardownConfig;
		const delayFn = this.config.teardownConfig.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				await this.client.deleteInstance(instanceId);
				return; // Success
			} catch (e) {
				lastError = e instanceof Error ? e : new Error(String(e));

				// If instance is already terminated, treat as success.
				// Cloud-platform returns 404 or 410 for terminated instances.
				if (this.isAlreadyTerminatedError(lastError)) {
					this.logger.info("Instance already terminated, treating as successful teardown", {
						taskId,
						instanceId,
						attempt,
					});
					return;
				}

				if (attempt < maxRetries) {
					const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
					this.logger.warn("Teardown delete failed, retrying", {
						taskId,
						instanceId,
						attempt: attempt + 1,
						maxRetries,
						nextRetryMs: delay,
						error: lastError.message,
					});
					await delayFn(delay);
				}
			}
		}

		throw lastError ?? new Error("Teardown delete failed after retries");
	}

	/**
	 * Determines if an error indicates the instance is already terminated.
	 * Cloud-platform returns 404 or 410 for non-existent/terminated instances.
	 */
	private isAlreadyTerminatedError(error: Error): boolean {
		// Check for CloudInstanceClientError with 404 or 410 status codes
		const errWithStatus = error as Error & { statusCode?: number };
		if (errWithStatus.statusCode === 404 || errWithStatus.statusCode === 410) {
			return true;
		}
		// Heuristic: check message for common indicators
		const msg = error.message.toLowerCase();
		return msg.includes("not found") || msg.includes("already terminated") || msg.includes("gone");
	}

	// -- cancellation --------------------------------------------------------

	/**
	 * Apply cancellation from any pre-terminal state via `user_cancel`.
	 *
	 * P2-1: Cancel always transitions to `canceled` state, regardless of
	 * which pre-terminal state the task is in. This provides deterministic
	 * cancel behavior per PRD Section 6.2.
	 *
	 * If an instance exists, triggers DELETE /instances/{id} immediately.
	 */
	private async applyCancellation(taskId: string, state: CloudExecutionState): Promise<TaskStepResult | null> {
		this.cleanupCtx(taskId);

		// Validate that user_cancel is valid from the current state
		const validation = validateCloudExecutionTransition(state, "user_cancel");
		if (!validation.valid) {
			this.logger.warn("Cannot cancel from current state", { taskId, state, reason: validation.reason });
			return null;
		}

		// Delete instance if one exists (fire-and-forget best-effort)
		const execs = await this.store.readExecutionsForTask(taskId);
		const latest = execs[execs.length - 1];
		const instanceId = latest?.instanceId ?? latest?.remoteMetadata?.instanceId;
		if (instanceId) {
			try {
				await this.client.deleteInstance(instanceId);
				this.logger.info("Instance deleted on cancel", { taskId, instanceId });
			} catch (e) {
				this.logger.warn("Instance deletion failed on cancel (best-effort)", {
					taskId,
					instanceId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		return this.applyTransition(taskId, state, "user_cancel", "user", { cancelledByUser: true });
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

		// Emit audit event on key lifecycle transitions (best-effort, fire-and-forget)
		if (this.governanceClient) {
			this.governanceClient
				.reportAudit({
					taskId,
					eventType: "lifecycle_transition",
					fromState: result.from,
					toState: result.to,
					trigger,
					triggerSource,
					timestamp: event.timestamp,
					metadata,
				})
				.catch((e) => {
					this.logger.warn("Audit event reporting failed (best-effort)", {
						taskId,
						error: e instanceof Error ? e.message : String(e),
					});
				});
		}

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
			// Phase 2: Disconnect SSE log stream before aborting
			if (ctx.logStreamClient?.isActive) {
				ctx.logStreamClient.disconnect();
				this.logger.info("Log stream disconnected", { taskId });
			}
			ctx.abortController.abort();
			this.activeTasks.delete(taskId);
		}
	}

	// -- Phase 2: log stream management --------------------------------------

	/**
	 * Start an SSE log stream for a task after /run is accepted.
	 * The stream client is stored on the TaskContext for lifecycle tracking.
	 * Entries are persisted via the log store; errors are logged for observability.
	 */
	private startLogStream(
		ctx: TaskContext,
		taskId: string,
		instanceId: string,
		hostname: string,
		executionId: string,
	): void {
		if (!this.logStore) return; // No log store configured — skip

		const client = this.logStreamFactory.create({
			hostname,
			executionId,
			taskId,
			callbacks: {
				onEntry: (entry) => {
					this.logStore?.append(taskId, entry);
				},
				onConnectionStateChange: (state) => {
					this.logger.info("Log stream connection state", {
						taskId,
						instanceId,
						state,
					});
				},
				onError: (error, recoverable) => {
					if (recoverable) {
						this.logger.warn("Log stream transient error", {
							taskId,
							instanceId,
							error: error.message,
						});
					} else {
						this.logger.error("Log stream fatal error", {
							taskId,
							instanceId,
							error: error.message,
						});
					}
				},
			},
		});

		ctx.logStreamClient = client;

		// Connect async — don't block the /run acceptance
		client.connect().catch((e) => {
			this.logger.error("Log stream connect failed", {
				taskId,
				error: e instanceof Error ? e.message : String(e),
			});
		});
	}
}
