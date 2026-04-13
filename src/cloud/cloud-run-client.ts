// ---------------------------------------------------------------------------
// Cloud Run Client — B1
// @phase MVP
// @prd-section 5, 15.3
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// /run Request / Response Schemas
// ---------------------------------------------------------------------------

/**
 * Request body for POST /run on the task-runner.
 *
 * Matches the `RunRequest` struct in
 * `cloud-platform/apps/task-runner/runner/main.go`.
 */
export const cloudRunRequestSchema = z.object({
	prompt: z.string().min(1),
	callback_url: z.string().min(1),
	task_id: z.string().optional(),
	attempt_number: z.number().int().positive().optional(),
	branch_name: z.string().optional(),
	base_branch: z.string().optional(),
	starting_commit_sha: z.string().optional(),
	worktree_intent: z.string().optional(),
	reservation_id: z.string().optional(),
});
export type CloudRunRequest = z.infer<typeof cloudRunRequestSchema>;

/**
 * Successful response from POST /run (HTTP 202 Accepted).
 */
export const cloudRunAcceptedResponseSchema = z.object({
	status: z.literal("accepted"),
});
export type CloudRunAcceptedResponse = z.infer<typeof cloudRunAcceptedResponseSchema>;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/**
 * Error classification for /run invocation failures.
 *
 * These map to lifecycle transitions:
 * - `already_running` → runner already has an active task (HTTP 409)
 * - `bad_request`     → prompt/payload rejected (HTTP 400)
 * - `unauthorized`    → auth rejected (HTTP 401)
 * - `network_error`   → connection/transport failure
 * - `unexpected`      → any other HTTP status or parse failure
 */
export type CloudRunErrorKind = "already_running" | "bad_request" | "unauthorized" | "network_error" | "unexpected";

export class CloudRunInvocationError extends Error {
	readonly kind: CloudRunErrorKind;
	readonly statusCode: number | null;

	constructor(kind: CloudRunErrorKind, message: string, statusCode: number | null = null) {
		super(message);
		this.name = "CloudRunInvocationError";
		this.kind = kind;
		this.statusCode = statusCode;
	}
}

// ---------------------------------------------------------------------------
// Run Invocation Result
// ---------------------------------------------------------------------------

export type CloudRunInvocationResult =
	| {
			readonly success: true;
			readonly response: CloudRunAcceptedResponse;
	  }
	| {
			readonly success: false;
			readonly error: CloudRunInvocationError;
	  };

// ---------------------------------------------------------------------------
// HTTP Client Abstraction (for testability)
// ---------------------------------------------------------------------------

/** Minimal HTTP response for the /run client. */
export interface CloudRunHttpResponse {
	readonly status: number;
	readonly body: string;
}

/**
 * Abstraction over HTTP POST for testability.
 * Production code uses `fetch`; tests inject a fake.
 */
export interface CloudRunHttpClient {
	post(
		url: string,
		body: string,
		headers: Record<string, string>,
		signal?: AbortSignal,
	): Promise<CloudRunHttpResponse>;
}

/** Default HTTP client using global `fetch`. */
export const fetchHttpClient: CloudRunHttpClient = {
	async post(url, body, headers, signal) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers,
			signal,
		});
		const text = await response.text();
		return { status: response.status, body: text };
	},
};

// ---------------------------------------------------------------------------
// /run Invocation
// ---------------------------------------------------------------------------

/**
 * Invoke POST /run on a task-runner instance.
 *
 * @param hostname - Runner hostname (e.g. `runner-123.example.com`).
 * @param request  - The run request payload.
 * @param options  - Optional bearer token, abort signal, and HTTP client.
 * @returns Discriminated union: success with accepted response, or failure.
 */
export async function invokeRun(
	hostname: string,
	request: CloudRunRequest,
	options: {
		bearerToken?: string;
		signal?: AbortSignal;
		httpClient?: CloudRunHttpClient;
	} = {},
): Promise<CloudRunInvocationResult> {
	const httpClient = options.httpClient ?? fetchHttpClient;
	const url = `https://${hostname}/run`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (options.bearerToken) {
		headers.Authorization = `Bearer ${options.bearerToken}`;
	}

	const body = JSON.stringify(request);

	let httpResponse: CloudRunHttpResponse;
	try {
		httpResponse = await httpClient.post(url, body, headers, options.signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: new CloudRunInvocationError("network_error", `Failed to reach ${url}: ${message}`),
		};
	}

	if (httpResponse.status === 202) {
		return { success: true, response: { status: "accepted" } };
	}

	if (httpResponse.status === 409) {
		return {
			success: false,
			error: new CloudRunInvocationError("already_running", httpResponse.body || "A task is already running", 409),
		};
	}

	if (httpResponse.status === 400) {
		return {
			success: false,
			error: new CloudRunInvocationError("bad_request", httpResponse.body || "Invalid request", 400),
		};
	}

	if (httpResponse.status === 401) {
		return {
			success: false,
			error: new CloudRunInvocationError("unauthorized", httpResponse.body || "Unauthorized", 401),
		};
	}

	return {
		success: false,
		error: new CloudRunInvocationError(
			"unexpected",
			`Unexpected status ${httpResponse.status}: ${httpResponse.body}`,
			httpResponse.status,
		),
	};
}
