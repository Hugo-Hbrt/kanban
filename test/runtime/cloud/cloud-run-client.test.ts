import { describe, expect, it } from "vitest";

import {
	type CloudRunHttpClient,
	type CloudRunHttpResponse,
	CloudRunInvocationError,
	type CloudRunRequest,
	invokeRun,
} from "../../../src/cloud/cloud-run-client";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createBaseRequest(overrides: Partial<CloudRunRequest> = {}): CloudRunRequest {
	return {
		prompt: "Implement the login feature",
		callback_url: "https://kanban.example.com/callback/task-1",
		task_id: "task-1",
		attempt_number: 1,
		...overrides,
	};
}

/** Create a fake HTTP client returning the given response. */
function createFakeHttpClient(
	response: CloudRunHttpResponse,
): CloudRunHttpClient & { calls: Array<{ url: string; body: string; headers: Record<string, string> }> } {
	const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
	return {
		calls,
		post: async (url, body, headers) => {
			calls.push({ url, body, headers });
			return response;
		},
	};
}

/** Create a fake HTTP client that throws on post. */
function createErrorHttpClient(error: Error): CloudRunHttpClient {
	return {
		post: async () => {
			throw error;
		},
	};
}

const HOSTNAME = "runner-abc.example.com";

// ---------------------------------------------------------------------------
// Success path (HTTP 202)
// ---------------------------------------------------------------------------

describe("invokeRun — success", () => {
	it("returns success for HTTP 202 Accepted", async () => {
		const httpClient = createFakeHttpClient({ status: 202, body: '{"status":"accepted"}' });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.response.status).toBe("accepted");
		}
	});

	it("sends POST to https://{hostname}/run", async () => {
		const httpClient = createFakeHttpClient({ status: 202, body: '{"status":"accepted"}' });
		await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(httpClient.calls).toHaveLength(1);
		expect(httpClient.calls[0]?.url).toBe(`https://${HOSTNAME}/run`);
	});

	it("sends JSON Content-Type header", async () => {
		const httpClient = createFakeHttpClient({ status: 202, body: '{"status":"accepted"}' });
		await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(httpClient.calls[0]?.headers["Content-Type"]).toBe("application/json");
	});

	it("sends request body matching the runner contract", async () => {
		const httpClient = createFakeHttpClient({ status: 202, body: '{"status":"accepted"}' });
		const request = createBaseRequest();
		await invokeRun(HOSTNAME, request, { httpClient });

		const sentBody = JSON.parse(httpClient.calls[0]?.body ?? "{}");
		expect(sentBody.prompt).toBe(request.prompt);
		expect(sentBody.callback_url).toBe(request.callback_url);
		expect(sentBody.task_id).toBe(request.task_id);
		expect(sentBody.attempt_number).toBe(request.attempt_number);
	});

	it("includes Authorization header when bearerToken is provided", async () => {
		const httpClient = createFakeHttpClient({ status: 202, body: '{"status":"accepted"}' });
		await invokeRun(HOSTNAME, createBaseRequest(), {
			httpClient,
			bearerToken: "secret-token-123",
		});

		expect(httpClient.calls[0]?.headers.Authorization).toBe("Bearer secret-token-123");
	});

	it("omits Authorization header when bearerToken is not provided", async () => {
		const httpClient = createFakeHttpClient({ status: 202, body: '{"status":"accepted"}' });
		await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(httpClient.calls[0]?.headers.Authorization).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Error paths — HTTP status codes
// ---------------------------------------------------------------------------

describe("invokeRun — HTTP 409 Conflict", () => {
	it("returns already_running error", async () => {
		const httpClient = createFakeHttpClient({ status: 409, body: "A task is already running" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("already_running");
			expect(result.error.statusCode).toBe(409);
			expect(result.error.message).toContain("already running");
		}
	});
});

describe("invokeRun — HTTP 400 Bad Request", () => {
	it("returns bad_request error for missing prompt", async () => {
		const httpClient = createFakeHttpClient({ status: 400, body: "prompt is required" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("bad_request");
			expect(result.error.statusCode).toBe(400);
			expect(result.error.message).toContain("prompt is required");
		}
	});

	it("returns bad_request error for missing callback_url", async () => {
		const httpClient = createFakeHttpClient({ status: 400, body: "callback_url is required" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("bad_request");
			expect(result.error.statusCode).toBe(400);
		}
	});
});

describe("invokeRun — HTTP 401 Unauthorized", () => {
	it("returns unauthorized error", async () => {
		const httpClient = createFakeHttpClient({ status: 401, body: "Unauthorized" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("unauthorized");
			expect(result.error.statusCode).toBe(401);
		}
	});
});

describe("invokeRun — unexpected HTTP status", () => {
	it("returns unexpected error for HTTP 500", async () => {
		const httpClient = createFakeHttpClient({ status: 500, body: "Internal Server Error" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("unexpected");
			expect(result.error.statusCode).toBe(500);
			expect(result.error.message).toContain("500");
		}
	});

	it("returns unexpected error for HTTP 503", async () => {
		const httpClient = createFakeHttpClient({ status: 503, body: "Service Unavailable" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("unexpected");
			expect(result.error.statusCode).toBe(503);
		}
	});
});
// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe("invokeRun — network errors", () => {
	it("returns network_error when fetch throws", async () => {
		const httpClient = createErrorHttpClient(new Error("ECONNREFUSED"));
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("network_error");
			expect(result.error.statusCode).toBeNull();
			expect(result.error.message).toContain("ECONNREFUSED");
			expect(result.error.message).toContain(HOSTNAME);
		}
	});

	it("returns network_error for DNS resolution failure", async () => {
		const httpClient = createErrorHttpClient(new Error("getaddrinfo ENOTFOUND"));
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("network_error");
		}
	});

	it("returns network_error for non-Error throws", async () => {
		const httpClient: CloudRunHttpClient = {
			post: async () => {
				throw "string error";
			},
		};
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("network_error");
			expect(result.error.message).toContain("string error");
		}
	});
});

// ---------------------------------------------------------------------------
// CloudRunInvocationError
// ---------------------------------------------------------------------------

describe("CloudRunInvocationError", () => {
	it("captures kind, message, and statusCode", () => {
		const error = new CloudRunInvocationError("bad_request", "prompt is required", 400);
		expect(error.name).toBe("CloudRunInvocationError");
		expect(error.kind).toBe("bad_request");
		expect(error.message).toBe("prompt is required");
		expect(error.statusCode).toBe(400);
		expect(error).toBeInstanceOf(Error);
	});

	it("defaults statusCode to null", () => {
		const error = new CloudRunInvocationError("network_error", "connection refused");
		expect(error.statusCode).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Empty response body fallbacks
// ---------------------------------------------------------------------------

describe("invokeRun — empty body fallbacks", () => {
	it("uses fallback message for empty 409 body", async () => {
		const httpClient = createFakeHttpClient({ status: 409, body: "" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("already_running");
			expect(result.error.message).toBe("A task is already running");
		}
	});

	it("uses fallback message for empty 400 body", async () => {
		const httpClient = createFakeHttpClient({ status: 400, body: "" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("bad_request");
			expect(result.error.message).toBe("Invalid request");
		}
	});

	it("uses fallback message for empty 401 body", async () => {
		const httpClient = createFakeHttpClient({ status: 401, body: "" });
		const result = await invokeRun(HOSTNAME, createBaseRequest(), { httpClient });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("unauthorized");
			expect(result.error.message).toBe("Unauthorized");
		}
	});
});
