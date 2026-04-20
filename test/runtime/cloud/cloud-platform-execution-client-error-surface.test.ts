// ---------------------------------------------------------------------------
// WI-8 — CloudPlatformExecutionHttpClient error surface
//
// Regression test for "This operation was aborted" bubbling out of kanban as
// an opaque chat status when core-api was unreachable. The retry loop in
// `executeWithRetry` now wraps its terminal error in a
// `CloudPlatformExecutionError` whose message tells the operator:
//   - which METHOD + URL failed
//   - how many attempts were made
//   - the last HTTP status observed (if any)
//   - the per-attempt timeout
//   - the underlying cause (timeout vs. network vs. HTTP)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { CloudAuthProvider } from "../../../src/cloud/cloud-auth-provider";
import {
	CloudPlatformExecutionError,
	CloudPlatformExecutionHttpClient,
} from "../../../src/cloud/cloud-platform-execution-client";

const stubAuth: CloudAuthProvider = {
	getAuthHeaders: async () => ({ Authorization: "Bearer sk-test-123" }),
};

/**
 * Immediately-resolving delay stub. The retry loop's exponential backoff would
 * otherwise keep vitest busy for seconds per test.
 */
const noDelay = async () => {};

describe("CloudPlatformExecutionHttpClient error surface (WI-8)", () => {
	it("wraps retry-exhausted 5xx responses with method, URL, attempt count, and last status", async () => {
		const fetchMock: typeof globalThis.fetch = async () =>
			new Response("upstream fried", { status: 502 });

		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "https://core-api.local",
			authProvider: stubAuth,
			fetch: fetchMock,
			delay: noDelay,
			retryConfigs: {
				getStatus: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 1_000 },
			},
		});

		try {
			await client.getExecutionStatus("exec-123");
			throw new Error("expected getExecutionStatus to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(CloudPlatformExecutionError);
			const err = e as CloudPlatformExecutionError;
			expect(err.message).toContain("GET /api/v2/cloud-platform/instances/exec-123");
			expect(err.message).toContain("after 3 attempts");
			expect(err.message).toContain("last status HTTP 502");
			expect(err.message).toContain("1000ms per-attempt timeout");
			expect(err.statusCode).toBe(502);
			expect(err.retryable).toBe(true);
		}
	});

	it("wraps internal-timeout abort as REQUEST_TIMEOUT and preserves the URL context", async () => {
		// Simulate a core-api that never responds within the per-attempt
		// timeout budget — `fetchFn` rejects with an AbortError whenever the
		// AbortSignal it was passed fires. Mirrors what `undici`/`node:fetch`
		// actually produce.
		const fetchMock: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal as AbortSignal | undefined;
				if (signal) {
					signal.addEventListener(
						"abort",
						() => {
							const abortErr = new Error("The operation was aborted");
							abortErr.name = "AbortError";
							reject(abortErr);
						},
						{ once: true },
					);
				}
			});

		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "https://core-api.local",
			authProvider: stubAuth,
			fetch: fetchMock,
			delay: noDelay,
			retryConfigs: {
				createExecution: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 10 },
			},
		});

		try {
			await client.createExecution({
				taskId: "task-abc",
				attemptNumber: 1,
				executionMode: "cloud",
				orgId: "org-1",
				projectId: "proj-1",
				requestedByUserId: "user-1",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
				featureBranchIntent: "",
				worktreeIntent: "task-abc/attempt-1",
				prompt: "hello",
			});
			throw new Error("expected createExecution to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(CloudPlatformExecutionError);
			const err = e as CloudPlatformExecutionError;
			// Operator-actionable: tells the human *what* is hanging, not
			// "This operation was aborted".
			expect(err.message).toContain("POST /api/v2/cloud-platform/instances");
			expect(err.message).toContain("after 2 attempts");
			expect(err.message).toContain("10ms per-attempt timeout");
			expect(err.message).toContain("request timed out after 10ms");
			expect(err.errorCode).toBe("REQUEST_TIMEOUT");
		}
	});

	it("external-caller abort does not look like an internal timeout", async () => {
		// Pre-aborted signal — fetch is never called. We must not report this
		// as a timeout (the caller knows what they did; a misleading "timed
		// out" would send debuggers hunting for a nonexistent network issue).
		const abortController = new AbortController();
		abortController.abort();

		const fetchMock: typeof globalThis.fetch = async () => {
			throw new Error("fetch should not be called after external abort");
		};

		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "https://core-api.local",
			authProvider: stubAuth,
			fetch: fetchMock,
			delay: noDelay,
			retryConfigs: {
				cancelExecution: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 1_000 },
			},
		});

		try {
			await client.cancelExecution("exec-xyz", abortController.signal);
			throw new Error("expected cancelExecution to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(CloudPlatformExecutionError);
			const err = e as CloudPlatformExecutionError;
			expect(err.message).toContain("DELETE /api/v2/cloud-platform/instances/exec-xyz");
			expect(err.message).toContain("caller aborted the request");
			expect(err.message).not.toContain("timed out");
			expect(err.retryable).toBe(false);
		}
	});

	it("non-retryable HTTP error (422) is still wrapped with URL + attempt context", async () => {
		const fetchMock: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: { message: "baseBranch is required" } }), {
				status: 422,
				headers: { "Content-Type": "application/json" },
			});

		const client = new CloudPlatformExecutionHttpClient({
			baseUrl: "https://core-api.local",
			authProvider: stubAuth,
			fetch: fetchMock,
			delay: noDelay,
			retryConfigs: {
				createExecution: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 1_000 },
			},
		});

		try {
			await client.createExecution({
				taskId: "task-zzz",
				attemptNumber: 1,
				executionMode: "cloud",
				orgId: "org-1",
				projectId: "proj-1",
				requestedByUserId: "user-1",
				repoUrl: "https://github.com/cline/kanban.git",
				baseBranch: "main",
				featureBranchIntent: "",
				worktreeIntent: "task-zzz/attempt-1",
				prompt: "hello",
			});
			throw new Error("expected createExecution to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(CloudPlatformExecutionError);
			const err = e as CloudPlatformExecutionError;
			// Non-retryable errors bail on the first attempt — verify the
			// wrap reports "after 1 attempt" (singular!), not "1 attempts".
			expect(err.message).toContain("POST /api/v2/cloud-platform/instances");
			expect(err.message).toContain("after 1 attempt ");
			expect(err.message).toContain("last status HTTP 422");
			expect(err.message).toContain("baseBranch is required");
			expect(err.statusCode).toBe(422);
			expect(err.retryable).toBe(false);
		}
	});
});
