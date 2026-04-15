import { describe, expect, it } from "vitest";

import * as kanban from "../../src/index";

describe("package root exports", () => {
	it("exports workspace-state helpers used by desktop interrupted-task detection", () => {
		expect(typeof kanban.listWorkspaceIndexEntries).toBe("function");
		expect(typeof kanban.loadWorkspaceState).toBe("function");
	});

	it("exports default runtime endpoint constants used by desktop shell", () => {
		expect(kanban.DEFAULT_KANBAN_RUNTIME_HOST).toBe("127.0.0.1");
		expect(kanban.DEFAULT_KANBAN_RUNTIME_PORT).toBe(3484);
	});
});
