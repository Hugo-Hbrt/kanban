/**
 * Cloud HTTP Contract Test
 *
 * Validates that kanban's CloudInstanceHttpClient sends request bodies
 * matching cloud-platform's Pydantic schemas and can parse the response
 * shapes correctly. Also validates the bootstrap HttpRunInvoker sends
 * correct /run request bodies with Authorization headers.
 *
 * This catches schema drift between the TypeScript client and the Python
 * API without needing a running cloud-platform instance.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CloudInstanceHttpClient } from "../../../src/cloud/cloud-instance-client";
import { bootstrapCloudExecution } from "../../../src/cloud/cloud-execution-bootstrap";

// ---------------------------------------------------------------------------
// Mock cloud-platform API server
// ---------------------------------------------------------------------------

interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

let server: http.Server;
let baseUrl: string;
const capturedRequests: CapturedRequest[] = [];

function resetCaptured() {
	capturedRequests.length = 0;
}

/**
 * Validates request body against cloud-platform's InstanceCreate Pydantic rules.
 * - user_id: must match /^usr-[0-9A-HJKMNP-TV-Z]{26}$/
 * - repo_url: required string
 * - api_key: required string
 * - instance_type: one of "webook" | "acp" | "task-runner"
 * - pr_base_branch: optional, defaults to "main"
 */
function validateInstanceCreateBody(body: Record<string, unknown>): string[] {
	const errors: string[] = [];

	if (typeof body.user_id !== "string") {
		errors.push("user_id must be a string");
	} else if (!/^usr-[0-9A-HJKMNP-TV-Z]{26}$/.test(body.user_id)) {
		errors.push(`user_id must match usr-{ULID} format, got: ${body.user_id}`);
	}

	if (typeof body.repo_url !== "string" || !body.repo_url) {
		errors.push("repo_url is required");
	}

	if (typeof body.api_key !== "string") {
		errors.push("api_key is required");
	}

	const validTypes = ["webook", "acp", "task-runner"];
	if (!validTypes.includes(body.instance_type as string)) {
		errors.push(`instance_type must be one of ${validTypes.join(", ")}, got: ${body.instance_type}`);
	}

	if (body.pr_base_branch !== undefined && typeof body.pr_base_branch !== "string") {
		errors.push("pr_base_branch must be a string if provided");
	}

	return errors;
}

/**
 * Validates /run request body matches task-runner expectations.
 */
function validateRunBody(body: Record<string, unknown>): string[] {
	const errors: string[] = [];

	if (typeof body.prompt !== "string" || !body.prompt) {
		errors.push("prompt is required");
	}
	if (typeof body.task_id !== "string" || !body.task_id) {
		errors.push("task_id is required");
	}
	if (body.attempt_number !== undefined && typeof body.attempt_number !== "number") {
		errors.push("attempt_number must be a number");
	}
	if (body.callback_url !== undefined && typeof body.callback_url !== "string") {
		errors.push("callback_url must be a string");
	}

	return errors;
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = body ? JSON.parse(body) : undefined;
			capturedRequests.push({
				method: req.method ?? "GET",
				url: req.url ?? "/",
				headers: req.headers as Record<string, string | string[] | undefined>,
				body: parsed,
			});

			const url = req.url ?? "";

			// POST /instances — create
			if (req.method === "POST" && url.startsWith("/instances")) {
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						instance_id: "inst-test-001",
						user_id: parsed?.user_id ?? "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
						namespace: "cline-instances",
						hostname: "inst-test-001.instances.cline.bot",
					}),
				);
				return;
			}

			// GET /instances/{id} — status
			if (req.method === "GET" && url.match(/^\/instances\/[^/]+$/)) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						instance_id: "inst-test-001",
						user_id: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
						namespace: "cline-instances",
						state: "ready",
						hostname: "inst-test-001.instances.cline.bot",
					}),
				);
				return;
			}

			// DELETE /instances/{id}
			if (req.method === "DELETE" && url.match(/^\/instances\/[^/]+$/)) {
				res.writeHead(204);
				res.end();
				return;
			}

			// POST /run — task runner invoke
			if (req.method === "POST" && url === "/run") {
				res.writeHead(202, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ accepted: true }));
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				baseUrl = `http://127.0.0.1:${addr.port}`;
			}
			resolve();
		});
	});
});

afterAll(() => {
	server?.close();
});

