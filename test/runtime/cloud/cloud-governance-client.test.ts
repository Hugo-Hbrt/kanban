import { describe, expect, it, vi } from "vitest";

import {
	auditEventRequestSchema,
	authorizeRequestSchema,
	authorizeResponseSchema,
	GovernanceHttpClient,
	type GovernanceLogger,
	isGovernanceRetryableStatus,
	parseGovernanceConfig,
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
// Schema validation tests
// ---------------------------------------------------------------------------

describe("authorizeRequestSchema", () => {
	it("accepts a valid request", () => {
		const result = authorizeRequestSchema.safeParse({
			taskId: "task-1",
			projectId: "proj-1",
			taskSpec: { prompt: "Fix the bug" },
		});
		expect(result.success).toBe(true);
	});

	it("accepts a request with all optional taskSpec and requestedLimits fields", () => {
		const result = authorizeRequestSchema.safeParse({
			taskId: "task-1",
			projectId: "proj-1",
			taskSpec: { prompt: "Fix the bug", baseRef: "main", executionMode: "cloud_agent" },
			requestedLimits: { maxDurationSeconds: 300, maxTokens: 5000 },
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty taskId", () => {
		const result = authorizeRequestSchema.safeParse({
			taskId: "",
			projectId: "proj-1",
			taskSpec: { prompt: "Fix the bug" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing projectId", () => {
		const result = authorizeRequestSchema.safeParse({
			taskId: "task-1",
			taskSpec: { prompt: "Fix the bug" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing taskSpec", () => {
		const result = authorizeRequestSchema.safeParse({
			taskId: "task-1",
			projectId: "proj-1",
		});
		expect(result.success).toBe(false);
	});
});

describe("authorizeResponseSchema", () => {
	it("accepts allowed: true", () => {
		const result = authorizeResponseSchema.safeParse({ allowed: true });
		expect(result.success).toBe(true);
	});

	it("accepts allowed: false with reason and policySnapshotId", () => {
		const result = authorizeResponseSchema.safeParse({
			allowed: false,
			reason: "over quota",
			policySnapshotId: "snap-1",
		});
		expect(result.success).toBe(true);
	});

	it("rejects non-boolean allowed", () => {
		const result = authorizeResponseSchema.safeParse({ allowed: "maybe" });
		expect(result.success).toBe(false);
	});

	it("rejects missing allowed field", () => {
		const result = authorizeResponseSchema.safeParse({ reason: "no allowed" });
		expect(result.success).toBe(false);
	});
});

describe("usageEventRequestSchema", () => {
	it("accepts a valid usage event with executionMode", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			terminalState: "completed",
			executionMode: "cloud_agent",
		});
		expect(result.success).toBe(true);
	});

	it("accepts optional tokensIn and tokensOut", () => {
		const result = usageEventRequestSchema.safeParse({
			taskId: "task-1",
			terminalState: "completed",
			executionMode: "local_agent",
			tokensIn: 500,
			tokensOut: 1200,
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing terminalState", () => {
		const result = usageEventRequestSchema.safeParse({ taskId: "task-1", executionMode: "cloud_agent" });
		expect(result.success).toBe(false);
	});

	it("rejects missing executionMode", () => {
		const result = usageEventRequestSchema.safeParse({ taskId: "task-1", terminalState: "completed" });
		expect(result.success).toBe(false);
	});
});

describe("auditEventRequestSchema", () => {
	it("accepts a valid audit event", () => {
		const result = auditEventRequestSchema.safeParse({
			taskId: "task-1",
			eventType: "lifecycle_transition",
			fromState: "queued",
			toState: "policy_check",
			trigger: "dequeue",
			triggerSource: "system",
			timestamp: new Date().toISOString(),
		});
		expect(result.success).toBe(true);
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
	taskId: "task-1",
	projectId: "proj-1",
	taskSpec: { prompt: "Fix the bug" },
};

describe("GovernanceHttpClient — checkAuthorization", () => {
	it("returns authorized on successful response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse({ allowed: true, policySnapshotId: "snap-1" }));
		const client = createTestClient(fetchMock);
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
		expect(result.policySnapshotId).toBe("snap-1");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/execution/authorize`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_AUTH_TOKEN}`);
	});

	it("returns denied on denied response", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse({ allowed: false, reason: "over quota" }));
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
			.mockResolvedValueOnce(mockResponse({ allowed: true }));
		const client = createTestClient(fetchMock);
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		expect(result.decision).toBe("authorized");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry on 403 (non-retryable)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse({}, 403));
		const client = createTestClient(fetchMock, { failOpen: true });
		const result = await client.checkAuthorization(VALID_AUTH_REQUEST);
		// fail-open catches the GovernanceClientError and returns authorized
		expect(result.decision).toBe("authorized");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// GovernanceHttpClient — reportUsage
// ---------------------------------------------------------------------------

describe("GovernanceHttpClient — reportUsage", () => {
	it("reports usage event successfully", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse({ accepted: true, eventId: "evt-1" }));
		const client = createTestClient(fetchMock);
		const result = await client.reportUsage({
			taskId: "task-1",
			terminalState: "completed",
			executionMode: "cloud_agent",
		});
		expect(result.accepted).toBe(true);
		expect(result.eventId).toBe("evt-1");

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/usage/events`);
	});

	it("returns accepted:false on network error (graceful degradation)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("network down"));
		const client = createTestClient(fetchMock);
		const result = await client.reportUsage({
			taskId: "task-1",
			terminalState: "failed",
			executionMode: "local_agent",
		});
		expect(result.accepted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// GovernanceHttpClient — reportAudit
// ---------------------------------------------------------------------------

describe("GovernanceHttpClient — reportAudit", () => {
	it("reports audit event successfully", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(mockResponse({ accepted: true, eventId: "aud-1" }));
		const client = createTestClient(fetchMock);
		const result = await client.reportAudit({
			taskId: "task-1",
			eventType: "lifecycle_transition",
			fromState: "queued",
			toState: "policy_check",
			trigger: "dequeue",
			triggerSource: "system",
			timestamp: new Date().toISOString(),
		});
		expect(result.accepted).toBe(true);

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TEST_BASE_URL}/api/v1/audit/events`);
	});

	it("returns accepted:false on network error (graceful degradation)", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("timeout"));
		const client = createTestClient(fetchMock);
		const result = await client.reportAudit({
			taskId: "task-1",
			eventType: "lifecycle_transition",
			fromState: "running",
			toState: "failed",
			trigger: "execution_error",
			triggerSource: "system",
			timestamp: new Date().toISOString(),
		});
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
