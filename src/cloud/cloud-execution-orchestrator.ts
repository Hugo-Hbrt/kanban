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
import { buildExecutionCreateRequest } from "./cloud-execution-contracts";
import type { ExecutionStatusResponse } from "./cloud-execution-contracts";
import type { CloudPlatformExecutionClient } from "./cloud-platform-execution-client";
import {
	type ExecutionPollingConfig,
	DEFAULT_EXECUTION_POLLING_CONFIG,
	isTerminalExecutionStatus,
	pollExecutionStatus,
} from "./cloud-platform-execution-client";

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
// (Legacy interfaces removed — KB-AUTH-3)
// Direct runner invocation, instance provisioning, and callback interfaces
// have been replaced by CloudPlatformExecutionClient.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestrator Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	readonly tickIntervalMs: number;
	readonly pollingConfig: ExecutionPollingConfig;
	readonly projectId?: string;
	readonly orgId?: string;
	readonly userId?: string;
	readonly defaultTaskSpec?: { type: string; image: string; tools?: string[] };
	readonly requestedLimits?: { maxComputeSeconds: number; maxTokenBudget: number };
	readonly defaultMaxCostUsd?: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: Readonly<OrchestratorConfig> = {
	tickIntervalMs: 5_000,
	pollingConfig: DEFAULT_EXECUTION_POLLING_CONFIG,
};

// ---------------------------------------------------------------------------
// Task Context (per in-flight task)
// ---------------------------------------------------------------------------

