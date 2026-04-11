import { describe, expect, it, vi } from "vitest";

import {
	auditEventRequestSchema,
	authorizeRequestSchema,
	authorizeResponseSchema,
	GovernanceHttpClient,
	type GovernanceLogger,
	isGovernanceRetryableStatus,
	parseGovernanceConfig,
	reserveBudgetRequestSchema,
	usageEventRequestSchema,
} from "../../../src/cloud/cloud-governance-client";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const TEST_BASE_URL = "https://governance.cline.bot";
const TEST_AUTH_TOKEN = "gov-test-token-abc123";

function mockResponse(body: unknown, status = 200, ok?: boolean): Response {
	return {
		ok: ok ?? (status >= 200 && status < 300),
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as Response;
}

/** Wrap data in core-platform's standard `{ data, success }` envelope. */
function wrapped(data: unknown): { data: unknown; success: boolean } {
	return { data, success: true };
}

function createTestClient(fetchFn: typeof globalThis.fetch, opts?: { failOpen?: boolean; logger?: GovernanceLogger }) {
	return new GovernanceHttpClient(
		{
			baseUrl: TEST_BASE_URL,
			authToken: TEST_AUTH_TOKEN,
			failOpen: opts?.failOpen ?? true,
			fetch: fetchFn,
			delay: async () => {},
			retryConfigs: {
				authorize: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
				reservation: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
				usage: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
				audit: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 5000 },
			},
		},
		opts?.logger,
	);
}

function createMockLogger(): GovernanceLogger & {
	infoCalls: Array<[string, Record<string, unknown>?]>;
	warnCalls: Array<[string, Record<string, unknown>?]>;
	errorCalls: Array<[string, Record<string, unknown>?]>;
} {
	const logger = {
		infoCalls: [] as Array<[string, Record<string, unknown>?]>,
		warnCalls: [] as Array<[string, Record<string, unknown>?]>,
		errorCalls: [] as Array<[string, Record<string, unknown>?]>,
		info(msg: string, meta?: Record<string, unknown>) {
			logger.infoCalls.push([msg, meta]);
		},
		warn(msg: string, meta?: Record<string, unknown>) {
			logger.warnCalls.push([msg, meta]);
		},
		error(msg: string, meta?: Record<string, unknown>) {
			logger.errorCalls.push([msg, meta]);
		},
	};
	return logger;
}

// ---------------------------------------------------------------------------
// Schema validation tests — authorizeRequestSchema
// ---------------------------------------------------------------------------

