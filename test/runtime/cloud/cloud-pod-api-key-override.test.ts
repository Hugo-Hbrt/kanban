import { describe, expect, it } from "vitest";
import type { CloudAuthProvider } from "../../../src/cloud/cloud-auth-provider";
import { CloudPlatformExecutionHttpClient } from "../../../src/cloud/cloud-platform-execution-client";

// Regression: split-credential support for dev-vs-prod environments. The
// `apiKey` field in the /instances request body becomes the pod's
// CLINE_API_KEY. It must NOT be coupled to the bearer token we use to
// authenticate to core-api — otherwise a dev-only control-plane token leaks
// into the pod and cline fails to call production inference.
describe("CloudPlatformExecutionHttpClient podApiKey override", () => {
	const makeAuthProvider = (bearer: string): CloudAuthProvider => ({
		getAuthHeaders: async () => ({ Authorization: `Bearer ${bearer}` }),
	});

	interface CapturedCall {
		url: string;
		body: Record<string, unknown>;
		auth: string | undefined;
	}

	const captureFetch = (captured: CapturedCall[], instanceId = "inst-1") => {
		return (async (url: string | URL, init?: RequestInit) => {
			const u = typeof url === "string" ? url : url.toString();
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const auth = headers["Authorization"] ?? headers["authorization"];
			if (init?.method === "POST" && u.endsWith("/api/v2/cloud-platform/instances")) {
				const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
				captured.push({ url: u, body, auth });
				return new Response(
					JSON.stringify({ success: true, data: { instanceId, state: "provisioning", hostname: "", namespace: "ns" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (init?.method === "GET" && u.includes(`/instances/${instanceId}`)) {
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							instanceId,
							state: "ready",
							hostname: "pod.example",
							namespace: "ns",
							runtime: { transport: "websocket", connectUrl: "wss://pod.example/acp" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof globalThis.fetch;
	};

	const baseRequest = {
		taskId: "task-1",
		attemptNumber: 1,
		executionMode: "cloud" as const,
		orgId: "org-1",
		projectId: "proj-1",
		requestedByUserId: "usr-1",
		repoUrl: "https://github.com/acme/repo.git",
		baseBranch: "main",
		featureBranchIntent: "kanban/task-1",
		worktreeIntent: "/tmp/wt",
		prompt: "hi",
	};

	it("forwards bearer token as pod apiKey by default (back-compat)", async () => {
		const captured: CapturedCall[] = [];
		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "http://local-core-api",
			authProvider: makeAuthProvider("sk_local_dev"),
			fetch: captureFetch(captured),
			delay: () => Promise.resolve(),
			provisionPollingConfig: { pollIntervalMs: 0, timeoutMs: 5_000 },
		});
		await client.createExecution(baseRequest);
		expect(captured.length).toBe(1);
		expect(captured[0]?.body["apiKey"]).toBe("sk_local_dev");
		expect(captured[0]?.auth).toBe("Bearer sk_local_dev");
	});

	it("forwards podApiKey to pod while still authenticating to core-api with the bearer token", async () => {
		const captured: CapturedCall[] = [];
		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "http://local-core-api",
			authProvider: makeAuthProvider("sk_local_dev"),
			podApiKey: "sk_prod_real",
			fetch: captureFetch(captured),
			delay: () => Promise.resolve(),
			provisionPollingConfig: { pollIntervalMs: 0, timeoutMs: 5_000 },
		});
		await client.createExecution(baseRequest);
		expect(captured.length).toBe(1);
		expect(captured[0]?.body["apiKey"]).toBe("sk_prod_real");
		expect(captured[0]?.auth).toBe("Bearer sk_local_dev");
	});

	it("treats empty podApiKey as unset (falls back to bearer)", async () => {
		const captured: CapturedCall[] = [];
		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "http://local-core-api",
			authProvider: makeAuthProvider("sk_local_dev"),
			podApiKey: "",
			fetch: captureFetch(captured),
			delay: () => Promise.resolve(),
			provisionPollingConfig: { pollIntervalMs: 0, timeoutMs: 5_000 },
		});
		await client.createExecution(baseRequest);
		expect(captured[0]?.body["apiKey"]).toBe("sk_local_dev");
	});
});
