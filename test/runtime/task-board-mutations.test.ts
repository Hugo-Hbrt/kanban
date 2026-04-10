import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("task executionMode", () => {
	it("defaults to undefined when executionMode is not specified", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		expect(created.task.executionMode).toBeUndefined();
	});

	it("persists cloud_agent executionMode on create", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Cloud task", baseRef: "main", executionMode: "cloud_agent" },
			() => "aaaaa111",
		);
		expect(created.task.executionMode).toBe("cloud_agent");
	});

	it("persists local_agent executionMode as undefined on create", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Local task", baseRef: "main", executionMode: "local_agent" },
			() => "aaaaa111",
		);
		expect(created.task.executionMode).toBeUndefined();
	});

	it("updates executionMode to cloud_agent", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, "aaaaa", {
			prompt: "Task A",
			baseRef: "main",
			executionMode: "cloud_agent",
		});
		expect(updated.task?.executionMode).toBe("cloud_agent");
	});

	it("clears executionMode when set back to local_agent", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main", executionMode: "cloud_agent" },
			() => "aaaaa111",
		);
		expect(created.task.executionMode).toBe("cloud_agent");

		const updated = updateTask(created.board, "aaaaa", {
			prompt: "Task A",
			baseRef: "main",
			executionMode: "local_agent",
		});
		expect(updated.task?.executionMode).toBeUndefined();
	});

	it("executionMode survives task move between columns", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Cloud task", baseRef: "main", executionMode: "cloud_agent" },
			() => "aaaaa111",
		);
		const moved = moveTaskToColumn(created.board, "aaaaa", "in_progress");
		expect(moved.task?.executionMode).toBe("cloud_agent");
	});
});
