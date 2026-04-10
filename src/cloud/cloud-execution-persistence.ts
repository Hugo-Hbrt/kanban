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
});
export type RemoteExecutionMetadata = z.infer<typeof remoteExecutionMetadataSchema>;

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
				"instanceId" | "startedAt" | "completedAt" | "terminalState" | "resultSummary" | "remoteMetadata"
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
