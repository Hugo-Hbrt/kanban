// ---------------------------------------------------------------------------
// Cloud Execution Persistence — A2
// @phase MVP (core schemas + store); Phase 2 fields in schema are optional
// @prd-section 7, 15.7
//
// Phase boundary:
//   MVP: CloudExecutionStore, PersistedTaskEvent, PersistedTaskExecution
//        (core fields only), executionMode, remoteExecutionMetadata
//   Phase 2+ (forward-compatible in schema):
//     - attemptTriggerSchema values: retry, replay, rerun_snapshot
//     - persistedTriggerMetadataSchema (audit for retry/replay)
//     - Enriched execution fields: trigger, triggerMetadata, errorDetails,
//       hostname, cloudState, promptHash, promptVersion, branchIntent,
//       worktreeIntent, startingCommitSha, durationSeconds, tokenUsage,
//       teardownDecision, teardownCompletedAt
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import {
	type CloudExecutionState,
	cloudExecutionEventSchema,
	cloudExecutionStateSchema,
	deriveCurrentState,
} from "./cloud-execution-lifecycle";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUD_EXECUTIONS_DIR = "cloud-executions";
const TASK_EVENTS_FILENAME = "task-events.json";
const TASK_EXECUTIONS_FILENAME = "task-executions.json";

// ---------------------------------------------------------------------------
// Execution Mode
// ---------------------------------------------------------------------------

