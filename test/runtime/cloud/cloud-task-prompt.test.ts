import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	CLOUD_TASK_PROMPT_TEMPLATE_VERSION,
	type CloudTaskPromptInput,
	composeCloudTaskPrompt,
	REMOTE_WORKSPACE_ROOT,
} from "../../../src/cloud/cloud-task-prompt";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function createBaseInput(overrides: Partial<CloudTaskPromptInput> = {}): CloudTaskPromptInput {
	return {
		taskPrompt: "Implement the login feature with OAuth support",
		repositoryUrl: "https://github.com/org/repo.git",
		baseBranch: "main",
		featureBranch: "task/abc-123",
		worktreeIntent: "abc-123",
		executionMode: "execute",
		attemptNumber: 1,
		taskId: "abc-123",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Template version
// ---------------------------------------------------------------------------

describe("CLOUD_TASK_PROMPT_TEMPLATE_VERSION", () => {
	it("is a non-empty string", () => {
		expect(typeof CLOUD_TASK_PROMPT_TEMPLATE_VERSION).toBe("string");
		expect(CLOUD_TASK_PROMPT_TEMPLATE_VERSION.length).toBeGreaterThan(0);
	});

	it('is "1" for the initial version', () => {
		expect(CLOUD_TASK_PROMPT_TEMPLATE_VERSION).toBe("1");
	});
});

// ---------------------------------------------------------------------------
// Remote workspace root
// ---------------------------------------------------------------------------

describe("REMOTE_WORKSPACE_ROOT", () => {
	it("is /workspace", () => {
		expect(REMOTE_WORKSPACE_ROOT).toBe("/workspace");
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("composeCloudTaskPrompt — determinism", () => {
	it("produces identical output for identical input", () => {
		const input = createBaseInput();
		const result1 = composeCloudTaskPrompt(input);
		const result2 = composeCloudTaskPrompt(input);

		expect(result1.prompt).toBe(result2.prompt);
		expect(result1.promptHash).toBe(result2.promptHash);
		expect(result1.templateVersion).toBe(result2.templateVersion);
	});

	it("produces different output when input differs", () => {
		const result1 = composeCloudTaskPrompt(createBaseInput({ taskPrompt: "Task A" }));
		const result2 = composeCloudTaskPrompt(createBaseInput({ taskPrompt: "Task B" }));

		expect(result1.prompt).not.toBe(result2.prompt);
		expect(result1.promptHash).not.toBe(result2.promptHash);
	});

	it("hash matches SHA-256 of the prompt", () => {
		const input = createBaseInput();
		const result = composeCloudTaskPrompt(input);
		const expectedHash = createHash("sha256").update(result.prompt).digest("hex");

		expect(result.promptHash).toBe(expectedHash);
	});
});

// ---------------------------------------------------------------------------
// Prompt content — required sections
// ---------------------------------------------------------------------------

describe("composeCloudTaskPrompt — content", () => {
	const input = createBaseInput();
	const result = composeCloudTaskPrompt(input);

	it("includes role section", () => {
		expect(result.prompt).toContain("## Role");
		expect(result.prompt).toContain("remote coding agent");
		expect(result.prompt).toContain(REMOTE_WORKSPACE_ROOT);
	});

	it("includes task objective with task ID and attempt", () => {
		expect(result.prompt).toContain("## Task Objective");
		expect(result.prompt).toContain(`Task ID: ${input.taskId}`);
		expect(result.prompt).toContain(`Attempt: ${input.attemptNumber}`);
		expect(result.prompt).toContain(`Execution mode: ${input.executionMode}`);
		expect(result.prompt).toContain(input.taskPrompt);
	});

	it("includes repository context with branch/worktree intent", () => {
		expect(result.prompt).toContain("## Repository Context");
		expect(result.prompt).toContain(`Repository: ${input.repositoryUrl}`);
		expect(result.prompt).toContain(`Base branch: ${input.baseBranch}`);
		expect(result.prompt).toContain(`Feature branch: ${input.featureBranch}`);
		expect(result.prompt).toContain(`Worktree intent: ${input.worktreeIntent}`);
		expect(result.prompt).toContain(`Remote workspace root: ${REMOTE_WORKSPACE_ROOT}`);
	});

	it("includes execution constraints", () => {
		expect(result.prompt).toContain("## Execution Constraints");
		expect(result.prompt).toContain(REMOTE_WORKSPACE_ROOT);
		expect(result.prompt).toContain(input.featureBranch);
	});

	it("includes expected output section", () => {
		expect(result.prompt).toContain("## Expected Output");
		expect(result.prompt).toContain("commit message");
	});

	it("sets template version", () => {
		expect(result.templateVersion).toBe(CLOUD_TASK_PROMPT_TEMPLATE_VERSION);
	});
});

// ---------------------------------------------------------------------------
// Optional fields
// ---------------------------------------------------------------------------

describe("composeCloudTaskPrompt — starting commit SHA", () => {
	it("omits starting commit line when not provided", () => {
		const result = composeCloudTaskPrompt(createBaseInput());
		expect(result.prompt).not.toContain("Starting commit:");
	});

	it("includes starting commit line when provided", () => {
		const sha = "abc123def456";
		const result = composeCloudTaskPrompt(createBaseInput({ startingCommitSha: sha }));
		expect(result.prompt).toContain(`Starting commit: ${sha}`);
		expect(result.prompt).toContain(`Reset the workspace to commit \`${sha}\``);
	});
});

describe("composeCloudTaskPrompt — task config", () => {
	it("omits task config block when not provided", () => {
		const result = composeCloudTaskPrompt(createBaseInput());
		expect(result.prompt).not.toContain("## Task Configuration");
	});

	it("omits task config block when empty", () => {
		const result = composeCloudTaskPrompt(createBaseInput({ taskConfig: {} }));
		expect(result.prompt).not.toContain("## Task Configuration");
	});

	it("includes task config entries sorted alphabetically", () => {
		const result = composeCloudTaskPrompt(
			createBaseInput({
				taskConfig: { timeout: "30m", coverage: "80%", agent: "cline" },
			}),
		);
		expect(result.prompt).toContain("## Task Configuration");
		expect(result.prompt).toContain("- agent: cline");
		expect(result.prompt).toContain("- coverage: 80%");
		expect(result.prompt).toContain("- timeout: 30m");
		// Sorted: agent < coverage < timeout
		const agentIdx = result.prompt.indexOf("- agent:");
		const coverageIdx = result.prompt.indexOf("- coverage:");
		const timeoutIdx = result.prompt.indexOf("- timeout:");
		expect(agentIdx).toBeLessThan(coverageIdx);
		expect(coverageIdx).toBeLessThan(timeoutIdx);
	});
});

// ---------------------------------------------------------------------------
// Variation coverage — fields affect hash
// ---------------------------------------------------------------------------

describe("composeCloudTaskPrompt — field sensitivity", () => {
	const baseline = composeCloudTaskPrompt(createBaseInput());

	const variations: Array<[string, Partial<CloudTaskPromptInput>]> = [
		["repositoryUrl", { repositoryUrl: "https://github.com/other/repo.git" }],
		["baseBranch", { baseBranch: "develop" }],
		["featureBranch", { featureBranch: "task/xyz-789" }],
		["worktreeIntent", { worktreeIntent: "xyz-789" }],
		["executionMode", { executionMode: "plan" }],
		["attemptNumber", { attemptNumber: 3 }],
		["taskId", { taskId: "xyz-789" }],
		["startingCommitSha", { startingCommitSha: "deadbeef" }],
	];

	for (const [field, override] of variations) {
		it(`changing ${field} changes the hash`, () => {
			const varied = composeCloudTaskPrompt(createBaseInput(override));
			expect(varied.promptHash).not.toBe(baseline.promptHash);
		});
	}
});
