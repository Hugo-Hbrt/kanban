/**
 * Cloud Orchestrator Integration Test (Layer 3)
 *
 * Drives the real CloudExecutionOrchestrator through a full lifecycle
 * (queued → policy_check → provisioning → running → completed → teardown → archived)
 * against a mock HTTP server. Uses real persistence (temp dir), real bootstrap
 * wiring, and real HTTP calls.
 *
 * This validates the orchestrator + store + HTTP clients work together
 * end-to-end without needing GKE.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CloudExecutionStore } from "../../../src/cloud/cloud-execution-persistence";
import type { PersistedTaskEvent, PersistedTaskExecution } from "../../../src/cloud/cloud-execution-persistence";
import {
	CloudExecutionOrchestrator,
	type CloudInstanceFullClient,
	type CloudRunInvoker,
	type InvokeRunRequest,
	type InvokeRunResponse,
	type OrchestratorLogger,
} from "../../../src/cloud/cloud-execution-orchestrator";
import type { GovernanceClient } from "../../../src/cloud/cloud-governance-client";

// ---------------------------------------------------------------------------
// Captured HTTP traffic for assertions
// ---------------------------------------------------------------------------

interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

const capturedRequests: CapturedRequest[] = [];
function resetCaptured() {
	capturedRequests.length = 0;
}

// ---------------------------------------------------------------------------
// Mock cloud-platform HTTP server
// ---------------------------------------------------------------------------

let server: http.Server;
let serverPort: number;

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

			if (req.method === "POST" && url.startsWith("/instances")) {
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						instance_id: "inst-integ-001",
						user_id: parsed?.user_id ?? "test-user",
						namespace: "cline-instances",
						hostname: `127.0.0.1:${serverPort}`,
					}),
				);
				return;
			}

			if (req.method === "GET" && url.match(/^\/instances\/[^/]+$/)) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						instance_id: "inst-integ-001",
						user_id: "test-user",
						namespace: "cline-instances",
						state: "ready",
						hostname: `127.0.0.1:${serverPort}`,
					}),
				);
				return;
			}

			if (req.method === "DELETE" && url.match(/^\/instances\/[^/]+$/)) {
				res.writeHead(204);
				res.end();
				return;
			}

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
			serverPort = typeof addr === "object" ? addr!.port : 0;
			resolve();
		});
	});
});

afterAll(() => {
	server?.close();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempStore(): { store: CloudExecutionStore; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-orch-integ-"));
	const store = new CloudExecutionStore(dir);
	return {
		store,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

function httpRewriteFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return globalThis.fetch(url.replace(/^https:\/\//, "http://"), init);
}

const testLogger: OrchestratorLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

function createMockGovernanceClient(): GovernanceClient {
	return {
		async checkAuthorization() {
			return {
				decision: "authorized" as const,
				reason: "test-authorized",
				policySnapshotId: "snap-test",
			};
		},
		async reserveBudget() {
			return {
				reservationId: "res-test-001",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			};
		},
		async reportUsage() {},
		async reportAudit() {},
	};
}

function createMockInstanceClient(): CloudInstanceFullClient {
	const baseUrl = `http://127.0.0.1:${serverPort}`;
	return {
		async createInstance(request, signal) {
			const res = await httpRewriteFetch(`${baseUrl}/instances`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					user_id: "test-user",
					repo_url: request.repoUrl,
					api_key: "test-key",
					instance_type: "task-runner",
					pr_base_branch: request.baseBranch,
				}),
				signal,
			});
			const data = await res.json();
			return {
				instance_id: data.instance_id,
				user_id: data.user_id,
				namespace: data.namespace,
				state: "provisioning" as const,
				hostname: data.hostname,
			};
		},
		async getInstance(instanceId, signal) {
			const res = await httpRewriteFetch(`${baseUrl}/instances/${instanceId}`, { signal });
			return res.json();
		},
		async deleteInstance(instanceId) {
			await httpRewriteFetch(`${baseUrl}/instances/${instanceId}`, { method: "DELETE" });
		},
	};
}

function createMockRunInvoker(store: CloudExecutionStore): CloudRunInvoker {
	return {
		async composePrompt(taskId) {
			return `Execute task ${taskId}`;
		},
		async invokeRun(request: InvokeRunRequest, signal?: AbortSignal): Promise<InvokeRunResponse> {
			const res = await httpRewriteFetch(`http://127.0.0.1:${serverPort}/run`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
				body: JSON.stringify({
					prompt: request.prompt,
					task_id: request.taskId,
					callback_url: "http://localhost/callback",
					attempt_number: request.attemptNumber ?? 1,
					branch_name: request.branchName,
					base_branch: request.baseBranch,
					worktree_intent: request.worktreeIntent,
				}),
				signal,
			});
			return { accepted: res.status === 202 };
		},
	};
}

// ---------------------------------------------------------------------------
// Integration test: full orchestrator lifecycle
// ---------------------------------------------------------------------------

describe("Orchestrator Integration — full lifecycle with mock HTTP server", () => {
	let store: CloudExecutionStore;
	let cleanup: () => void;

	afterEach(() => {
		cleanup?.();
	});

	it("drives a task from queued through archived via processTask", async () => {
		resetCaptured();
		({ store, cleanup } = createTempStore());

		const taskId = `task-${randomUUID().slice(0, 8)}`;
		const executionId = randomUUID();

		// Seed: create initial "queued" event
		const queuedEvent: PersistedTaskEvent = {
			eventId: randomUUID(),
			taskId,
			trigger: "submit",
			fromState: "draft",
			toState: "queued",
			timestamp: new Date().toISOString(),
			triggerSource: "user",
			metadata: { prompt: "Fix the authentication bug in login.ts" },
		};
		await store.appendEvent(queuedEvent);

		// Seed: create execution record
		const execution: PersistedTaskExecution = {
			executionId,
			taskId,
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			remoteMetadata: {
				instanceId: "pending",
				repoUrl: "https://github.com/test/repo.git",
				baseBranch: "main",
				featureBranch: `feat/${taskId}`,
				worktreePath: `${taskId}/attempt-1`,
			},
		};
		await store.createExecution(execution);

		// Build orchestrator with mock dependencies
		const orchestrator = new CloudExecutionOrchestrator(
			store,
			createMockInstanceClient(),
			createMockRunInvoker(store),
			{
				tickIntervalMs: 100,
				pollerConfig: { intervalMs: 50, maxAttempts: 3, timeoutMs: 5000 },
				teardownConfig: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100 },
			},
			testLogger,
			null,
			createMockGovernanceClient(),
		);

		// Step 1: queued → policy_check
		let result = await orchestrator.processTask(taskId);
		expect(result).not.toBeNull();
		expect(result!.previousState).toBe("queued");
		expect(result!.newState).toBe("policy_check");
		expect(result!.success).toBe(true);

		// Step 2: policy_check → provisioning (governance authorizes)
		result = await orchestrator.processTask(taskId);
		expect(result).not.toBeNull();
		expect(result!.previousState).toBe("policy_check");
		expect(result!.newState).toBe("provisioning");
		expect(result!.success).toBe(true);

		// Step 3: provisioning → running (mock instance returns ready)
		result = await orchestrator.processTask(taskId);
		expect(result).not.toBeNull();
		expect(result!.previousState).toBe("provisioning");
		expect(result!.newState).toBe("running");
		expect(result!.success).toBe(true);

		// Verify: POST /instances was called
		const createReq = capturedRequests.find((r) => r.method === "POST" && r.url?.startsWith("/instances"));
		expect(createReq).toBeDefined();

		// Verify: GET /instances/{id} was called (readiness poll)
		const getReq = capturedRequests.find((r) => r.method === "GET" && r.url?.startsWith("/instances/"));
		expect(getReq).toBeDefined();

		// Step 4: running → invokes /run, then waits (returns null)
		result = await orchestrator.processTask(taskId);
		expect(result).toBeNull(); // /run accepted, waiting for callback

		// Verify: POST /run was called
		const runReq = capturedRequests.find((r) => r.method === "POST" && r.url === "/run");
		expect(runReq).toBeDefined();
		const runBody = runReq!.body as Record<string, unknown>;
		expect(runBody.task_id).toBe(taskId);
		expect(runBody.worktree_intent).toBe(`${taskId}/attempt-1`);

		// Simulate callback: append "completed" event (as if task-runner called back)
		const completedEvent: PersistedTaskEvent = {
			eventId: randomUUID(),
			taskId,
			trigger: "execution_done",
			fromState: "running",
			toState: "completed",
			timestamp: new Date().toISOString(),
			triggerSource: "system",
			metadata: { resultSummary: "Bug fixed successfully" },
		};
		await store.appendEvent(completedEvent);

		// Step 5: completed → teardown
		result = await orchestrator.processTask(taskId);
		expect(result).not.toBeNull();
		expect(result!.previousState).toBe("completed");
		expect(result!.newState).toBe("teardown");
		expect(result!.success).toBe(true);

		// Step 6: teardown → archived (DELETE instance)
		result = await orchestrator.processTask(taskId);
		expect(result).not.toBeNull();
		expect(result!.previousState).toBe("teardown");
		expect(result!.newState).toBe("archived");
		expect(result!.success).toBe(true);

		// Verify: DELETE /instances/{id} was called
		const deleteReq = capturedRequests.find((r) => r.method === "DELETE");
		expect(deleteReq).toBeDefined();

		// Verify final state
		const finalState = await store.deriveTaskState(taskId);
		expect(finalState).toBe("archived");

		// Verify all events trace the full lifecycle
		const events = await store.readEventsForTask(taskId);
		const states = events.map((e) => e.toState);
		expect(states).toEqual([
			"queued",
			"policy_check",
			"provisioning",
			"running",
			"completed",
			"teardown",
			"archived",
		]);

		// Summary of HTTP calls made
		const methods = capturedRequests.map((r) => `${r.method} ${r.url}`);
		expect(methods).toContain("POST /instances");
		expect(methods.some((m) => m.startsWith("GET /instances/"))).toBe(true);
		expect(methods).toContain("POST /run");
		expect(methods.some((m) => m.startsWith("DELETE /instances/"))).toBe(true);
	});

	it("handles cancellation during provisioning", async () => {
		resetCaptured();
		({ store, cleanup } = createTempStore());

		const taskId = `task-cancel-${randomUUID().slice(0, 8)}`;
		const executionId = randomUUID();

		// Seed queued event
		await store.appendEvent({
			eventId: randomUUID(),
			taskId,
			trigger: "submit",
			fromState: "draft",
			toState: "queued",
			timestamp: new Date().toISOString(),
			triggerSource: "user",
		});
		await store.createExecution({
			executionId,
			taskId,
			attemptNumber: 1,
			executionMode: "cloud_agent",
			createdAt: new Date().toISOString(),
			remoteMetadata: {
				instanceId: "pending",
				repoUrl: "https://github.com/test/repo.git",
				baseBranch: "main",
			},
		});

		const orchestrator = new CloudExecutionOrchestrator(
			store,
			createMockInstanceClient(),
			createMockRunInvoker(store),
			{
				tickIntervalMs: 100,
				pollerConfig: { intervalMs: 50, maxAttempts: 3, timeoutMs: 5000 },
				teardownConfig: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100 },
			},
			testLogger,
			null,
			createMockGovernanceClient(),
		);

		// Advance to provisioning
		await orchestrator.processTask(taskId); // queued → policy_check
		await orchestrator.processTask(taskId); // policy_check → provisioning

		// Request cancellation
		orchestrator.requestCancellation(taskId);
		const result = await orchestrator.processTask(taskId);

		expect(result).not.toBeNull();
		expect(result!.newState).toBe("canceled");
		expect(result!.success).toBe(true);

		// Verify: moves to teardown then archived
		const teardownResult = await orchestrator.processTask(taskId);
		expect(teardownResult).not.toBeNull();
		expect(teardownResult!.newState).toBe("teardown");

		const archivedResult = await orchestrator.processTask(taskId);
		expect(archivedResult).not.toBeNull();
		expect(archivedResult!.newState).toBe("archived");

		const finalState = await store.deriveTaskState(taskId);
		expect(finalState).toBe("archived");
	});
});