describe("authorizeRequestSchema", () => {
	it("accepts a valid request with all required fields", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task", image: "cline-runner:latest" },
			requestedLimits: { maxComputeSeconds: 1800, maxTokenBudget: 100_000 },
		});
		expect(result.success).toBe(true);
	});

	it("accepts a request with optional executionContext and tools", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task", image: "cline-runner:latest", tools: ["git", "npm"] },
			requestedLimits: { maxComputeSeconds: 300, maxTokenBudget: 5000 },
			executionContext: { repoUrl: "https://github.com/org/repo", baseBranch: "main" },
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty taskId", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task", image: "runner:latest" },
			requestedLimits: { maxComputeSeconds: 100, maxTokenBudget: 1000 },
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing orgId", () => {
		const result = authorizeRequestSchema.safeParse({
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task", image: "runner:latest" },
			requestedLimits: { maxComputeSeconds: 100, maxTokenBudget: 1000 },
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing userId", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task", image: "runner:latest" },
			requestedLimits: { maxComputeSeconds: 100, maxTokenBudget: 1000 },
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing executionMode", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			taskSpec: { type: "cline-task", image: "runner:latest" },
			requestedLimits: { maxComputeSeconds: 100, maxTokenBudget: 1000 },
		});
		expect(result.success).toBe(false);
	});

	it("rejects taskSpec with missing type", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { image: "runner:latest" },
			requestedLimits: { maxComputeSeconds: 100, maxTokenBudget: 1000 },
		});
		expect(result.success).toBe(false);
	});

	it("rejects taskSpec with missing image", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task" },
			requestedLimits: { maxComputeSeconds: 100, maxTokenBudget: 1000 },
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing requestedLimits", () => {
		const result = authorizeRequestSchema.safeParse({
			orgId: "org-1",
			userId: "user-1",
			taskId: "task-1",
			projectId: "proj-1",
			executionMode: "cloud_agent",
			taskSpec: { type: "cline-task", image: "runner:latest" },
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Schema validation tests — authorizeResponseSchema
// ---------------------------------------------------------------------------

describe("authorizeResponseSchema", () => {
	it("accepts allowed: true with policySnapshotId", () => {
		const result = authorizeResponseSchema.safeParse({ allowed: true, policySnapshotId: "snap-1" });
		expect(result.success).toBe(true);
	});

	it("accepts allowed: false with denialReason", () => {
		const result = authorizeResponseSchema.safeParse({
			allowed: false,
			denialReason: "over quota",
			policySnapshotId: "snap-1",
		});
		expect(result.success).toBe(true);
	});

	it("rejects non-boolean allowed", () => {
		const result = authorizeResponseSchema.safeParse({ allowed: "maybe" });
		expect(result.success).toBe(false);
	});

	it("rejects missing allowed field", () => {
		const result = authorizeResponseSchema.safeParse({ denialReason: "no allowed" });
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Schema validation tests — reserveBudgetRequestSchema
// ---------------------------------------------------------------------------

describe("reserveBudgetRequestSchema", () => {
	it("accepts a valid reservation request", () => {
		const result = reserveBudgetRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			maxComputeSeconds: 1800,
			maxTokenBudget: 100_000,
			maxCostUsd: 5.0,
		});
		expect(result.success).toBe(true);
	});

	it("accepts optional executionMode and executionContext", () => {
		const result = reserveBudgetRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			maxComputeSeconds: 900,
			maxTokenBudget: 50_000,
			maxCostUsd: 2.5,
			executionMode: "cloud_agent",
			executionContext: { repoUrl: "https://github.com/org/repo" },
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing orgId", () => {
		const result = reserveBudgetRequestSchema.safeParse({
			taskId: "task-1",
			maxComputeSeconds: 100,
			maxTokenBudget: 1000,
			maxCostUsd: 1.0,
		});
		expect(result.success).toBe(false);
	});

	it("rejects zero maxCostUsd", () => {
		const result = reserveBudgetRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			maxComputeSeconds: 100,
			maxTokenBudget: 1000,
			maxCostUsd: 0,
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Schema validation tests — usageEventRequestSchema
// ---------------------------------------------------------------------------

describe("usageEventRequestSchema", () => {
	it("accepts a valid usage event with required fields", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			userId: "user-1",
			executionMode: "cloud_agent",
		});
		expect(result.success).toBe(true);
	});

	it("accepts optional cpuSeconds, tokensIn, tokensOut, and resource fields", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			userId: "user-1",
			executionMode: "local_agent",
			cpuSeconds: 120.5,
			memoryGbSeconds: 45.2,
			tokensIn: 500,
			tokensOut: 1200,
			storageGbHours: 0.1,
			costUsd: 0.05,
			reservationId: "res-1",
			idempotencyKey: "idem-key-1",
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing orgId", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			userId: "user-1",
			executionMode: "cloud_agent",
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing userId", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			executionMode: "cloud_agent",
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing executionMode", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			orgId: "org-1",
			userId: "user-1",
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Schema validation tests — auditEventRequestSchema
// ---------------------------------------------------------------------------

describe("auditEventRequestSchema", () => {
	it("accepts a valid audit event with required fields", () => {
		const result = auditEventRequestSchema.safeParse({
			actor: { type: "system", id: "orchestrator" },
			action: "task.dequeue",
			resource: { type: "task", id: "task-1" },
			result: "success",
		});
		expect(result.success).toBe(true);
	});

	it("accepts optional metadata, orgId, userId, projectId, taskId, idempotencyKey", () => {
		const result = auditEventRequestSchema.safeParse({
			actor: { type: "user", id: "user-1" },
			action: "task.user_cancel",
			resource: { type: "task", id: "task-1" },
			result: "failure",
			metadata: {
				executionMode: "cloud_agent",
				repoUrl: "https://github.com/org/repo",
				policySnapshotId: "snap-1",
			},
			orgId: "org-1",
			userId: "user-1",
			projectId: "proj-1",
			taskId: "task-1",
			idempotencyKey: "idem-key-1",
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing actor", () => {
		const result = auditEventRequestSchema.safeParse({
			action: "task.dequeue",
			resource: { type: "task", id: "task-1" },
			result: "success",
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing action", () => {
		const result = auditEventRequestSchema.safeParse({
			actor: { type: "system", id: "orchestrator" },
			resource: { type: "task", id: "task-1" },
			result: "success",
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing resource", () => {
		const result = auditEventRequestSchema.safeParse({
			actor: { type: "system", id: "orchestrator" },
			action: "task.dequeue",
			result: "success",
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing result", () => {
		const result = auditEventRequestSchema.safeParse({
			actor: { type: "system", id: "orchestrator" },
			action: "task.dequeue",
			resource: { type: "task", id: "task-1" },
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isGovernanceRetryableStatus
// ---------------------------------------------------------------------------

describe("isGovernanceRetryableStatus", () => {
	it("returns false for 400", () => expect(isGovernanceRetryableStatus(400)).toBe(false));
	it("returns false for 403", () => expect(isGovernanceRetryableStatus(403)).toBe(false));
	it("returns true for 408", () => expect(isGovernanceRetryableStatus(408)).toBe(true));
	it("returns true for 429", () => expect(isGovernanceRetryableStatus(429)).toBe(true));
	it("returns true for 500", () => expect(isGovernanceRetryableStatus(500)).toBe(true));
	it("returns true for 503", () => expect(isGovernanceRetryableStatus(503)).toBe(true));
	it("returns false for 200", () => expect(isGovernanceRetryableStatus(200)).toBe(false));
});

// ---------------------------------------------------------------------------
// GovernanceHttpClient — checkAuthorization
// ---------------------------------------------------------------------------

const VALID_AUTH_REQUEST = {
	orgId: "org-1",
	userId: "user-1",
	taskId: "task-1",
	projectId: "proj-1",
	executionMode: "cloud_agent",
	taskSpec: { type: "cline-task", image: "cline-runner:latest" },
	requestedLimits: { maxComputeSeconds: 1800, maxTokenBudget: 100_000 },
};

describe("GovernanceHttpClient — checkAuthorization", () => {
	it("returns authorized on successful wrapped response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ allowed: true, policySnapshotId: "snap-1" })));
		const client = createTestClient(fetchMock);
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
		expect(result.policySnapshotId).toBe("snap-1");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/execution/authorize`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer svc_${TEST_AUTH_TOKEN}`);
		expect((init.headers as Record<string, string>)["X-Service-Name"]).toBe("kanban");
	});

	it("also handles unwrapped responses for backward compatibility", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse({ allowed: true }));
		const client = createTestClient(fetchMock);
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
	});

	it("sends the full request body matching core-platform contract", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse({ allowed: true }));
		const client = createTestClient(fetchMock);
		await client.checkAuthorization(VALID_AUTH_REQUEST);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.orgId).toBe("org-1");
		expect(body.userId).toBe("user-1");
		expect(body.executionMode).toBe("cloud_agent");
		expect(body.taskSpec.type).toBe("cline-task");
		expect(body.taskSpec.image).toBe("cline-runner:latest");
		expect(body.requestedLimits.maxComputeSeconds).toBe(1800);
		expect(body.requestedLimits.maxTokenBudget).toBe(100_000);
	});

	it("returns denied with denialReason from wrapped response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ allowed: false, denialReason: "over quota" })));
		const client = createTestClient(fetchMock);
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("denied");
		expect(result.reason).toBe("over quota");
	});

	it("fail-open returns authorized when governance is unreachable", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
		const logger = createMockLogger();
		const client = createTestClient(fetchMock, { failOpen: true, logger });
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
		expect(result.reason).toContain("fail-open");
		expect(logger.errorCalls.length).toBeGreaterThan(0);
		expect(logger.warnCalls.length).toBeGreaterThan(0);
	});

	it("fail-closed returns denied when governance is unreachable", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
		const client = createTestClient(fetchMock, { failOpen: false });
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("denied");
		expect(result.reason).toContain("Governance unreachable");
	});

	it("retries on 500 then succeeds", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(mockResponse({}, 500))
			.mockResolvedValueOnce(mockResponse(wrapped({ allowed: true })));
		const client = createTestClient(fetchMock);
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry on 403 (non-retryable)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse({}, 403));
		const client = createTestClient(fetchMock, { failOpen: true });
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// GovernanceHttpClient — reserveBudget
// ---------------------------------------------------------------------------

describe("GovernanceHttpClient — reserveBudget", () => {
	it("reserves budget successfully from wrapped response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ reservationId: "res-abc", expiresAt: "2026-04-11T00:00:00Z" })));
		const client = createTestClient(fetchMock);
		const result = await client.reserveBudget({
			taskId: "task-1",
			orgId: "org-1",
			maxComputeSeconds: 1800,
			maxTokenBudget: 100_000,
			maxCostUsd: 5.0,
		});
		expect(result.reservationId).toBe("res-abc");
		expect(result.expiresAt).toBe("2026-04-11T00:00:00Z");

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/usage/reservations`);
	});

	it("throws on server error (no graceful degradation for reservations)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse({}, 500));
		const client = createTestClient(fetchMock);
		await expect(
			client.reserveBudget({
				taskId: "task-1",
				orgId: "org-1",
				maxComputeSeconds: 100,
				maxTokenBudget: 1000,
				maxCostUsd: 1.0,
			}),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// GovernanceHttpClient — reportUsage
// ---------------------------------------------------------------------------

const VALID_USAGE_REQUEST = {
	taskId: "task-1",
	orgId: "org-1",
	userId: "user-1",
	executionMode: "cloud_agent",
	cpuSeconds: 120.5,
};

describe("GovernanceHttpClient — reportUsage", () => {
	it("reports usage event successfully from wrapped response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ accepted: true, eventId: "evt-1" })));
		const client = createTestClient(fetchMock);
		const result = await client.reportUsage(VALID_USAGE_REQUEST);
		expect(result.accepted).toBe(true);
		expect(result.eventId).toBe("evt-1");

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/usage/events`);
	});

	it("sends the full request body matching core-platform contract", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ accepted: true })));
		const client = createTestClient(fetchMock);
		await client.reportUsage({
			...VALID_USAGE_REQUEST,
			memoryGbSeconds: 10,
			storageGbHours: 0.5,
			costUsd: 0.25,
			reservationId: "res-1",
			idempotencyKey: "idem-1",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.orgId).toBe("org-1");
		expect(body.userId).toBe("user-1");
		expect(body.cpuSeconds).toBe(120.5);
		expect(body.memoryGbSeconds).toBe(10);
		expect(body.storageGbHours).toBe(0.5);
		expect(body.costUsd).toBe(0.25);
		expect(body.reservationId).toBe("res-1");
		expect(body.idempotencyKey).toBe("idem-1");
	});

	it("returns accepted:false on network error (graceful degradation)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("network down"));
		const client = createTestClient(fetchMock);
		const result = await client.reportUsage(VALID_USAGE_REQUEST);
		expect(result.accepted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// GovernanceHttpClient — reportAudit
// ---------------------------------------------------------------------------

const VALID_AUDIT_REQUEST = {
	actor: { type: "system", id: "orchestrator" },
	action: "task.dequeue",
	resource: { type: "task", id: "task-1" },
	result: "success",
	taskId: "task-1",
};

describe("GovernanceHttpClient — reportAudit", () => {
	it("reports audit event successfully from wrapped response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ accepted: true, eventId: "aud-1" })));
		const client = createTestClient(fetchMock);
		const result = await client.reportAudit(VALID_AUDIT_REQUEST);
		expect(result.accepted).toBe(true);

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/audit/events`);
	});

	it("sends the full request body matching core-platform contract", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse(wrapped({ accepted: true })));
		const client = createTestClient(fetchMock);
		await client.reportAudit({
			...VALID_AUDIT_REQUEST,
			orgId: "org-1",
			userId: "user-1",
			projectId: "proj-1",
			metadata: { executionMode: "cloud_agent", policySnapshotId: "snap-1" },
			idempotencyKey: "idem-aud-1",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.actor).toEqual({ type: "system", id: "orchestrator" });
		expect(body.action).toBe("task.dequeue");
		expect(body.resource).toEqual({ type: "task", id: "task-1" });
		expect(body.result).toBe("success");
		expect(body.orgId).toBe("org-1");
		expect(body.metadata.executionMode).toBe("cloud_agent");
		expect(body.idempotencyKey).toBe("idem-aud-1");
	});

	it("returns accepted:false on network error (graceful degradation)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("timeout"));
		const client = createTestClient(fetchMock);
		const result = await client.reportAudit(VALID_AUDIT_REQUEST);
		expect(result.accepted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseGovernanceConfig
// ---------------------------------------------------------------------------

describe("parseGovernanceConfig", () => {
	it("returns null when base URL is not set", () => {
		const result = parseGovernanceConfig({});
		expect(result).toBeNull();
	});

	it("parses config from environment variables", () => {
		const result = parseGovernanceConfig({
			KANBAN_GOVERNANCE_BASE_URL: "https://gov.test",
			KANBAN_GOVERNANCE_AUTH_TOKEN: "tok-123",
			KANBAN_GOVERNANCE_FAIL_OPEN: "false",
		});
		expect(result).not.toBeNull();
		expect(result?.baseUrl).toBe("https://gov.test");
		expect(result?.authToken).toBe("tok-123");
		expect(result?.failOpen).toBe(false);
	});

	it("defaults failOpen to true", () => {
		const result = parseGovernanceConfig({
			KANBAN_GOVERNANCE_BASE_URL: "https://gov.test",
		});
		expect(result?.failOpen).toBe(true);
	});

	it("respects overrides", () => {
		const result = parseGovernanceConfig(
			{ KANBAN_GOVERNANCE_BASE_URL: "https://gov.test" },
			{ failOpen: false, authToken: "override-tok" },
		);
		expect(result?.failOpen).toBe(false);
		expect(result?.authToken).toBe("override-tok");
	});
});