export const executionModeSchema = z.enum(["local_agent", "cloud_agent"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

// ---------------------------------------------------------------------------
// Event Trigger Source
// ---------------------------------------------------------------------------

export const eventTriggerSourceSchema = z.enum(["user", "system", "callback"]);
export type EventTriggerSource = z.infer<typeof eventTriggerSourceSchema>;

// ---------------------------------------------------------------------------
// Task Event (persisted shape)
// ---------------------------------------------------------------------------

export const persistedTaskEventSchema = cloudExecutionEventSchema.extend({
	triggerSource: eventTriggerSourceSchema,
	metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PersistedTaskEvent = z.infer<typeof persistedTaskEventSchema>;

// ---------------------------------------------------------------------------
// Remote Execution Metadata
// ---------------------------------------------------------------------------

export const remoteExecutionMetadataSchema = z.object({
	instanceId: z.string().min(1),
	instanceHostname: z.string().optional(),
	instanceStatus: z.string().optional(),
	repoUrl: z.string().min(1),
	baseBranch: z.string().min(1),
	featureBranch: z.string().optional(),
	worktreePath: z.string().optional(),
	startingCommitSha: z.string().optional(),
	promptHash: z.string().optional(),
	promptVersion: z.string().optional(),
	callbackUrl: z.string().optional(),
	callbackReceivedAt: z.string().optional(),
	debugPreserve: z.boolean().optional(),
	executionDurationSeconds: z.number().nonnegative().optional(),
	tokenUsage: z.number().int().nonnegative().optional(),
});
export type RemoteExecutionMetadata = z.infer<typeof remoteExecutionMetadataSchema>;

// ---------------------------------------------------------------------------
// Canonical Fields Snapshot
// ---------------------------------------------------------------------------

/**
 * The canonical identity-critical fields that define an execution's
 * relationship to its original dispatch intent.
 *
 * **Invariant: Kanban is the source of truth for execution intent.**
 * Cloud-platform and task-runner are consumers, not authors, of these
 * canonical fields. After dispatch, these fields are read-only —
 * callback ingestion, reconciliation, and other post-dispatch operations
 * must never overwrite them. Only the initial dispatch (or explicit
 * inheritance during retry/replay/rerun) may set these values.
 *
 * @see canonicalFieldsSnapshot — extracts these fields for comparison
 */
export interface CanonicalFieldsSnapshot {
	readonly repoUrl: string | undefined;
	readonly baseBranch: string | undefined;
	readonly featureBranch: string | undefined;
	readonly worktreePath: string | undefined;
	readonly startingCommitSha: string | undefined;
	readonly promptHash: string | undefined;
}

/**
 * Extract the identity-critical canonical fields from an execution record
 * for easy comparison across lifecycle phases.
 *
 * These fields must be immutable after dispatch:
 * - `repoUrl`:           Repository this execution targets
 * - `baseBranch`:        Base branch for the execution
 * - `featureBranch`:     Feature branch (if set at dispatch)
 * - `worktreePath`:      Worktree path (deterministic from taskId+attempt)
 * - `startingCommitSha`: Git commit SHA at execution start
 * - `promptHash`:        Hash of the prompt used for this execution
 *
 * **Invariant: Kanban is the source of truth for execution intent.**
 * Cloud-platform and task-runner are consumers, not authors, of these
 * canonical fields.
 */
export function canonicalFieldsSnapshot(execution: PersistedTaskExecution): CanonicalFieldsSnapshot {
	const meta = execution.remoteMetadata;
	return {
		repoUrl: meta?.repoUrl,
		baseBranch: meta?.baseBranch,
		featureBranch: meta?.featureBranch,
		worktreePath: meta?.worktreePath,
		startingCommitSha: meta?.startingCommitSha ?? execution.startingCommitSha,
		promptHash: meta?.promptHash ?? execution.promptHash,
	};
}

/**
 * Detect drift between two canonical field snapshots.
 *
 * Returns a list of fields that differ. An empty array means no drift.
 * This is used by callback ingestion and reconciliation to assert that
 * canonical fields are not inadvertently overwritten.
 *
 * **Invariant: Kanban is the source of truth for execution intent.**
 */
export function detectCanonicalFieldDrift(
	before: CanonicalFieldsSnapshot,
	after: CanonicalFieldsSnapshot,
): readonly string[] {
	const driftedFields: string[] = [];
	const fields: (keyof CanonicalFieldsSnapshot)[] = [
		"repoUrl",
		"baseBranch",
		"featureBranch",
		"worktreePath",
		"startingCommitSha",
		"promptHash",
	];
	for (const field of fields) {
		if (before[field] !== after[field]) {
			driftedFields.push(field);
		}
	}
	return driftedFields;
}

// ---------------------------------------------------------------------------
// Attempt Trigger Type
// @phase Phase2 (P2-2, P3-2) — retry/replay/rerun_snapshot are Phase 2+ triggers.
//        MVP uses only `initial`. Schema includes all values for forward-compat.
// ---------------------------------------------------------------------------

/**
 * Describes how an execution attempt was triggered.
 *   - `initial`:          First execution of the task (MVP)
 *   - `retry`:            Automatic or user-initiated retry of a failed/canceled attempt (Phase 2, P2-2)
 *   - `replay`:           Deterministic re-execution with pinned snapshot context (Phase 2, P2-2)
 *   - `rerun_snapshot`:   Re-execution from a specific prior attempt snapshot (Phase 3, P3-2)
 */
export const attemptTriggerSchema = z.enum(["initial", "retry", "replay", "rerun_snapshot"]);
export type AttemptTrigger = z.infer<typeof attemptTriggerSchema>;

// ---------------------------------------------------------------------------
// Attempt Trigger Metadata (persisted)
// ---------------------------------------------------------------------------

/**
 * Audit metadata for retry/replay triggers, persisted alongside the execution.
 * Captures who triggered the attempt, why, and what snapshot context was used.
 */
export const persistedTriggerMetadataSchema = z.object({
	triggeredBy: z.string().min(1),
	reason: z.string().optional(),
	triggeredAt: z.string().min(1),
	sourceState: z.string().optional(),
	previousExecutionId: z.string().optional(),
	previousAttemptNumber: z.number().int().positive().optional(),
	branchIntent: z.string().optional(),
	pinnedCommitSha: z.string().optional(),
	pinnedPromptVersion: z.string().optional(),
});
export type PersistedTriggerMetadata = z.infer<typeof persistedTriggerMetadataSchema>;

// ---------------------------------------------------------------------------
// Teardown Decision
// ---------------------------------------------------------------------------

/**
 * Describes how teardown was decided for a terminal execution.
 *   - `auto`:            Automatic teardown on completion/failure/cancel
 *   - `debug-preserve`:  Sandbox preserved for debugging (PRD 15.11)
 *   - `manual`:          Operator-initiated manual teardown
 */
export const teardownDecisionSchema = z.enum(["auto", "debug-preserve", "manual"]);
export type TeardownDecision = z.infer<typeof teardownDecisionSchema>;

// ---------------------------------------------------------------------------
// Task Execution (persisted shape)
// ---------------------------------------------------------------------------

export const persistedTaskExecutionSchema = z.object({
	executionId: z.string().min(1),
	taskId: z.string().min(1),
	attemptNumber: z.number().int().positive(),
	instanceId: z.string().optional(),
	executionMode: executionModeSchema,
	createdAt: z.string().min(1),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	terminalState: cloudExecutionStateSchema.optional(),
	resultSummary: z.string().optional(),
	remoteMetadata: remoteExecutionMetadataSchema.optional(),

	// --- Phase 2+ enriched attempt detail ---
	// @phase Phase2 — These optional fields are NOT used by MVP code paths.
	// MVP only writes: executionId, taskId, attemptNumber, executionMode,
	// createdAt, startedAt, completedAt, terminalState, resultSummary,
	// instanceId, remoteMetadata. All Phase 2 fields are .optional() and
	// default to undefined. Schema includes them for forward-compatibility;
	// MVP readers must not depend on their presence.

	/** @phase Phase2 (P2-2) — How this attempt was triggered (initial / retry / replay). */
	trigger: attemptTriggerSchema.optional(),

	/** @phase Phase2 (P2-2) — Audit metadata for retry/replay triggers. */
	triggerMetadata: persistedTriggerMetadataSchema.optional(),

	/** @phase Phase2 — Structured error details (separate from resultSummary). */
	errorDetails: z.string().optional(),

	/** @phase Phase2 — Hostname of the cloud instance for this attempt. */
	hostname: z.string().optional(),

	/** @phase Phase2 — Cloud instance state at time of last observation. */
	cloudState: z.string().optional(),

	/** @phase Phase2 — Top-level prompt hash for this attempt. */
	promptHash: z.string().optional(),

	/** @phase Phase2 — Top-level prompt version for this attempt. */
	promptVersion: z.string().optional(),

	/** @phase Phase2 (P2-2, P3-2) — Branch intent for this attempt. */
	branchIntent: z.string().optional(),

	/** @phase Phase2 (P2-2, P3-2) — Worktree intent / path for this attempt. */
	worktreeIntent: z.string().optional(),

	/** @phase Phase2 (P2-2, P3-2) — Git commit SHA at the start of this attempt. */
	startingCommitSha: z.string().optional(),

	/** @phase Phase2 (P2-5) — Duration in seconds (startedAt to completedAt). */
	durationSeconds: z.number().nonnegative().optional(),

	/** @phase Phase2 (P2-5) — Token usage for this attempt. */
	tokenUsage: z.number().int().nonnegative().optional(),

	/** @phase Phase2 — Teardown decision for this attempt. */
	teardownDecision: teardownDecisionSchema.optional(),

	/** @phase Phase2 — When teardown completed for this attempt. */
	teardownCompletedAt: z.string().optional(),
});
export type PersistedTaskExecution = z.infer<typeof persistedTaskExecutionSchema>;

// ---------------------------------------------------------------------------
// Persisted File Schemas (top-level file shapes)
// ---------------------------------------------------------------------------

const taskEventsFileSchema = z.object({
	version: z.literal(1),
	events: z.array(persistedTaskEventSchema),
});
type TaskEventsFile = z.infer<typeof taskEventsFileSchema>;

const taskExecutionsFileSchema = z.object({
	version: z.literal(1),
	executions: z.array(persistedTaskExecutionSchema),
});
type TaskExecutionsFile = z.infer<typeof taskExecutionsFileSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEmptyEventsFile(): TaskEventsFile {
	return { version: 1, events: [] };
}

function createEmptyExecutionsFile(): TaskExecutionsFile {
	return { version: 1, executions: [] };
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

function parsePersistedFile<T>(path: string, raw: unknown | null, schema: z.ZodType<T>, defaultValue: T): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		throw new Error(`Invalid persistence file at ${path}. Validation errors: ${issues}`);
	}
	return parsed.data;
}

// ---------------------------------------------------------------------------
// Duplicate Event Error
// ---------------------------------------------------------------------------

/**
 * Thrown when an event with the same eventId already exists in the store.
 */
export class DuplicateEventError extends Error {
	readonly eventId: string;

	constructor(eventId: string) {
		super(`Duplicate event rejected: eventId "${eventId}" already exists.`);
		this.name = "DuplicateEventError";
		this.eventId = eventId;
	}
}

// ---------------------------------------------------------------------------
// CloudExecutionStore
// ---------------------------------------------------------------------------

/**
 * Persistent store for cloud execution events, execution attempts, and
 * remote execution metadata.
 *
 * Data is stored as JSON files inside a workspace's `cloud-executions/`
 * directory, using the same atomic-write and file-locking patterns as
 * the existing Kanban workspace persistence layer.
 *
 * The store is stateless between calls — all reads go to disk, making
 * it safe across Kanban restarts.
 */
export class CloudExecutionStore {
	private readonly storePath: string;
	private readonly eventsPath: string;
	private readonly executionsPath: string;

	constructor(workspaceStatePath: string) {
		this.storePath = join(workspaceStatePath, CLOUD_EXECUTIONS_DIR);
		this.eventsPath = join(this.storePath, TASK_EVENTS_FILENAME);
		this.executionsPath = join(this.storePath, TASK_EXECUTIONS_FILENAME);
	}

	private getEventsLockRequest(): LockRequest {
		return { path: this.eventsPath, type: "file" };
	}

	private getExecutionsLockRequest(): LockRequest {
		return { path: this.executionsPath, type: "file" };
	}

	// --- Events: read ---

	async readEvents(): Promise<readonly PersistedTaskEvent[]> {
		const raw = await readJsonFile(this.eventsPath);
		const file = parsePersistedFile(this.eventsPath, raw, taskEventsFileSchema, createEmptyEventsFile());
		return file.events;
	}

	async readEventsForTask(taskId: string): Promise<readonly PersistedTaskEvent[]> {
		const events = await this.readEvents();
		return events.filter((e) => e.taskId === taskId);
	}

	async deriveTaskState(taskId: string): Promise<CloudExecutionState> {
		const events = await this.readEventsForTask(taskId);
		return deriveCurrentState(events);
	}

	// --- Events: append ---

	async appendEvent(event: PersistedTaskEvent): Promise<void> {
		const validated = persistedTaskEventSchema.parse(event);

		await lockedFileSystem.withLock(this.getEventsLockRequest(), async () => {
			const raw = await readJsonFile(this.eventsPath);
			const file = parsePersistedFile(this.eventsPath, raw, taskEventsFileSchema, createEmptyEventsFile());

			const existingIds = new Set(file.events.map((e) => e.eventId));
			if (existingIds.has(validated.eventId)) {
				throw new DuplicateEventError(validated.eventId);
			}

			const updatedFile: TaskEventsFile = {
				...file,
				events: [...file.events, validated],
			};

			await lockedFileSystem.writeJsonFileAtomic(this.eventsPath, updatedFile, { lock: null });
		});
	}

	async appendEvents(events: readonly PersistedTaskEvent[]): Promise<void> {
		if (events.length === 0) {
			return;
		}
		const validated = events.map((e) => persistedTaskEventSchema.parse(e));

		await lockedFileSystem.withLock(this.getEventsLockRequest(), async () => {
			const raw = await readJsonFile(this.eventsPath);
			const file = parsePersistedFile(this.eventsPath, raw, taskEventsFileSchema, createEmptyEventsFile());

			const existingIds = new Set(file.events.map((e) => e.eventId));
			for (const event of validated) {
				if (existingIds.has(event.eventId)) {
					throw new DuplicateEventError(event.eventId);
				}
				existingIds.add(event.eventId);
			}

			const updatedFile: TaskEventsFile = {
				...file,
				events: [...file.events, ...validated],
			};

			await lockedFileSystem.writeJsonFileAtomic(this.eventsPath, updatedFile, { lock: null });
		});
	}

	// --- Executions: read ---

	async readExecutions(): Promise<readonly PersistedTaskExecution[]> {
		const raw = await readJsonFile(this.executionsPath);
		const file = parsePersistedFile(this.executionsPath, raw, taskExecutionsFileSchema, createEmptyExecutionsFile());
		return file.executions;
	}

	async readExecutionsForTask(taskId: string): Promise<readonly PersistedTaskExecution[]> {
		const executions = await this.readExecutions();
		return executions.filter((e) => e.taskId === taskId).sort((a, b) => a.attemptNumber - b.attemptNumber);
	}

	async readExecution(executionId: string): Promise<PersistedTaskExecution | null> {
		const executions = await this.readExecutions();
		return executions.find((e) => e.executionId === executionId) ?? null;
	}

	// --- Executions: write ---

	async createExecution(execution: PersistedTaskExecution): Promise<void> {
		const validated = persistedTaskExecutionSchema.parse(execution);

		await lockedFileSystem.withLock(this.getExecutionsLockRequest(), async () => {
			const raw = await readJsonFile(this.executionsPath);
			const file = parsePersistedFile(
				this.executionsPath,
				raw,
				taskExecutionsFileSchema,
				createEmptyExecutionsFile(),
			);

			const existingIds = new Set(file.executions.map((e) => e.executionId));
			if (existingIds.has(validated.executionId)) {
				throw new Error(`Execution with id "${validated.executionId}" already exists.`);
			}

			const updatedFile: TaskExecutionsFile = {
				...file,
				executions: [...file.executions, validated],
			};

			await lockedFileSystem.writeJsonFileAtomic(this.executionsPath, updatedFile, { lock: null });
		});
	}

	async updateExecution(
		executionId: string,
		updates: Partial<
			Pick<
				PersistedTaskExecution,
				| "instanceId"
				| "startedAt"
				| "completedAt"
				| "terminalState"
				| "resultSummary"
				| "remoteMetadata"
				| "trigger"
				| "triggerMetadata"
				| "errorDetails"
				| "hostname"
				| "cloudState"
				| "promptHash"
				| "promptVersion"
				| "branchIntent"
				| "worktreeIntent"
				| "startingCommitSha"
				| "durationSeconds"
				| "tokenUsage"
				| "teardownDecision"
				| "teardownCompletedAt"
			>
		>,
	): Promise<boolean> {
		let found = false;

		await lockedFileSystem.withLock(this.getExecutionsLockRequest(), async () => {
			const raw = await readJsonFile(this.executionsPath);
			const file = parsePersistedFile(
				this.executionsPath,
				raw,
				taskExecutionsFileSchema,
				createEmptyExecutionsFile(),
			);

			const updatedExecutions = file.executions.map((execution) => {
				if (execution.executionId !== executionId) {
					return execution;
				}
				found = true;
				const merged: PersistedTaskExecution = { ...execution };
				if (updates.instanceId !== undefined) merged.instanceId = updates.instanceId;
				if (updates.startedAt !== undefined) merged.startedAt = updates.startedAt;
				if (updates.completedAt !== undefined) merged.completedAt = updates.completedAt;
				if (updates.terminalState !== undefined) merged.terminalState = updates.terminalState;
				if (updates.resultSummary !== undefined) merged.resultSummary = updates.resultSummary;
				if (updates.remoteMetadata !== undefined) merged.remoteMetadata = updates.remoteMetadata;
				// Phase 2 fields
				if (updates.trigger !== undefined) merged.trigger = updates.trigger;
				if (updates.triggerMetadata !== undefined) merged.triggerMetadata = updates.triggerMetadata;
				if (updates.errorDetails !== undefined) merged.errorDetails = updates.errorDetails;
				if (updates.hostname !== undefined) merged.hostname = updates.hostname;
				if (updates.cloudState !== undefined) merged.cloudState = updates.cloudState;
				if (updates.promptHash !== undefined) merged.promptHash = updates.promptHash;
				if (updates.promptVersion !== undefined) merged.promptVersion = updates.promptVersion;
				if (updates.branchIntent !== undefined) merged.branchIntent = updates.branchIntent;
				if (updates.worktreeIntent !== undefined) merged.worktreeIntent = updates.worktreeIntent;
				if (updates.startingCommitSha !== undefined) merged.startingCommitSha = updates.startingCommitSha;
				if (updates.durationSeconds !== undefined) merged.durationSeconds = updates.durationSeconds;
				if (updates.tokenUsage !== undefined) merged.tokenUsage = updates.tokenUsage;
				if (updates.teardownDecision !== undefined) merged.teardownDecision = updates.teardownDecision;
				if (updates.teardownCompletedAt !== undefined) merged.teardownCompletedAt = updates.teardownCompletedAt;
				return persistedTaskExecutionSchema.parse(merged);
			});

			if (!found) return;

			const updatedFile: TaskExecutionsFile = {
				...file,
				executions: updatedExecutions,
			};

			await lockedFileSystem.writeJsonFileAtomic(this.executionsPath, updatedFile, { lock: null });
		});

		return found;
	}
}
