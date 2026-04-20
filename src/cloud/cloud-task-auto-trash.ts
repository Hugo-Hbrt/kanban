import { moveTaskToColumn } from "../core/task-board-mutations";
import { listWorkspaceIndexEntries, loadWorkspaceState, saveWorkspaceState } from "../state/workspace-state";

export interface AutoTrashLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

export interface AutoTrashDependencies {
	listWorkspaces: typeof listWorkspaceIndexEntries;
	loadWorkspace: typeof loadWorkspaceState;
	saveWorkspace: typeof saveWorkspaceState;
	logger: AutoTrashLogger;
}

export interface AutoTrashResult {
	moved: boolean;
	fromColumnId: string | null;
	workspacePath: string | null;
}

/**
 * Locate a task across all known workspaces and move it to the Trash column.
 *
 * Used as the orchestrator's auto-trash handler: when a cloud execution lands
 * in an unrecoverable limbo (no cloudExecutionId, nothing to poll), we eject
 * the card from "In Progress" so the user isn't looking at a wedged task.
 *
 * Returns `{ moved: false }` if the task can't be found in any workspace,
 * or if it was already in trash. Safe to call for any taskId.
 */
export async function trashTaskAcrossWorkspaces(
	taskId: string,
	reason: string,
	deps: AutoTrashDependencies,
): Promise<AutoTrashResult> {
	let entries;
	try {
		entries = await deps.listWorkspaces();
	} catch (e) {
		deps.logger.warn("[auto-trash] Failed to list workspaces", {
			taskId,
			error: e instanceof Error ? e.message : String(e),
		});
		return { moved: false, fromColumnId: null, workspacePath: null };
	}

	for (const entry of entries) {
		const workspacePath = entry.repoPath;
		let state;
		try {
			state = await deps.loadWorkspace(workspacePath);
		} catch (e) {
			deps.logger.warn("[auto-trash] Failed to load workspace state", {
				taskId,
				workspacePath,
				error: e instanceof Error ? e.message : String(e),
			});
			continue;
		}

		const found = state.board.columns.some((col) => col.cards.some((card) => card.id === taskId));
		if (!found) continue;

		const movement = moveTaskToColumn(state.board, taskId, "trash");
		if (!movement.moved) {
			return {
				moved: false,
				fromColumnId: movement.fromColumnId,
				workspacePath,
			};
		}

		try {
			await deps.saveWorkspace(workspacePath, {
				board: movement.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
		} catch (e) {
			deps.logger.error("[auto-trash] Failed to persist trashed task", {
				taskId,
				workspacePath,
				error: e instanceof Error ? e.message : String(e),
			});
			return {
				moved: false,
				fromColumnId: movement.fromColumnId,
				workspacePath,
			};
		}

		deps.logger.info("[auto-trash] Task moved to trash", {
			taskId,
			reason,
			fromColumnId: movement.fromColumnId,
			workspacePath,
		});
		return {
			moved: true,
			fromColumnId: movement.fromColumnId,
			workspacePath,
		};
	}

	deps.logger.info("[auto-trash] Task not found in any workspace", { taskId, reason });
	return { moved: false, fromColumnId: null, workspacePath: null };
}
