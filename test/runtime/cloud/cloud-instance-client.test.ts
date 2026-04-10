import { describe, expect, it, vi } from "vitest";

import {
	type CloudExecutionIntent,
	type CloudInstanceClient,
	CloudInstanceClientError,
	type CloudInstanceCreateRequest,
	CloudInstanceHttpClient,
	type CloudInstanceStatusResponse,
	type CreateInstanceOptions,
	cloudExecutionIntentSchema,
	cloudInstanceCreatedResponseSchema,
	cloudInstanceCreateRequestSchema,
	cloudInstanceStatusResponseSchema,
	generateIdempotencyKey,
	isRetryableStatusCode,
	RETRY_CONFIGS,
	taskInstanceMappingSchema,
} from "../../../src/cloud/cloud-instance-client";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const TEST_BASE_URL = "https://api.cloud.cline.bot";
const TEST_SERVICE_CREDENTIAL = "svc-test-credential-abc123";

function createTestIntent(overrides?: Partial<CloudExecutionIntent>): CloudExecutionIntent {
	return {
		repo_url: "https://github.com/cline/kanban.git",
		base_branch: "main",
		feature_branch_intent: "kanban/task-abc12",
		worktree_intent: "worktrees/task-abc12",
		execution_mode: "cloud_agent",
		attempt_number: 1,
		...overrides,
	};
}

function createTestRequest(overrides?: Partial<CloudInstanceCreateRequest>): CloudInstanceCreateRequest {
	return {
		user_id: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
		repo_url: "https://github.com/cline/kanban.git",
		api_key: "test-api-key",
		instance_type: "task-runner",
		github_pat: "ghp_test123",
		pr_base_branch: "main",
		...overrides,
	};
}

function createTestOptions(overrides?: Partial<CreateInstanceOptions>): CreateInstanceOptions {
	return {
		taskId: "abc12",
		idempotencyKey: "kanban:abc12:1:testkey",
		executionIntent: createTestIntent(),
		...overrides,
	};
}

const MOCK_CREATED_RESPONSE = {
	instance_id: "ins-01JTEST000000000000000001",
	user_id: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
	namespace: "cline-instances",
	hostname: "ins-01jtest000000000000000001.instances.cline.bot",
};

const MOCK_STATUS_RESPONSE: CloudInstanceStatusResponse = {
	instance_id: "ins-01JTEST000000000000000001",
	user_id: "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
	namespace: "cline-instances",
	state: "ready",
	hostname: "ins-01jtest000000000000000001.instances.cline.bot",
};