interface TaskContext {
	readonly taskId: string;
	executionId: string;
	/** Cloud-platform execution ID (returned by POST /api/v1/executions). */
	cloudExecutionId?: string;
	cancelRequested: boolean;
	abortController: AbortController;
	/** Tracks whether execution has been created on cloud-platform. */
	executionCreated?: boolean;
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
	private readonly executionClient: CloudPlatformExecutionClient;
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
		executionClient: CloudPlatformExecutionClient,
		config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
		logger: OrchestratorLogger = noopLogger,
		concurrencyLimiter?: ConcurrencyLimiterExtension | null,
		governanceClient?: GovernanceClient | null,
		logStore?: CloudExecutionLogStoreInterface | null,
		logStreamFactory?: LogStreamClientFactory | null,
	) {
		this.store = store;
		this.executionClient = executionClient;
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
				// KB-AUTH-3: provisioning is now handled by cloud-platform.
				// If we see this state (e.g. from a persisted event), transition
				// directly to running by creating the execution on cloud-platform.
				return this.handleCreateExecution(taskId);
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

	// -- policy_check -> provisioning (governance required) -------------------

	private async handlePolicyCheck(taskId: string): Promise<TaskStepResult> {
		if (!this.governanceClient) {
			this.logger.warn("Governance client not configured — auto-approving for development", { taskId });
			return this.applyTransition(taskId, "policy_check", "authorized", "system", {
				governanceDecision: "authorized",
				reason: "governance bypassed — no governance client configured (development mode)",
			});
		}

		try {
			const execs = await this.store.readExecutionsForTask(taskId);
			const latest = execs[execs.length - 1];
			const meta = latest?.remoteMetadata;
			const executionMode = latest?.executionMode ?? "cloud_agent";
			const decision = await this.governanceClient.checkAuthorization({
				taskId,
				orgId: this.config.orgId ?? "",
				userId: this.config.userId ?? "",
				projectId: this.config.projectId ?? "default",
				executionMode,
				taskSpec: this.config.defaultTaskSpec ?? { type: "cline-task", image: "cline-runner:latest" },
				requestedLimits: this.config.requestedLimits ?? { maxComputeSeconds: 1800, maxTokenBudget: 100_000 },
				executionContext: {
					repoUrl: meta?.repoUrl ?? "",
					baseBranch: meta?.baseBranch ?? "",
					featureBranchIntent: meta?.featureBranch ?? "",
					worktreeIntent: meta?.worktreePath ?? "",
				},
			});

			if (decision.decision === "authorized") {
				this.logger.info("Policy check authorized", { taskId, reason: decision.reason });

				// Reserve budget before provisioning (PRD §9.3 D2)
				let reservationId: string | undefined;
				try {
					const limits = this.config.requestedLimits ?? { maxComputeSeconds: 1800, maxTokenBudget: 100_000 };
					const reservation = await this.governanceClient.reserveBudget({
						taskId,
						orgId: this.config.orgId ?? "",
						maxComputeSeconds: limits.maxComputeSeconds,
						maxTokenBudget: limits.maxTokenBudget,
						maxCostUsd: this.config.defaultMaxCostUsd ?? 10.0,
						executionMode,
					});
					reservationId = reservation.reservationId;
					this.logger.info("Budget reserved", { taskId, reservationId, expiresAt: reservation.expiresAt });
				} catch (e) {
					this.logger.warn("Budget reservation failed, proceeding without reservation", {
						taskId,
						error: e instanceof Error ? e.message : String(e),
					});
				}

				return this.applyTransition(taskId, "policy_check", "authorized", "system", {
					governanceDecision: "authorized",
					policySnapshotId: decision.policySnapshotId,
					reason: decision.reason,
					reservationId,
				});
			}

			this.logger.info("Policy check denied", { taskId, reason: decision.reason });
			return this.applyTransition(taskId, "policy_check", "denied", "system", {
				governanceDecision: "denied",
				reason: decision.reason,
				policySnapshotId: decision.policySnapshotId,
			});
		} catch (e) {
			this.logger.error("Unexpected governance error, denying execution", {
				taskId,
				error: e instanceof Error ? e.message : String(e),
			});
			return this.applyTransition(taskId, "policy_check", "denied", "system", {
				governanceDecision: "denied",
				reason: `governance error: ${e instanceof Error ? e.message : String(e)}`,
				governanceError: true,
			});
		}
	}

	// -- provisioning -> running (create execution on cloud-platform) --------
	// KB-AUTH-3: Kanban no longer provisions instances directly.
	// Instead, we create an execution on cloud-platform which handles
	// provisioning, runner setup, and /run invocation internally.

	private async handleCreateExecution(taskId: string): Promise<TaskStepResult> {
		const ctx = this.getOrCreateCtx(taskId);
		if (ctx.cancelRequested) {
			this.cleanupCtx(taskId);
			this.pendingCancellations.delete(taskId);
			return this.applyTransition(taskId, "provisioning", "user_cancel", "user", {
				cancelledDuringProvisioning: true,
			});
		}

		try {
			const execs = await this.store.readExecutionsForTask(taskId);
			const latest = execs[execs.length - 1];
			const meta = latest?.remoteMetadata;

			// Fallback: read repoUrl/baseRef from the submit event
			let eventRepoUrl = "";
			let eventBaseRef = "main";
			if (!meta?.repoUrl) {
				const events = await this.store.readEventsForTask(taskId);
				for (let i = events.length - 1; i >= 0; i--) {
					const evt = events[i];
					if (evt?.trigger === "submit" && evt.metadata) {
						eventRepoUrl = (evt.metadata.repoUrl as string) ?? "";
						eventBaseRef = (evt.metadata.baseRef as string) ?? "main";
						break;
					}
				}
			}

			const attemptNumber = latest?.attemptNumber ?? 1;
			const worktreeIntent = latest?.worktreeIntent ?? meta?.worktreePath ?? `${taskId}/attempt-${attemptNumber}`;

			const request = buildExecutionCreateRequest({
				taskId,
				attemptNumber,
				orgId: this.config.orgId ?? "",
				projectId: this.config.projectId ?? "default",
				userId: this.config.userId ?? "",
				repoUrl: meta?.repoUrl ?? eventRepoUrl,
				baseBranch: meta?.baseBranch ?? eventBaseRef,
				featureBranchIntent: meta?.featureBranch ?? "",
				worktreeIntent,
			});

			const createResponse = await this.executionClient.createExecution(request, ctx.abortController.signal);
			ctx.cloudExecutionId = createResponse.executionId;
			ctx.executionCreated = true;

			if (latest) {
				await this.store.updateExecution(latest.executionId, {
					instanceId: createResponse.executionId,
					startedAt: new Date().toISOString(),
					remoteMetadata: {
						...(meta ?? {
							instanceId: createResponse.executionId,
							repoUrl: request.repoUrl,
							baseBranch: request.baseBranch,
						}),
						instanceId: createResponse.executionId,
					},
				});
			}

			this.logger.info("Execution created on cloud-platform", {
				taskId,
				cloudExecutionId: createResponse.executionId,
				status: createResponse.status,
			});

			return this.applyTransition(taskId, "provisioning", "sandbox_ready", "system", {
				cloudExecutionId: createResponse.executionId,
			});
		} catch (e) {
			if (ctx.cancelRequested) {
				this.cleanupCtx(taskId);
				this.pendingCancellations.delete(taskId);
				return this.applyTransition(taskId, "provisioning", "user_cancel", "user", {
					cancelledDuringProvisioning: true,
				});
			}
			this.logger.error("Execution creation failed", {
				taskId,
				error: e instanceof Error ? e.message : String(e),
			});
			this.cleanupCtx(taskId);
			return this.applyTransition(taskId, "provisioning", "provision_timeout", "system", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// -- running -> poll cloud-platform for terminal state -------------------
	// KB-AUTH-3: Instead of invoking /run on the runner and waiting for
	// callbacks, we poll cloud-platform's GET /api/v1/executions/{id} endpoint.

	private async handleRunning(taskId: string): Promise<TaskStepResult | null> {
		const ctx = this.getOrCreateCtx(taskId);

		if (ctx.cancelRequested) {
			// Cancel the execution on cloud-platform
			if (ctx.cloudExecutionId) {
				try {
					await this.executionClient.cancelExecution(ctx.cloudExecutionId, ctx.abortController.signal);
				} catch (e) {
					this.logger.warn("Cancel execution failed (best-effort)", {
						taskId,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
			return this.applyTransition(taskId, "running", "user_cancel", "user");
		}

		// Resolve cloudExecutionId from persisted execution metadata if not in context
		if (!ctx.cloudExecutionId) {
			const execs = await this.store.readExecutionsForTask(taskId);
			const latest = execs[execs.length - 1];
			ctx.cloudExecutionId = latest?.instanceId ?? latest?.remoteMetadata?.instanceId;
		}

		if (!ctx.cloudExecutionId) {
			this.logger.error("No cloud execution ID found for running task", { taskId });
			this.cleanupCtx(taskId);
			return this.applyTransition(taskId, "running", "execution_error", "system", {
				error: "No cloud execution ID — cannot poll status",
			});
		}

		try {
			const statusResponse = await this.executionClient.getExecutionStatus(
				ctx.cloudExecutionId,
				ctx.abortController.signal,
			);

			this.logger.info("Execution status polled", {
				taskId,
				cloudExecutionId: ctx.cloudExecutionId,
				status: statusResponse.status,
			});

			if (!isTerminalExecutionStatus(statusResponse.status)) {
				return null; // Still running — no state change
			}

			// Map cloud-platform terminal status to lifecycle triggers
			if (statusResponse.status === "succeeded") {
				const result = statusResponse.result;
				return this.applyTransition(taskId, "running", "task_complete", "system", {
					cloudExecutionId: ctx.cloudExecutionId,
					resultStatus: "success",
					summary: result?.summary,
					exitCode: result?.exitCode,
				});
			}

			if (statusResponse.status === "canceled") {
				return this.applyTransition(taskId, "running", "user_cancel", "system", {
					cloudExecutionId: ctx.cloudExecutionId,
					cancelledByPlatform: true,
				});
			}

			// failed
			const error = statusResponse.error;
			return this.applyTransition(taskId, "running", "execution_error", "system", {
				cloudExecutionId: ctx.cloudExecutionId,
				errorCode: error?.code,
				error: error?.message ?? "Execution failed",
			});
		} catch (e) {
			if (ctx.cancelRequested) {
				return this.applyTransition(taskId, "running", "user_cancel", "user");
			}
			// Transient polling errors — will retry on next tick
			this.logger.warn("Execution status poll error (will retry)", {
				taskId,
				cloudExecutionId: ctx.cloudExecutionId,
				error: e instanceof Error ? e.message : String(e),
			});
			return null;
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
				const meta = latest?.remoteMetadata;
				const reservationId = await this.findReservationId(taskId);
				await this.governanceClient.reportUsage({
					taskId,
					orgId: this.config.orgId ?? "",
					userId: this.config.userId ?? "",
					executionMode: latest?.executionMode ?? "cloud_agent",
					cpuSeconds: latest?.durationSeconds ?? 0,
					tokensIn: meta?.tokenUsage,
					reservationId,
					executionContext: {
						repoUrl: meta?.repoUrl ?? "",
						baseBranch: meta?.baseBranch ?? "",
						featureBranchIntent: meta?.featureBranch ?? "",
						worktreeIntent: meta?.worktreePath ?? "",
					},
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
	// KB-AUTH-3: Cloud-platform handles instance lifecycle and cleanup.
	// Kanban teardown is now lightweight — just transition to archived.

	private async handleTeardown(taskId: string): Promise<TaskStepResult> {
		this.logger.info("Teardown: transitioning to archived (cloud-platform handles cleanup)", { taskId });
		this.cleanupCtx(taskId);
		return this.applyTransition(taskId, "teardown", "sandbox_terminated", "system", {
			cloudPlatformManagedCleanup: true,
		});
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

		// Cancel execution on cloud-platform (fire-and-forget best-effort)
		const ctx = this.activeTasks.get(taskId);
		const execs = await this.store.readExecutionsForTask(taskId);
		const latest = execs[execs.length - 1];
		const cloudExecutionId = ctx?.cloudExecutionId ?? latest?.instanceId ?? latest?.remoteMetadata?.instanceId;
		if (cloudExecutionId) {
			try {
				await this.executionClient.cancelExecution(cloudExecutionId);
				this.logger.info("Execution cancelled on cloud-platform", { taskId, cloudExecutionId });
			} catch (e) {
				this.logger.warn("Execution cancellation failed (best-effort)", {
					taskId,
					cloudExecutionId,
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
					actor: { type: triggerSource === "user" ? "user" : "system", id: this.config.userId ?? "system" },
					action: `task.${trigger}`,
					resource: { type: "task", id: taskId },
					result: result.to === "failed" || result.to === "canceled" ? "failure" : "success",
					taskId,
					orgId: this.config.orgId,
					userId: this.config.userId,
					projectId: this.config.projectId,
					metadata: {
						executionMode: metadata?.executionMode as string | undefined,
						repoUrl: metadata?.repoUrl as string | undefined,
						baseBranch: metadata?.baseBranch as string | undefined,
						featureBranchIntent: metadata?.featureBranch as string | undefined,
						policySnapshotId: metadata?.policySnapshotId as string | undefined,
					},
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

	/**
	 * Find the reservationId from the policy_check → provisioning event metadata.
	 * Scans task events for the `authorized` trigger where reservationId was stored.
	 */
	private async findReservationId(taskId: string): Promise<string | undefined> {
		const events = await this.store.readEventsForTask(taskId);
		for (let i = events.length - 1; i >= 0; i--) {
			const evt = events[i];
			if (evt?.trigger === "authorized" && evt.metadata?.reservationId) {
				return evt.metadata.reservationId as string;
			}
		}
		return undefined;
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
