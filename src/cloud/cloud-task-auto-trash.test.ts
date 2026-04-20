import { describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import type { AutoTrashLogger } from "./cloud-task-auto-trash";
import { trashTaskAcrossWorkspaces } from "./cloud-task-auto-trash";

const silentLogger: AutoTrashLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeBoard(taskId: string, columnId: "in_progress" | "trash" = "in_progress"): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", cards: [] },
			{
				id: "in_progress",
				cards: columnId === "in_progress" ? [{ id: taskId, title: "T", updatedAt: 0 } as never] : [],
			},
			{ id: "review", cards: [] },
			{
				id: "trash",
				cards: columnId === "trash" ? [{ id: taskId, title: "T", updatedAt: 0 } as never] : [],
			},
		],
		dependencies: [],
	} as unknown as RuntimeBoardData;
}

function makeState(board: RuntimeBoardData, revision = 1): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/repo/.kanban",
		git: { head: "main", branches: [], remotes: [] } as never,
		board,
		sessions: {},
		revision,
	} as RuntimeWorkspaceStateResponse;
}

describe("trashTaskAcrossWorkspaces", () => {
	it("moves a task sitting in 'in_progress' to 'trash' in the first matching workspace", async () => {
		const taskId = "task-abc";
		const state = makeState(makeBoard(taskId, "in_progress"));
		const saveWorkspace = vi.fn().mockResolvedValue(state);

		const result = await trashTaskAcrossWorkspaces(taskId, "test reason", {
			listWorkspaces: async () => [{ workspaceId: "w1", repoPath: "/tmp/repo" }],
			loadWorkspace: async () => state,
			saveWorkspace,
			logger: silentLogger,
		});

		expect(result.moved).toBe(true);
		expect(result.fromColumnId).toBe("in_progress");
		expect(result.workspacePath).toBe("/tmp/repo");
		expect(saveWorkspace).toHaveBeenCalledOnce();
		const savedPayload = saveWorkspace.mock.calls[0]![1] as {
			board: RuntimeBoardData;
			expectedRevision: number;
		};
		expect(savedPayload.expectedRevision).toBe(1);
		const trashCol = savedPayload.board.columns.find((c) => c.id === "trash")!;
		expect(trashCol.cards.some((c) => c.id === taskId)).toBe(true);
		const inProg = savedPayload.board.columns.find((c) => c.id === "in_progress")!;
		expect(inProg.cards.some((c) => c.id === taskId)).toBe(false);
	});

	it("returns moved=false and does not save when task is already in trash", async () => {
		const taskId = "task-xyz";
		const state = makeState(makeBoard(taskId, "trash"));
		const saveWorkspace = vi.fn();

		const result = await trashTaskAcrossWorkspaces(taskId, "reason", {
			listWorkspaces: async () => [{ workspaceId: "w1", repoPath: "/tmp/repo" }],
			loadWorkspace: async () => state,
			saveWorkspace,
			logger: silentLogger,
		});

		expect(result.moved).toBe(false);
		expect(result.fromColumnId).toBe("trash");
		expect(saveWorkspace).not.toHaveBeenCalled();
	});

	it("returns moved=false when task is not found in any workspace", async () => {
		const state = makeState(makeBoard("other-task", "in_progress"));
		const saveWorkspace = vi.fn();

		const result = await trashTaskAcrossWorkspaces("missing-task", "reason", {
			listWorkspaces: async () => [{ workspaceId: "w1", repoPath: "/tmp/repo" }],
			loadWorkspace: async () => state,
			saveWorkspace,
			logger: silentLogger,
		});

		expect(result.moved).toBe(false);
		expect(result.fromColumnId).toBeNull();
		expect(result.workspacePath).toBeNull();
		expect(saveWorkspace).not.toHaveBeenCalled();
	});

	it("skips workspaces that fail to load and keeps searching", async () => {
		const taskId = "task-found";
		const goodState = makeState(makeBoard(taskId, "in_progress"));
		const saveWorkspace = vi.fn().mockResolvedValue(goodState);
		const loadWorkspace = vi
			.fn()
			.mockRejectedValueOnce(new Error("corrupt workspace"))
			.mockResolvedValueOnce(goodState);

		const result = await trashTaskAcrossWorkspaces(taskId, "reason", {
			listWorkspaces: async () => [
				{ workspaceId: "bad", repoPath: "/tmp/bad" },
				{ workspaceId: "good", repoPath: "/tmp/repo" },
			],
			loadWorkspace,
			saveWorkspace,
			logger: silentLogger,
		});

		expect(result.moved).toBe(true);
		expect(result.workspacePath).toBe("/tmp/repo");
		expect(loadWorkspace).toHaveBeenCalledTimes(2);
	});
});
