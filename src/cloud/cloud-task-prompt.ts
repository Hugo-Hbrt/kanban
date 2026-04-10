import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Prompt Template Version
// ---------------------------------------------------------------------------

/**
 * Current prompt template version.
 * Monotonically increasing; changes when template structure changes.
 * Persisted alongside execution records per PRD Section 15.8.
 */
export const CLOUD_TASK_PROMPT_TEMPLATE_VERSION = "1";

// ---------------------------------------------------------------------------
// Prompt Input
// ---------------------------------------------------------------------------

/**
 * Structured input for cloud task prompt composition.
 * All fields per PRD Section 15.8, 15.13, and 15.14.
 */
export interface CloudTaskPromptInput {
	/** The user-provided task description / prompt text. */
	readonly taskPrompt: string;
	/** Canonical repository URL (e.g. `https://github.com/org/repo.git`). */
	readonly repositoryUrl: string;
	/** Base branch the task should be based on (e.g. `main`). */
	readonly baseBranch: string;
	/** Feature branch name for the task (Kanban-defined branch intent). */
	readonly featureBranch: string;
	/** Worktree path intent (Kanban-defined, relative to workspace). */
	readonly worktreeIntent: string;
	/** Starting commit SHA to normalize workspace to before execution. */
	readonly startingCommitSha?: string | undefined;
	/** Execution mode (e.g. `plan` or `execute`). */
	readonly executionMode: string;
	/** Attempt number for this execution (1-based). */
	readonly attemptNumber: number;
	/** Kanban task ID. */
	readonly taskId: string;
	/** Additional task-specific configuration key-value pairs. */
	readonly taskConfig?: Readonly<Record<string, string>> | undefined;
}

// ---------------------------------------------------------------------------
// Prompt Result
// ---------------------------------------------------------------------------

/** Result of prompt composition for persistence and /run invocation. */
export interface CloudTaskPromptResult {
	/** The fully rendered prompt string. */
	readonly prompt: string;
	/** SHA-256 hex digest of the rendered prompt (deterministic). */
	readonly promptHash: string;
	/** Template version used to render this prompt. */
	readonly templateVersion: string;
}

// ---------------------------------------------------------------------------
// Remote Workspace Constants
// ---------------------------------------------------------------------------

/** Canonical remote workspace root per PRD Section 15.14. */
export const REMOTE_WORKSPACE_ROOT = "/workspace";

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function renderTaskConfigBlock(taskConfig: Readonly<Record<string, string>> | undefined): string {
	if (!taskConfig) return "";
	const entries = Object.entries(taskConfig).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "";
	const lines = entries.map(([key, value]) => `- ${key}: ${value}`);
	return `\n## Task Configuration\n\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Prompt Composition
// ---------------------------------------------------------------------------

/**
 * Compose a deterministic prompt from structured task data.
 *
 * Encodes full execution intent per PRD Section 15.8 (template v1),
 * 15.13 (remote worktree rule), and 15.14 (remote bootstrap rule).
 *
 * **Determinism guarantee:** Same input always produces same output.
 *
 * Prompt structure (PRD 15.8):
 * 1. Role/instructions  2. Task objective  3. Repository context
 * 4. Execution constraints  5. Expected output
 */
export function composeCloudTaskPrompt(input: CloudTaskPromptInput): CloudTaskPromptResult {
	const commitLine = input.startingCommitSha ? `- Starting commit: ${input.startingCommitSha}\n` : "";
	const commitReset = input.startingCommitSha
		? `Reset the workspace to commit \`${input.startingCommitSha}\` before starting.\n`
		: "";
	const configBlock = renderTaskConfigBlock(input.taskConfig);

	const prompt = [
		`# Cloud Task Execution`,
		``,
		`## Role`,
		``,
		`You are a remote coding agent executing a Kanban task inside a cloud sandbox.`,
		`Your workspace is a git-backed repository at ${REMOTE_WORKSPACE_ROOT}.`,
		`Execute the task precisely as described. Do not modify unrelated files.`,
		``,
		`## Task Objective`,
		``,
		`Task ID: ${input.taskId}`,
		`Attempt: ${input.attemptNumber}`,
		`Execution mode: ${input.executionMode}`,
		``,
		input.taskPrompt,
		``,
		`## Repository Context`,
		``,
		`- Repository: ${input.repositoryUrl}`,
		`- Base branch: ${input.baseBranch}`,
		`- Feature branch: ${input.featureBranch}`,
		`- Worktree intent: ${input.worktreeIntent}`,
		`${commitLine}- Remote workspace root: ${REMOTE_WORKSPACE_ROOT}`,
		``,
		`The repository has been cloned and bootstrapped at ${REMOTE_WORKSPACE_ROOT}.`,
		`Check out the base branch \`${input.baseBranch}\`, then create or switch to the`,
		`feature branch \`${input.featureBranch}\` before beginning work.`,
		commitReset,
		`## Execution Constraints`,
		``,
		`- Work only within ${REMOTE_WORKSPACE_ROOT}.`,
		`- Commit all changes to the feature branch \`${input.featureBranch}\`.`,
		`- Do not push to the base branch \`${input.baseBranch}\` directly.`,
		`- Do not modify repository configuration or remote settings.`,
		configBlock,
		`## Expected Output`,
		``,
		`- Complete the task objective described above.`,
		`- Commit your changes with a descriptive commit message.`,
		`- Report success or failure upon completion.`,
		``,
	].join("\n");

	const promptHash = createHash("sha256").update(prompt).digest("hex");

	return {
		prompt,
		promptHash,
		templateVersion: CLOUD_TASK_PROMPT_TEMPLATE_VERSION,
	};
}