function mockResponse(body: unknown, status = 200, ok?: boolean): Response {
	return {
		ok: ok ?? (status >= 200 && status < 300),
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as Response;
}

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

/** Safely extract [url, init] from a fetch mock call at the given index. */
function fetchCall(mock: FetchMock, idx = 0): { url: string; init: RequestInit } {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const call = (mock.mock.calls as any[])[idx] as [string, RequestInit] | undefined;
	return { url: call?.[0] ?? "", init: call?.[1] ?? {} };
}

function createTestClient(fetchFn: typeof globalThis.fetch, overrides?: { delay?: (ms: number) => Promise<void> }) {
	return new CloudInstanceHttpClient({
		baseUrl: TEST_BASE_URL,
		serviceCredential: TEST_SERVICE_CREDENTIAL,
		fetch: fetchFn,
		delay: overrides?.delay ?? (async () => {}),
		retryConfigs: {
			createInstance: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
			getInstance: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
			deleteInstance: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
		},
	});
}

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("cloudInstanceCreateRequestSchema", () => {
	it("accepts a valid task-runner create request", () => {
		const result = cloudInstanceCreateRequestSchema.safeParse(createTestRequest());
		expect(result.success).toBe(true);
	});

	it("defaults pr_base_branch to main", () => {
		const input = createTestRequest();
		delete (input as Record<string, unknown>).pr_base_branch;
		const result = cloudInstanceCreateRequestSchema.parse(input);
		expect(result.pr_base_branch).toBe("main");
	});

	it("rejects empty user_id", () => {
		const result = cloudInstanceCreateRequestSchema.safeParse(createTestRequest({ user_id: "" }));
		expect(result.success).toBe(false);
	});

	it("rejects empty repo_url", () => {
		const result = cloudInstanceCreateRequestSchema.safeParse(createTestRequest({ repo_url: "" }));
		expect(result.success).toBe(false);
	});
});

describe("cloudInstanceCreatedResponseSchema", () => {
	it("accepts a valid created response", () => {
		const result = cloudInstanceCreatedResponseSchema.safeParse(MOCK_CREATED_RESPONSE);
		expect(result.success).toBe(true);
	});

	it("rejects missing instance_id", () => {
		const { instance_id: _, ...rest } = MOCK_CREATED_RESPONSE;
		const result = cloudInstanceCreatedResponseSchema.safeParse(rest);
		expect(result.success).toBe(false);
	});
});

describe("cloudInstanceStatusResponseSchema", () => {
	it("accepts all valid instance states", () => {
		for (const state of [
			"provisioning",
			"starting",
			"ready",
			"unhealthy",
			"failed",
			"requested",
			"creating",
			"executing",
			"stopping",
			"terminated",
		] as const) {
			const result = cloudInstanceStatusResponseSchema.safeParse({
				...MOCK_STATUS_RESPONSE,
				state,
			});
			expect(result.success).toBe(true);
		}
	});

	it("rejects invalid state", () => {
		const result = cloudInstanceStatusResponseSchema.safeParse({
			...MOCK_STATUS_RESPONSE,
			state: "nonexistent",
		});
		expect(result.success).toBe(false);
	});
});

describe("cloudExecutionIntentSchema", () => {
	it("accepts a valid intent with all required fields", () => {
		const result = cloudExecutionIntentSchema.safeParse(createTestIntent());
		expect(result.success).toBe(true);
	});

	it("accepts intent with optional starting_commit_sha", () => {
		const result = cloudExecutionIntentSchema.safeParse(createTestIntent({ starting_commit_sha: "abc123def456" }));
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.starting_commit_sha).toBe("abc123def456");
		}
	});

	it("rejects empty repo_url", () => {
		const result = cloudExecutionIntentSchema.safeParse(createTestIntent({ repo_url: "" }));
		expect(result.success).toBe(false);
	});

	it("rejects zero attempt_number", () => {
		const result = cloudExecutionIntentSchema.safeParse(createTestIntent({ attempt_number: 0 }));
		expect(result.success).toBe(false);
	});

	it("rejects invalid execution_mode", () => {
		const result = cloudExecutionIntentSchema.safeParse({
			...createTestIntent(),
			execution_mode: "invalid",
		});
		expect(result.success).toBe(false);
	});
});

