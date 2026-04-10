// ---------------------------------------------------------------------------
// Cloud Execution Log Store — In-memory append-only log entry store
// @phase Phase2
// @prd-section 10, 15.9
//
// Stores log entries received from the SSE log stream per task/execution.
// Supports querying entries with cursor-based pagination for efficient
// polling from the UI. Entries are immutable once appended.
//
// Architecture:
//   - In-memory only (no disk persistence for log entries)
//   - Append-only per task; entries are never modified
//   - Supports afterSequence cursor for incremental polling
//   - Thread-safe for single-threaded Node.js event loop
// ---------------------------------------------------------------------------

import type { LogStreamEntry } from "./cloud-execution-log-stream";

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

/**
 * Interface for the execution log store used by the orchestrator
 * and runtime API. Structurally typed for testability.
 */
export interface CloudExecutionLogStoreInterface {
	/** Append a log entry for a task. */
	append(taskId: string, entry: LogStreamEntry): void;

	/**
	 * Read log entries for a task, optionally starting after a
	 * given sequence number.
	 * @param taskId - The task to read logs for.
	 * @param afterSequence - If provided, only return entries
	 *   with sequence > afterSequence.
	 * @param limit - Maximum entries to return. @default 500
	 */
	read(taskId: string, afterSequence?: number, limit?: number): readonly LogStreamEntry[];

	/** Return the total number of entries stored for a task. */
	count(taskId: string): number;

	/** Remove all entries for a task (cleanup on teardown). */
	clear(taskId: string): void;
}

// ---------------------------------------------------------------------------
// In-Memory Implementation
// ---------------------------------------------------------------------------

const DEFAULT_READ_LIMIT = 500;

/**
 * In-memory implementation of {@link CloudExecutionLogStoreInterface}.
 * Entries are stored in insertion order per task.
 */
export class CloudExecutionLogStore implements CloudExecutionLogStoreInterface {
	private readonly entries = new Map<string, LogStreamEntry[]>();

	append(taskId: string, entry: LogStreamEntry): void {
		let list = this.entries.get(taskId);
		if (!list) {
			list = [];
			this.entries.set(taskId, list);
		}
		list.push(entry);
	}

	read(taskId: string, afterSequence?: number, limit: number = DEFAULT_READ_LIMIT): readonly LogStreamEntry[] {
		const list = this.entries.get(taskId);
		if (!list || list.length === 0) return [];

		if (afterSequence === undefined || afterSequence <= 0) {
			return list.slice(0, limit);
		}

		// Binary search for the first entry after the cursor
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((list[mid]?.sequence ?? 0) <= afterSequence) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}

		return list.slice(lo, lo + limit);
	}

	count(taskId: string): number {
		return this.entries.get(taskId)?.length ?? 0;
	}

	clear(taskId: string): void {
		this.entries.delete(taskId);
	}
}
