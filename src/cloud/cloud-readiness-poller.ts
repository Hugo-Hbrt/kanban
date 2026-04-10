import type { CloudInstanceClient, CloudInstanceState } from "./cloud-instance-client";
import type { CloudStateMapping } from "./cloud-instance-state-mapping";
import { isInstanceFailed, isInstanceReady, mapCloudInstanceState } from "./cloud-instance-state-mapping";

// ---------------------------------------------------------------------------
// Polling Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the readiness polling loop.
 * All timeouts are in milliseconds.
 */
export interface ReadinessPollerConfig {
	/** Base interval between polls. PRD: "every 2 to 5 seconds". @default 3_000 */
	readonly pollIntervalMs: number;
	/** Max total wait for readiness. PRD Section 8/15.6: 3 min. @default 180_000 */
	readonly provisionTimeoutMs: number;
	/** Max consecutive transient errors before giving up. @default 5 */
	readonly maxConsecutiveErrors: number;
	/** Backoff multiplier for transient error retries. @default 2 */
	readonly backoffMultiplier: number;
	/** Maximum backoff delay in ms. @default 15_000 */
	readonly maxBackoffMs: number;
}

/** Sensible defaults per PRD Section 8 / 15.5 / 15.6. */
export const DEFAULT_READINESS_POLLER_CONFIG: Readonly<ReadinessPollerConfig> = {
	pollIntervalMs: 3_000,
	provisionTimeoutMs: 180_000,
	maxConsecutiveErrors: 5,
	backoffMultiplier: 2,
	maxBackoffMs: 15_000,
};

// ---------------------------------------------------------------------------
// Polling Result
// ---------------------------------------------------------------------------

export type ReadinessPollerOutcome =
	| {
			readonly status: "ready";
			readonly instanceId: string;
			readonly hostname: string | undefined;
			readonly mapping: CloudStateMapping;
			readonly elapsedMs: number;
			readonly pollCount: number;
	  }
	| {
			readonly status: "failed";
			readonly instanceId: string;
			readonly reason: "instance_failed" | "provision_timeout" | "max_errors_exceeded" | "aborted";
			readonly lastCloudState: CloudInstanceState | null;
			readonly mapping: CloudStateMapping | null;
			readonly elapsedMs: number;
			readonly pollCount: number;
			readonly lastError: Error | null;
	  };

// ---------------------------------------------------------------------------
// Timer Abstraction (for testability)
// ---------------------------------------------------------------------------

/** Abstraction for setTimeout / Date.now so the poller can be unit-tested. */
export interface PollerTimers {
	now(): number;
	delay(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Default timers using real wall clock and setTimeout. */
export const realTimers: PollerTimers = {
	now: () => Date.now(),
	delay: (ms: number, signal?: AbortSignal): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				return;
			}
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
		}),
};

// ---------------------------------------------------------------------------
// Readiness Poller
// ---------------------------------------------------------------------------

/**
 * Poll a cloud-platform instance until it reaches `ready`, fails, or the
 * provisioning timeout expires.
 *
 * Returns a discriminated-union outcome:
 *   - `status: "ready"` — instance is ready for `/run`.
 *   - `status: "failed"` with `reason` indicating why polling stopped.
 *
 * Transient network/HTTP errors are retried with exponential backoff.
 * A successful poll resets the consecutive error counter.
 */
export async function pollForReadiness(
	client: CloudInstanceClient,
	instanceId: string,
	config: ReadinessPollerConfig = DEFAULT_READINESS_POLLER_CONFIG,
	signal?: AbortSignal,
	timers: PollerTimers = realTimers,
): Promise<ReadinessPollerOutcome> {
	const startTime = timers.now();
	let pollCount = 0;
	let consecutiveErrors = 0;
	let lastCloudState: CloudInstanceState | null = null;
	let lastError: Error | null = null;

	const buildFailed = (
		reason: "instance_failed" | "provision_timeout" | "max_errors_exceeded" | "aborted",
	): ReadinessPollerOutcome => ({
		status: "failed",
		instanceId,
		reason,
		lastCloudState,
		mapping: lastCloudState ? mapCloudInstanceState(lastCloudState) : null,
		elapsedMs: timers.now() - startTime,
		pollCount,
		lastError,
	});

	while (true) {
		if (signal?.aborted) return buildFailed("aborted");

		const elapsed = timers.now() - startTime;
		if (elapsed >= config.provisionTimeoutMs) {
			return buildFailed("provision_timeout");
		}

		pollCount += 1;
		try {
			const instance = await client.getInstance(instanceId, signal);
			lastCloudState = instance.state;
			consecutiveErrors = 0;
			lastError = null;

			if (isInstanceReady(instance.state)) {
				return {
					status: "ready",
					instanceId,
					hostname: instance.hostname,
					mapping: mapCloudInstanceState(instance.state),
					elapsedMs: timers.now() - startTime,
					pollCount,
				};
			}

			if (isInstanceFailed(instance.state)) {
				return {
					status: "failed",
					instanceId,
					reason: "instance_failed",
					lastCloudState: instance.state,
					mapping: mapCloudInstanceState(instance.state),
					elapsedMs: timers.now() - startTime,
					pollCount,
					lastError: null,
				};
			}

			await timers.delay(config.pollIntervalMs, signal);
		} catch (error) {
			if (signal?.aborted) return buildFailed("aborted");

			consecutiveErrors += 1;
			lastError = error instanceof Error ? error : new Error(String(error));

			if (consecutiveErrors >= config.maxConsecutiveErrors) {
				return buildFailed("max_errors_exceeded");
			}

			const backoff = Math.min(
				config.pollIntervalMs * config.backoffMultiplier ** (consecutiveErrors - 1),
				config.maxBackoffMs,
			);

			try {
				await timers.delay(backoff, signal);
			} catch {
				// delay aborted — caught at top of next iteration
			}
		}
	}
}
