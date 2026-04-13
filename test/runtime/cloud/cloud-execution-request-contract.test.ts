import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	type CloudRunHttpClient,
	type CloudRunRequest,
	invokeRun,
} from "../../../src/cloud/cloud-run-client";
import {
	cloudInstanceCreateRequestSchema,
} from "../../../src/cloud/cloud-instance-client";
import { CloudExecutionStore } from "../../../src/cloud/cloud-execution-persistence";

// ---------------------------------------------------------------------------
// Contract: metadata survives execution record → instance create → /run payload
// ---------------------------------------------------------------------------

describe("cloud execution request contract", () => {
	describe("CloudRunRequest carries full contract fields through invokeRun", () => {
		it("sends baseBranch, startingCommitSha, reservationId, worktreeIntent, attemptNumber", async () => {
			const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
			const fakeClient: CloudRunHttpClient = {
				post: async (url, body, headers) => {
					calls.push({ url, body, headers });
					return { status: 202, body: JSON.stringify({ run_id: "run-1" }) };
				},
			};

			const request: CloudRunRequest = {
				prompt: "Implement feature X",
				callback_url: "https://kanban.test/callback",
				task_id: "task-001",
				attempt_number: 2,
				branch_name: "kanban/task-001",
				base_branch: "main",
				starting_commit_sha: "deadbeef1234",
				worktree_intent: "task-001/attempt-2",
				reservation_id: "res-abc",
			};

			const result = await invokeRun("sandbox-001.cloud.test", request, {
				httpClient: fakeClient,
			});

			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);

			const sentBody = JSON.parse(calls[0]!.body) as Record<string, unknown>;
			expect(sentBody.prompt).toBe("Implement feature X");
			expect(sentBody.task_id).toBe("task-001");
			expect(sentBody.base_branch).toBe("main");
			expect(sentBody.starting_commit_sha).toBe("deadbeef1234");
			expect(sentBody.attempt_number).toBe(2);
			expect(sentBody.reservation_id).toBe("res-abc");
			expect(sentBody.branch_name).toBe("kanban/task-001");
			expect(sentBody.worktree_intent).toBe("task-001/attempt-2");
		});
	});

	describe("cloudInstanceCreateRequestSchema validates attempt/worktree metadata", () => {
		it("accepts request with attemptNumber, worktreeIntent, startingCommitSha", () => {
			const input = {
				user_id: "usr-01",
				repo_url: "https://github.com/test/repo.git",
				api_key: "key-123",
				instance_type: "task-runner",
				github_pat: "ghp_test",
				pr_base_branch: "main",
				attempt_number: 3,
				worktree_intent: "worktrees/task-abc/attempt-3",
				starting_commit_sha: "abc123def456",
			};

			const result = cloudInstanceCreateRequestSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.attempt_number).toBe(3);
				expect(result.data.worktree_intent).toBe("worktrees/task-abc/attempt-3");
				expect(result.data.starting_commit_sha).toBe("abc123def456");
				expect(result.data.pr_base_branch).toBe("main");
			}
		});

		it("allows omitting optional metadata fields", () => {
			const input = {
				user_id: "usr-01",
				repo_url: "https://github.com/test/repo.git",
				api_key: "key-123",
				instance_type: "task-runner",
				github_pat: "ghp_test",
				pr_base_branch: "main",
			};

			const result = cloudInstanceCreateRequestSchema.safeParse(input);
			expect(result.success).toBe(true);
		});
	});

	describe("persisted event metadata.prompt survives and is retrievable", () => {
		it("stores and reads prompt from submit event metadata", async () => {
			const tmpDir = await mkdtemp(join(tmpdir(), "contract-test-"));
			try {
				const store = new CloudExecutionStore(tmpDir);
				const taskId = "task-prompt-test";

				await store.appendEvent({
					eventId: randomUUID(),
					taskId,
					trigger: "submit",
					fromState: "draft",
					toState: "queued",
					timestamp: new Date().toISOString(),
					triggerSource: "user",
					metadata: {
						prompt: "Build the login page",
						executionMode: "cloud_agent",
						baseRef: "main",
					},
				});

				const events = await store.readEventsForTask(taskId);
				expect(events).toHaveLength(1);
				expect(events[0]!.metadata?.prompt).toBe("Build the login page");
				expect(events[0]!.metadata?.executionMode).toBe("cloud_agent");
				expect(events[0]!.metadata?.baseRef).toBe("main");
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("governance headers on run invocation", () => {
		it("invokeRun sends Content-Type application/json", async () => {
			const calls: Array<{ headers: Record<string, string> }> = [];
			const fakeClient: CloudRunHttpClient = {
				post: async (url, body, headers) => {
					calls.push({ headers });
					return { status: 202, body: JSON.stringify({ run_id: "r" }) };
				},
			};

			await invokeRun("sandbox.test", {
				prompt: "test",
				callback_url: "https://kanban.test/cb",
				task_id: "t-1",
				attempt_number: 1,
			}, { httpClient: fakeClient });

			expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
		});

		it("invokeRun sends Authorization bearer token when provided", async () => {
			const calls: Array<{ headers: Record<string, string> }> = [];
			const fakeClient: CloudRunHttpClient = {
				post: async (url, body, headers) => {
					calls.push({ headers });
					return { status: 202, body: JSON.stringify({ run_id: "r" }) };
				},
			};

			await invokeRun("sandbox.test", {
				prompt: "test",
				callback_url: "https://kanban.test/cb",
				task_id: "t-1",
				attempt_number: 1,
			}, { httpClient: fakeClient, bearerToken: "svc_secret_123" });

			expect(calls[0]!.headers["Authorization"]).toBe("Bearer svc_secret_123");
		});
	});
});