// ---------------------------------------------------------------------------
// Contract Tests: CloudInstanceHttpClient → cloud-platform API
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient contract with cloud-platform API", () => {
	it("POST /instances sends body matching InstanceCreate Pydantic schema", async () => {
		resetCaptured();
		const client = new CloudInstanceHttpClient({
			baseUrl,
			serviceCredential: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});

		const result = await client.createInstance(
			{
				user_id: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
				repo_url: "https://github.com/example/repo.git",
				api_key: "test-api-key",
				instance_type: "task-runner",
				pr_base_branch: "main",
			},
			{
				taskId: "task-test-001",
				idempotencyKey: "idem-001",
				executionIntent: {
					execution_mode: "cloud_agent",
					repo_url: "https://github.com/example/repo.git",
					base_branch: "main",
					feature_branch_intent: "feat/task-test-001",
					worktree_intent: "task-test-001/attempt-1",
					attempt_number: 1,
				},
			},
		);

		expect(capturedRequests).toHaveLength(1);
		const req = capturedRequests[0]!;
		expect(req.method).toBe("POST");
		expect(req.url).toContain("/instances");

		const errors = validateInstanceCreateBody(req.body as Record<string, unknown>);
		expect(errors).toEqual([]);

		expect(result.response.instance_id).toBe("inst-test-001");
		expect(result.response.hostname).toBe("inst-test-001.instances.cline.bot");
	});

	it("GET /instances/{id} parses InstanceStatus response", async () => {
		resetCaptured();
		const client = new CloudInstanceHttpClient({
			baseUrl,
			serviceCredential: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});

		const result = await client.getInstance("inst-test-001");

		expect(result.instance_id).toBe("inst-test-001");
		expect(result.state).toBe("ready");
		expect(result.hostname).toBe("inst-test-001.instances.cline.bot");
		expect(result.namespace).toBe("cline-instances");
	});

	it("DELETE /instances/{id} succeeds with 204", async () => {
		resetCaptured();
		const client = new CloudInstanceHttpClient({
			baseUrl,
			serviceCredential: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});

		await expect(client.deleteInstance("inst-test-001")).resolves.toBeUndefined();

		expect(capturedRequests).toHaveLength(1);
		expect(capturedRequests[0]!.method).toBe("DELETE");
	});
});

// ---------------------------------------------------------------------------
// Contract Tests: Bootstrap HttpRunInvoker → task-runner /run
// ---------------------------------------------------------------------------

// HttpRunInvoker hardcodes https:// — rewrite to http:// for the local mock
function httpRewriteFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const rewritten = url.replace(/^https:\/\//, "http://");
	return globalThis.fetch(rewritten, init);
}

describe("Bootstrap HttpRunInvoker contract with task-runner /run", () => {
	it("POST /run sends Authorization header and valid body", async () => {
		resetCaptured();
		const addr = server.address();
		const port = typeof addr === "object" ? addr?.port : 0;

		const runtime = bootstrapCloudExecution(
			{
				KANBAN_CLOUD_PLATFORM_BASE_URL: baseUrl,
				KANBAN_CLOUD_PLATFORM_API_KEY: "test-bearer-token",
				KANBAN_CLOUD_CALLBACK_URL: "https://kanban.example.com/callback",
				KANBAN_CLOUD_CALLBACK_SECRET: "test-secret",
			},
			undefined,
			{
				fetchFn: httpRewriteFetch,
			},
		);

		expect(runtime).not.toBeNull();

		// Invoke /run directly through the runInvoker
		const response = await runtime!.runInvoker.invokeRun({
			taskId: "task-001",
			executionId: "exec-001",
			instanceId: "inst-001",
			hostname: `127.0.0.1:${port}`,
			prompt: "Fix the bug in auth.ts",
			branchName: "feat/task-001",
			baseBranch: "main",
			startingCommitSha: "abc123",
			worktreeIntent: "task-001/attempt-1",
			attemptNumber: 1,
			reservationId: "res-001",
		});

		// Find the /run request
		const runReq = capturedRequests.find((r) => r.url === "/run");
		expect(runReq).toBeDefined();

		// Validate Authorization header
		expect(runReq!.headers.authorization).toBe("Bearer test-bearer-token");

		// Validate body shape
		const body = runReq!.body as Record<string, unknown>;
		const errors = validateRunBody(body);
		expect(errors).toEqual([]);

		expect(body.prompt).toBe("Fix the bug in auth.ts");
		expect(body.task_id).toBe("task-001");
		expect(body.branch_name).toBe("feat/task-001");
		expect(body.base_branch).toBe("main");
		expect(body.starting_commit_sha).toBe("abc123");
		expect(body.worktree_intent).toBe("task-001/attempt-1");
		expect(body.attempt_number).toBe(1);
		expect(body.callback_url).toBe("https://kanban.example.com/callback");
		expect(body.reservation_id).toBe("res-001");

		expect(response.accepted).toBe(true);
	});

	it("POST /run sends worktreeIntent from request, not derived from startingCommitSha", async () => {
		resetCaptured();
		const addr = server.address();
		const port = typeof addr === "object" ? addr?.port : 0;

		const runtime = bootstrapCloudExecution(
			{
				KANBAN_CLOUD_PLATFORM_BASE_URL: baseUrl,
				KANBAN_CLOUD_PLATFORM_API_KEY: "key",
				KANBAN_CLOUD_CALLBACK_URL: "https://cb.example.com",
				KANBAN_CLOUD_CALLBACK_SECRET: "secret",
			},
			undefined,
			{ fetchFn: httpRewriteFetch },
		);

		await runtime!.runInvoker.invokeRun({
			taskId: "task-002",
			executionId: "exec-002",
			instanceId: "inst-002",
			hostname: `127.0.0.1:${port}`,
			prompt: "Do stuff",
			worktreeIntent: "custom/worktree/path",
			attemptNumber: 3,
		});

		const runReq = capturedRequests.find((r) => r.url === "/run");
		const body = runReq!.body as Record<string, unknown>;

		expect(body.worktree_intent).toBe("custom/worktree/path");
	});
});
