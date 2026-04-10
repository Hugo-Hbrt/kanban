// ---------------------------------------------------------------------------
// Cloud Callback Handler — B1
// @phase MVP
// @prd-section 5, 15.8
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";

import {
	type CallbackHeaders,
	type CallbackIngestionContext,
	type CallbackIngestionResult,
	extractCallbackHeaders,
	ingestTerminalCallback,
} from "./cloud-callback-ingestion";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum callback request body size in bytes. */
const MAX_CALLBACK_BODY_BYTES = 64 * 1024; // 64 KB

/** Callback endpoint path prefix. */
export const CLOUD_CALLBACK_PATH = "/api/cloud/task-callback";

// ---------------------------------------------------------------------------
// HTTP Request Body Reader
// ---------------------------------------------------------------------------

function readCallbackBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_CALLBACK_BODY_BYTES) {
				reject(new Error("Callback body too large"));
				return;
			}
			body += chunk.toString("utf8");
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Route Parameter Extraction
// ---------------------------------------------------------------------------

/**
 * Extract task_id and attempt_number from the request URL path or query.
 *
 * Supports two URL patterns:
 *   - `/api/cloud/task-callback?task_id=X&attempt_number=N`
 *   - `/api/cloud/task-callback/{task_id}`
 */
export function extractRouteIdentity(requestUrl: URL): {
	taskId?: string;
	attemptNumber?: number;
} {
	const pathAfterPrefix = requestUrl.pathname.replace(/\/+$/, "").replace(CLOUD_CALLBACK_PATH, "");
	const pathTaskId = pathAfterPrefix.startsWith("/") ? pathAfterPrefix.slice(1).split("/")[0] : undefined;

	const queryTaskId = requestUrl.searchParams.get("task_id") ?? undefined;
	const queryAttempt = requestUrl.searchParams.get("attempt_number");
	const attemptNumber = queryAttempt ? Number.parseInt(queryAttempt, 10) : undefined;

	return {
		taskId: pathTaskId || queryTaskId || undefined,
		attemptNumber: Number.isFinite(attemptNumber) ? attemptNumber : undefined,
	};
}

// ---------------------------------------------------------------------------
// JSON Response Helper
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Callback HTTP Handler
// ---------------------------------------------------------------------------

/**
 * Optional hook invoked after a callback is successfully accepted.
 *
 * Called **after** the HTTP 200 response has been sent. Errors thrown
 * inside this callback are caught and logged — they never affect the
 * HTTP response that was already delivered to the task-runner.
 */
export type CloudCallbackAcceptedHook = (result: Extract<CallbackIngestionResult, { accepted: true }>) => Promise<void>;

/**
 * Handle an incoming cloud task-runner callback HTTP request.
 *
 * This function is designed to be called from the runtime server's
 * request handler when the request path matches {@link CLOUD_CALLBACK_PATH}.
 *
 * @param onAccepted - Optional hook triggered after an accepted callback
 *   has been acknowledged. Used to wire post-ingestion reconciliation
 *   (e.g. terminal state reconciliation) without coupling the HTTP
 *   handler to persistence internals.
 * @returns `true` if the request was handled, `false` if not a callback.
 */
export async function handleCloudCallback(
	req: IncomingMessage,
	res: ServerResponse,
	requestUrl: URL,
	ctx: CallbackIngestionContext,
	onAccepted?: CloudCallbackAcceptedHook,
): Promise<boolean> {
	const pathname = requestUrl.pathname.replace(/\/+$/, "");
	if (!pathname.startsWith(CLOUD_CALLBACK_PATH)) {
		return false;
	}

	// Only POST is accepted for callbacks.
	if (req.method !== "POST") {
		sendJson(res, 405, { error: "Method not allowed. Use POST." });
		return true;
	}

	// Read request body.
	let rawBody: string;
	try {
		rawBody = await readCallbackBody(req);
	} catch {
		sendJson(res, 400, { error: "Invalid or oversized request body." });
		return true;
	}

	// Extract headers and route identity.
	const headers: CallbackHeaders = extractCallbackHeaders(
		req.headers as Record<string, string | string[] | undefined>,
	);
	const routeIdentity = extractRouteIdentity(requestUrl);

	// Delegate to ingestion logic.
	const result: CallbackIngestionResult = await ingestTerminalCallback(rawBody, headers, routeIdentity, ctx);

	if (result.accepted === true) {
		sendJson(res, 200, {
			ok: true,
			taskId: result.taskId,
			instanceId: result.instanceId,
			fromState: result.fromState,
			toState: result.toState,
		});

		// Fire the post-acceptance hook (reconciliation, etc.) after responding.
		// Errors here must not propagate to the already-completed HTTP response.
		if (onAccepted) {
			try {
				await onAccepted(result);
			} catch {
				// Intentionally swallowed — the HTTP 200 was already sent.
				// Real deployments should log this via structured logging.
			}
		}
	} else if (result.duplicate) {
		// Duplicates return 200 to prevent sender retries.
		sendJson(res, 200, { ok: true, duplicate: true, reason: result.reason });
	} else {
		sendJson(res, result.httpStatus, { error: result.reason });
	}

	return true;
}