describe("taskInstanceMappingSchema", () => {
	it("accepts a valid mapping", () => {
		const result = taskInstanceMappingSchema.safeParse({
			task_id: "abc12",
			instance_id: "ins-01JTEST000000000000000001",
			hostname: "ins-01jtest000000000000000001.instances.cline.bot",
			namespace: "cline-instances",
			attempt_number: 1,
			idempotency_key: "kanban:abc12:1:xyz",
			execution_intent: createTestIntent(),
			created_at: "2026-04-09T00:00:00.000Z",
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// createInstance tests
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient.createInstance", () => {
	it("sends POST to /instances/ with correct body and headers", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_CREATED_RESPONSE, 201));
		const client = createTestClient(fetchMock);

		await client.createInstance(createTestRequest(), createTestOptions());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const { url, init } = fetchCall(fetchMock);
		expect(url).toBe(`${TEST_BASE_URL}/instances/`);
		expect(init.method).toBe("POST");

		const body = JSON.parse(init.body as string);
		expect(body.user_id).toBe("usr-01ARZ3NDEKTSV4RRFFQ69G5FAV");
		expect(body.repo_url).toBe("https://github.com/cline/kanban.git");
		expect(body.instance_type).toBe("task-runner");
		expect(body.github_pat).toBe("ghp_test123");
		expect(body.pr_base_branch).toBe("main");
	});

	it("attaches Bearer auth header", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_CREATED_RESPONSE, 201));
		const client = createTestClient(fetchMock);

		await client.createInstance(createTestRequest(), createTestOptions());

		const { init: authInit } = fetchCall(fetchMock);
		const headers = authInit.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TEST_SERVICE_CREDENTIAL}`);
	});

	it("attaches Idempotency-Key header", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_CREATED_RESPONSE, 201));
		const client = createTestClient(fetchMock);

		const options = createTestOptions({ idempotencyKey: "kanban:abc12:1:unique" });
		await client.createInstance(createTestRequest(), options);

		const { init: idemInit } = fetchCall(fetchMock);
		const idemHeaders = idemInit.headers as Record<string, string>;
		expect(idemHeaders["Idempotency-Key"]).toBe("kanban:abc12:1:unique");
	});

	it("returns created response and task-to-instance mapping", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_CREATED_RESPONSE, 201));
		const client = createTestClient(fetchMock);

		const result = await client.createInstance(createTestRequest(), createTestOptions());

		expect(result.response.instance_id).toBe(MOCK_CREATED_RESPONSE.instance_id);
		expect(result.response.hostname).toBe(MOCK_CREATED_RESPONSE.hostname);
		expect(result.response.namespace).toBe(MOCK_CREATED_RESPONSE.namespace);

		expect(result.mapping.task_id).toBe("abc12");
		expect(result.mapping.instance_id).toBe(MOCK_CREATED_RESPONSE.instance_id);
		expect(result.mapping.hostname).toBe(MOCK_CREATED_RESPONSE.hostname);
		expect(result.mapping.attempt_number).toBe(1);
		expect(result.mapping.idempotency_key).toBe("kanban:abc12:1:testkey");
		expect(result.mapping.execution_intent.repo_url).toBe("https://github.com/cline/kanban.git");
		expect(result.mapping.execution_intent.base_branch).toBe("main");
		expect(result.mapping.execution_intent.feature_branch_intent).toBe("kanban/task-abc12");
		expect(result.mapping.execution_intent.execution_mode).toBe("cloud_agent");
		expect(result.mapping.created_at).toBeTruthy();
	});

	it("preserves execution intent in mapping", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_CREATED_RESPONSE, 201));
		const client = createTestClient(fetchMock);

		const intent = createTestIntent({
			starting_commit_sha: "abc123",
			attempt_number: 2,
		});
		const options = createTestOptions({ executionIntent: intent });

		const result = await client.createInstance(createTestRequest(), options);

		expect(result.mapping.execution_intent.starting_commit_sha).toBe("abc123");
		expect(result.mapping.execution_intent.attempt_number).toBe(2);
		expect(result.mapping.attempt_number).toBe(2);
	});
});
// ---------------------------------------------------------------------------
// getInstance tests
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient.getInstance", () => {
	it("sends GET to /instances/{id} with auth header", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_STATUS_RESPONSE));
		const client = createTestClient(fetchMock);

		await client.getInstance("ins-01JTEST000000000000000001");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const { url, init } = fetchCall(fetchMock);
		expect(url).toBe(`${TEST_BASE_URL}/instances/ins-01JTEST000000000000000001`);
		expect(init.method).toBe("GET");

		const getHeaders = init.headers as Record<string, string>;
		expect(getHeaders.Authorization).toBe(`Bearer ${TEST_SERVICE_CREDENTIAL}`);
	});

	it("does not attach Idempotency-Key header on GET", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_STATUS_RESPONSE));
		const client = createTestClient(fetchMock);

		await client.getInstance("ins-01JTEST000000000000000001");

		const { init: getInit } = fetchCall(fetchMock);
		const getIdemHeaders = getInit.headers as Record<string, string>;
		expect(getIdemHeaders["Idempotency-Key"]).toBeUndefined();
	});

	it("returns parsed instance status", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_STATUS_RESPONSE));
		const client = createTestClient(fetchMock);

		const result = await client.getInstance("ins-01JTEST000000000000000001");

		expect(result.instance_id).toBe("ins-01JTEST000000000000000001");
		expect(result.state).toBe("ready");
		expect(result.hostname).toBe("ins-01jtest000000000000000001.instances.cline.bot");
	});

	it("returns provisioning state for non-ready instance", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ ...MOCK_STATUS_RESPONSE, state: "provisioning" }));
		const client = createTestClient(fetchMock);

		const result = await client.getInstance("ins-01JTEST000000000000000001");
		expect(result.state).toBe("provisioning");
	});

	it("URL-encodes the instance ID", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_STATUS_RESPONSE));
		const client = createTestClient(fetchMock);

		await client.getInstance("ins-with/slash");

		const { url } = fetchCall(fetchMock);
		expect(url).toContain("ins-with%2Fslash");
	});
});

// ---------------------------------------------------------------------------
// deleteInstance tests
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient.deleteInstance", () => {
	it("sends DELETE to /instances/{id} with auth header", async () => {
		const fetchMock = vi.fn(async () => mockResponse(null, 204));
		const client = createTestClient(fetchMock);

		await client.deleteInstance("ins-01JTEST000000000000000001");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const { url, init } = fetchCall(fetchMock);
		expect(url).toBe(`${TEST_BASE_URL}/instances/ins-01JTEST000000000000000001`);
		expect(init.method).toBe("DELETE");

		const delHeaders = init.headers as Record<string, string>;
		expect(delHeaders.Authorization).toBe(`Bearer ${TEST_SERVICE_CREDENTIAL}`);
	});

	it("resolves on 204 No Content", async () => {
		const fetchMock = vi.fn(async () => mockResponse(null, 204));
		const client = createTestClient(fetchMock);

		await expect(client.deleteInstance("ins-01JTEST000000000000000001")).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient — error handling", () => {
	it("throws CloudInstanceClientError on 404", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ message: "Instance not found" }, 404, false));
		const client = createTestClient(fetchMock);

		await expect(client.getInstance("ins-nonexistent")).rejects.toThrow(CloudInstanceClientError);

		try {
			await client.getInstance("ins-nonexistent");
		} catch (err) {
			expect(err).toBeInstanceOf(CloudInstanceClientError);
			const clientErr = err as CloudInstanceClientError;
			expect(clientErr.statusCode).toBe(404);
			expect(clientErr.retryable).toBe(false);
			expect(clientErr.message).toBe("Instance not found");
		}
	});

	it("throws non-retryable error on 409 Conflict", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ message: "Conflict" }, 409, false));
		const client = createTestClient(fetchMock);

		try {
			await client.createInstance(createTestRequest(), createTestOptions());
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CloudInstanceClientError);
			const clientErr = err as CloudInstanceClientError;
			expect(clientErr.statusCode).toBe(409);
			expect(clientErr.retryable).toBe(false);
		}

		// 409 is not retried — only initial call
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("throws non-retryable error on 422", async () => {
		const fetchMock = vi.fn(async () =>
			mockResponse({ error: { code: "validation_error", message: "Invalid input" } }, 422, false),
		);
		const client = createTestClient(fetchMock);

		try {
			await client.createInstance(createTestRequest(), createTestOptions());
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CloudInstanceClientError);
			const clientErr = err as CloudInstanceClientError;
			expect(clientErr.statusCode).toBe(422);
			expect(clientErr.retryable).toBe(false);
			expect(clientErr.errorCode).toBe("validation_error");
			expect(clientErr.message).toBe("Invalid input");
		}
	});

	it("parses error with detail field (FastAPI style)", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ detail: "Not authorized" }, 403, false));
		const client = createTestClient(fetchMock);

		try {
			await client.getInstance("ins-123");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CloudInstanceClientError);
			expect((err as CloudInstanceClientError).message).toBe("Not authorized");
		}
	});

	it("uses default message when response body is not JSON", async () => {
		const fetchMock = vi.fn(async () => mockResponse(null, 400, false));
		// Override json to throw to simulate non-JSON body
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			json: async () => {
				throw new Error("not json");
			},
			text: async () => "plain text error",
			headers: new Headers(),
		} as unknown as Response);
		const client = createTestClient(fetchMock);

		try {
			await client.getInstance("ins-123");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CloudInstanceClientError);
			expect((err as CloudInstanceClientError).message).toContain("HTTP 400");
		}
	});
});

// ---------------------------------------------------------------------------
// Retry behavior tests
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient — retry behavior", () => {
	it("retries on 500 and succeeds on second attempt", async () => {
		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				return mockResponse({ message: "Internal Server Error" }, 500, false);
			}
			return mockResponse(MOCK_STATUS_RESPONSE);
		});
		const client = createTestClient(fetchMock);

		const result = await client.getInstance("ins-01JTEST000000000000000001");

		expect(result.state).toBe("ready");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries on 503 and succeeds on third attempt", async () => {
		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount++;
			if (callCount <= 2) {
				return mockResponse({ message: "Service Unavailable" }, 503, false);
			}
			return mockResponse(MOCK_CREATED_RESPONSE, 201);
		});
		const client = createTestClient(fetchMock);

		const result = await client.createInstance(createTestRequest(), createTestOptions());

		expect(result.response.instance_id).toBe(MOCK_CREATED_RESPONSE.instance_id);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("exhausts retries and throws last error on persistent 500", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ message: "Server Error" }, 500, false));
		const client = createTestClient(fetchMock);

		try {
			await client.getInstance("ins-123");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CloudInstanceClientError);
			expect((err as CloudInstanceClientError).statusCode).toBe(500);
			expect((err as CloudInstanceClientError).retryable).toBe(true);
		}

		// 1 initial + 2 retries = 3 total
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry 4xx errors (except 408/429)", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ message: "Bad Request" }, 400, false));
		const client = createTestClient(fetchMock);

		await expect(client.createInstance(createTestRequest(), createTestOptions())).rejects.toThrow(
			CloudInstanceClientError,
		);

		// No retries for 400
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries on 429 Too Many Requests", async () => {
		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				return mockResponse({ message: "Rate limited" }, 429, false);
			}
			return mockResponse(MOCK_STATUS_RESPONSE);
		});
		const client = createTestClient(fetchMock);

		const result = await client.getInstance("ins-01JTEST000000000000000001");

		expect(result.state).toBe("ready");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries on 408 Request Timeout", async () => {
		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				return mockResponse({ message: "Timeout" }, 408, false);
			}
			return mockResponse(MOCK_STATUS_RESPONSE);
		});
		const client = createTestClient(fetchMock);

		const result = await client.getInstance("ins-01JTEST000000000000000001");

		expect(result.state).toBe("ready");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries on network error (fetch throws)", async () => {
		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Network failure");
			}
			return mockResponse(MOCK_STATUS_RESPONSE);
		});
		const client = createTestClient(fetchMock);

		const result = await client.getInstance("ins-01JTEST000000000000000001");

		expect(result.state).toBe("ready");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("calls delay between retries with exponential backoff", async () => {
		const delays: number[] = [];
		const delayFn = async (ms: number) => {
			delays.push(ms);
		};

		const fetchMock = vi.fn(async () => mockResponse({ message: "Server Error" }, 500, false));
		const client = createTestClient(fetchMock, { delay: delayFn });

		try {
			await client.getInstance("ins-123");
		} catch {
			// Expected
		}

		// First retry: baseDelayMs * 2^0 = 10
		// Second retry: baseDelayMs * 2^1 = 20
		expect(delays).toHaveLength(2);
		expect(delays[0]).toBe(10);
		expect(delays[1]).toBe(20);
	});

	it("delete retries up to 3 times (4 total attempts)", async () => {
		const fetchMock = vi.fn(async () => mockResponse({ message: "Server Error" }, 500, false));
		const client = createTestClient(fetchMock);

		await expect(client.deleteInstance("ins-123")).rejects.toThrow(CloudInstanceClientError);

		// 1 initial + 3 retries = 4 total
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});

// ---------------------------------------------------------------------------
// isRetryableStatusCode tests
// ---------------------------------------------------------------------------

describe("isRetryableStatusCode", () => {
	it("returns false for 400 Bad Request", () => {
		expect(isRetryableStatusCode(400)).toBe(false);
	});

	it("returns false for 401 Unauthorized", () => {
		expect(isRetryableStatusCode(401)).toBe(false);
	});

	it("returns false for 403 Forbidden", () => {
		expect(isRetryableStatusCode(403)).toBe(false);
	});

	it("returns false for 404 Not Found", () => {
		expect(isRetryableStatusCode(404)).toBe(false);
	});

	it("returns false for 409 Conflict (runner rejects concurrent)", () => {
		expect(isRetryableStatusCode(409)).toBe(false);
	});

	it("returns false for 422 Unprocessable Entity", () => {
		expect(isRetryableStatusCode(422)).toBe(false);
	});

	it("returns true for 408 Request Timeout", () => {
		expect(isRetryableStatusCode(408)).toBe(true);
	});

	it("returns true for 429 Too Many Requests", () => {
		expect(isRetryableStatusCode(429)).toBe(true);
	});

	it("returns true for 500 Internal Server Error", () => {
		expect(isRetryableStatusCode(500)).toBe(true);
	});

	it("returns true for 502 Bad Gateway", () => {
		expect(isRetryableStatusCode(502)).toBe(true);
	});

	it("returns true for 503 Service Unavailable", () => {
		expect(isRetryableStatusCode(503)).toBe(true);
	});

	it("returns true for 504 Gateway Timeout", () => {
		expect(isRetryableStatusCode(504)).toBe(true);
	});

	it("returns false for 200 OK", () => {
		expect(isRetryableStatusCode(200)).toBe(false);
	});

	it("returns false for 204 No Content", () => {
		expect(isRetryableStatusCode(204)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// generateIdempotencyKey tests
// ---------------------------------------------------------------------------

describe("generateIdempotencyKey", () => {
	it("generates a key with the expected format", () => {
		const key = generateIdempotencyKey("abc12", 1);
		expect(key).toMatch(/^kanban:abc12:1:[a-z0-9]+$/);
	});

	it("includes task ID and attempt number", () => {
		const key = generateIdempotencyKey("xyz99", 3);
		expect(key).toContain("xyz99");
		expect(key).toContain(":3:");
	});

	it("generates unique keys on repeated calls", () => {
		const keys = new Set<string>();
		for (let i = 0; i < 20; i++) {
			keys.add(generateIdempotencyKey("task1", 1));
		}
		expect(keys.size).toBeGreaterThan(1);
	});
});

// ---------------------------------------------------------------------------
// RETRY_CONFIGS defaults (PRD Section 15.6)
// ---------------------------------------------------------------------------

describe("RETRY_CONFIGS", () => {
	it("createInstance: 2 retries, 3 min timeout", () => {
		expect(RETRY_CONFIGS.createInstance.maxRetries).toBe(2);
		expect(RETRY_CONFIGS.createInstance.timeoutMs).toBe(180_000);
	});

	it("getInstance: 2 retries, 30 sec timeout", () => {
		expect(RETRY_CONFIGS.getInstance.maxRetries).toBe(2);
		expect(RETRY_CONFIGS.getInstance.timeoutMs).toBe(30_000);
	});

	it("deleteInstance: 3 retries, 2 min timeout", () => {
		expect(RETRY_CONFIGS.deleteInstance.maxRetries).toBe(3);
		expect(RETRY_CONFIGS.deleteInstance.timeoutMs).toBe(120_000);
	});
});

// ---------------------------------------------------------------------------
// Injectable / mockable interface tests
// ---------------------------------------------------------------------------

describe("CloudInstanceClient interface — mockability", () => {
	it("can be satisfied by a mock implementation", async () => {
		const mockClient: CloudInstanceClient = {
			createInstance: vi.fn(async () => ({
				response: MOCK_CREATED_RESPONSE,
				mapping: {
					task_id: "abc12",
					instance_id: MOCK_CREATED_RESPONSE.instance_id,
					hostname: MOCK_CREATED_RESPONSE.hostname,
					namespace: MOCK_CREATED_RESPONSE.namespace,
					attempt_number: 1,
					idempotency_key: "kanban:abc12:1:mock",
					execution_intent: createTestIntent(),
					created_at: "2026-04-09T00:00:00.000Z",
				},
			})),
			getInstance: vi.fn(async () => MOCK_STATUS_RESPONSE),
			deleteInstance: vi.fn(async () => {}),
		};

		const createResult = await mockClient.createInstance(createTestRequest(), createTestOptions());
		expect(createResult.mapping.task_id).toBe("abc12");
		expect(mockClient.createInstance).toHaveBeenCalledTimes(1);

		const status = await mockClient.getInstance("ins-123");
		expect(status.state).toBe("ready");
		expect(mockClient.getInstance).toHaveBeenCalledTimes(1);

		await mockClient.deleteInstance("ins-123");
		expect(mockClient.deleteInstance).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Base URL normalization
// ---------------------------------------------------------------------------

describe("CloudInstanceHttpClient — base URL normalization", () => {
	it("strips trailing slashes from base URL", async () => {
		const fetchMock = vi.fn(async () => mockResponse(MOCK_STATUS_RESPONSE));
		const client = new CloudInstanceHttpClient({
			baseUrl: "https://api.cloud.cline.bot///",
			serviceCredential: TEST_SERVICE_CREDENTIAL,
			fetch: fetchMock,
			delay: async () => {},
		});

		await client.getInstance("ins-123");

		const { url } = fetchCall(fetchMock);
		expect(url).toBe("https://api.cloud.cline.bot/instances/ins-123");
	});
});

// ---------------------------------------------------------------------------
// CloudInstanceClientError tests
// ---------------------------------------------------------------------------

describe("CloudInstanceClientError", () => {
	it("is an instance of Error", () => {
		const err = new CloudInstanceClientError({
			message: "test",
			statusCode: 500,
			retryable: true,
		});
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("CloudInstanceClientError");
	});

	it("stores statusCode, retryable, and errorCode", () => {
		const err = new CloudInstanceClientError({
			message: "quota exceeded",
			statusCode: 429,
			retryable: true,
			errorCode: "quota_exceeded",
		});
		expect(err.statusCode).toBe(429);
		expect(err.retryable).toBe(true);
		expect(err.errorCode).toBe("quota_exceeded");
		expect(err.message).toBe("quota exceeded");
	});
});
