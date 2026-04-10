import { describe, expect, it } from "vitest";

import type {
	CloudInstanceClient,
	CloudInstanceResponse,
	CloudInstanceState,
} from "../../../src/cloud/cloud-instance-client";
import type { PollerTimers, ReadinessPollerConfig } from "../../../src/cloud/cloud-readiness-poller";
import { DEFAULT_READINESS_POLLER_CONFIG, pollForReadiness } from "../../../src/cloud/cloud-readiness-poller";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a fake timer that advances instantly and tracks delay calls. */
function createFakeTimers(): PollerTimers & { currentTime: number; delays: number[] } {
	const state = { currentTime: 0, delays: [] as number[] };
	return {
		get currentTime() {
			return state.currentTime;
		},
		get delays() {
			return state.delays;
		},
		now: () => state.currentTime,
		delay: async (ms: number, signal?: AbortSignal) => {
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("Aborted", "AbortError");
			}
			state.delays.push(ms);
			state.currentTime += ms;
		},
	};
}

/** Create a mock client that returns a sequence of states. */
function createSequenceClient(
	sequence: Array<{ state: CloudInstanceState; hostname?: string }>,
): CloudInstanceClient & { callCount: number } {
	let idx = 0;
	const client = {
		callCount: 0,
		getInstance: async (instanceId: string): Promise<CloudInstanceResponse> => {
			client.callCount += 1;
			const entry = sequence[Math.min(idx, sequence.length - 1)];
			idx += 1;
			return {
				instance_id: instanceId,
				state: entry?.state,
				hostname: entry?.hostname,
			};
		},
	};
	return client;
}

/** Create a mock client that throws errors for the first N calls. */
function createErrorThenSuccessClient(
	errorCount: number,
	successState: CloudInstanceState = "ready",
	hostname?: string,
): CloudInstanceClient & { callCount: number } {
	let calls = 0;
	const client = {
		callCount: 0,
		getInstance: async (instanceId: string): Promise<CloudInstanceResponse> => {
			client.callCount += 1;
			calls += 1;
			if (calls <= errorCount) {
				throw new Error(`Transient error ${calls}`);
			}
			return { instance_id: instanceId, state: successState, hostname };
		},
	};
	return client;
}

const FAST_CONFIG: ReadinessPollerConfig = {
	pollIntervalMs: 100,
	provisionTimeoutMs: 10_000,
	maxConsecutiveErrors: 5,
	backoffMultiplier: 2,
	maxBackoffMs: 1_000,
};

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

describe("DEFAULT_READINESS_POLLER_CONFIG", () => {
	it("has a 3-second poll interval", () => {
		expect(DEFAULT_READINESS_POLLER_CONFIG.pollIntervalMs).toBe(3_000);
	});

	it("has a 3-minute provision timeout", () => {
		expect(DEFAULT_READINESS_POLLER_CONFIG.provisionTimeoutMs).toBe(180_000);
	});

	it("has reasonable max consecutive errors", () => {
		expect(DEFAULT_READINESS_POLLER_CONFIG.maxConsecutiveErrors).toBeGreaterThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// Polling success path
// ---------------------------------------------------------------------------

describe("pollForReadiness — success", () => {
	it("returns ready immediately when instance is already ready", async () => {
		const client = createSequenceClient([{ state: "ready", hostname: "h1.example.com" }]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-1", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.instanceId).toBe("inst-1");
			expect(result.hostname).toBe("h1.example.com");
			expect(result.mapping.cloudState).toBe("ready");
			expect(result.mapping.trigger).toBe("sandbox_ready");
			expect(result.pollCount).toBe(1);
		}
	});

	it("polls through provisioning states then returns ready", async () => {
		const client = createSequenceClient([
			{ state: "provisioning" },
			{ state: "starting" },
			{ state: "ready", hostname: "runner.example.com" },
		]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-2", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.pollCount).toBe(3);
			expect(result.hostname).toBe("runner.example.com");
		}
		expect(client.callCount).toBe(3);
	});

	it("polls through requested/creating target states", async () => {
		const client = createSequenceClient([
			{ state: "requested" },
			{ state: "creating" },
			{ state: "ready", hostname: "target.example.com" },
		]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-3", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.pollCount).toBe(3);
		}
	});

	it("waits pollIntervalMs between polls", async () => {
		const client = createSequenceClient([{ state: "provisioning" }, { state: "ready" }]);
		const timers = createFakeTimers();

		await pollForReadiness(client, "inst-4", FAST_CONFIG, undefined, timers);

		// After first poll (provisioning), should delay by pollIntervalMs
		expect(timers.delays).toEqual([FAST_CONFIG.pollIntervalMs]);
	});
});
// ---------------------------------------------------------------------------
// Polling timeout path
// ---------------------------------------------------------------------------

describe("pollForReadiness — provision timeout", () => {
	it("returns provision_timeout when timeout expires during provisioning", async () => {
		// Instance stays in "provisioning" forever
		const client = createSequenceClient([
			{ state: "provisioning" },
			{ state: "provisioning" },
			{ state: "provisioning" },
			{ state: "provisioning" },
			{ state: "provisioning" },
		]);
		const timers = createFakeTimers();
		const config: ReadinessPollerConfig = {
			...FAST_CONFIG,
			provisionTimeoutMs: 250, // very short timeout
			pollIntervalMs: 100,
		};

		const result = await pollForReadiness(client, "inst-timeout", config, undefined, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("provision_timeout");
			expect(result.lastCloudState).toBe("provisioning");
			expect(result.elapsedMs).toBeGreaterThanOrEqual(config.provisionTimeoutMs);
			expect(result.pollCount).toBeGreaterThanOrEqual(2);
		}
	});

	it("returns provision_timeout when timeout is 0", async () => {
		const client = createSequenceClient([{ state: "provisioning" }]);
		const timers = createFakeTimers();
		const config: ReadinessPollerConfig = { ...FAST_CONFIG, provisionTimeoutMs: 0 };

		const result = await pollForReadiness(client, "inst-zero", config, undefined, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("provision_timeout");
			expect(result.pollCount).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Instance failure path
// ---------------------------------------------------------------------------

describe("pollForReadiness — instance failure", () => {
	it('returns instance_failed when state is "failed"', async () => {
		const client = createSequenceClient([{ state: "provisioning" }, { state: "failed" }]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-fail", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("instance_failed");
			expect(result.lastCloudState).toBe("failed");
			expect(result.mapping).not.toBeNull();
			expect(result.mapping?.kanbanPhase).toBe("failed");
			expect(result.pollCount).toBe(2);
			expect(result.lastError).toBeNull();
		}
	});

	it('returns instance_failed when state is "unhealthy"', async () => {
		const client = createSequenceClient([{ state: "unhealthy" }]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-unhealth", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("instance_failed");
			expect(result.lastCloudState).toBe("unhealthy");
			expect(result.pollCount).toBe(1);
		}
	});
});
// ---------------------------------------------------------------------------
// Transient error recovery
// ---------------------------------------------------------------------------

describe("pollForReadiness — transient error recovery", () => {
	it("recovers from transient errors and returns ready", async () => {
		const client = createErrorThenSuccessClient(2, "ready", "recovered.example.com");
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-recover", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.hostname).toBe("recovered.example.com");
			expect(result.pollCount).toBe(3); // 2 errors + 1 success
		}
	});

	it("uses exponential backoff for transient errors", async () => {
		const client = createErrorThenSuccessClient(3, "ready");
		const timers = createFakeTimers();
		const config: ReadinessPollerConfig = {
			...FAST_CONFIG,
			pollIntervalMs: 100,
			backoffMultiplier: 2,
			maxBackoffMs: 10_000,
		};

		await pollForReadiness(client, "inst-backoff", config, undefined, timers);

		// Error 1: backoff = 100 * 2^0 = 100
		// Error 2: backoff = 100 * 2^1 = 200
		// Error 3: backoff = 100 * 2^2 = 400
		expect(timers.delays).toEqual([100, 200, 400]);
	});

	it("caps backoff at maxBackoffMs", async () => {
		const client = createErrorThenSuccessClient(4, "ready");
		const timers = createFakeTimers();
		const config: ReadinessPollerConfig = {
			...FAST_CONFIG,
			pollIntervalMs: 100,
			backoffMultiplier: 3,
			maxBackoffMs: 500,
		};

		await pollForReadiness(client, "inst-cap", config, undefined, timers);

		// Error 1: min(100 * 3^0, 500) = 100
		// Error 2: min(100 * 3^1, 500) = 300
		// Error 3: min(100 * 3^2, 500) = 500 (capped)
		// Error 4: min(100 * 3^3, 500) = 500 (capped)
		expect(timers.delays).toEqual([100, 300, 500, 500]);
	});

	it("returns max_errors_exceeded after too many consecutive errors", async () => {
		const config: ReadinessPollerConfig = { ...FAST_CONFIG, maxConsecutiveErrors: 3 };
		const client = createErrorThenSuccessClient(10, "ready");
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-maxerr", config, undefined, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("max_errors_exceeded");
			expect(result.pollCount).toBe(3);
			expect(result.lastError).toBeInstanceOf(Error);
			expect(result.lastError?.message).toContain("Transient error");
		}
	});

	it("resets consecutive errors on success", async () => {
		let callIdx = 0;
		const client: CloudInstanceClient = {
			getInstance: async (instanceId: string) => {
				callIdx += 1;
				if (callIdx <= 2) throw new Error(`Error ${callIdx}`);
				if (callIdx === 3) return { instance_id: instanceId, state: "provisioning" as const };
				if (callIdx <= 5) throw new Error(`Error ${callIdx}`);
				return { instance_id: instanceId, state: "ready" as const };
			},
		};
		const timers = createFakeTimers();
		const config: ReadinessPollerConfig = { ...FAST_CONFIG, maxConsecutiveErrors: 3 };

		const result = await pollForReadiness(client, "inst-reset", config, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.pollCount).toBe(6);
		}
	});
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe("pollForReadiness — abort signal", () => {
	it("returns aborted when signal is already aborted", async () => {
		const client = createSequenceClient([{ state: "provisioning" }]);
		const timers = createFakeTimers();
		const controller = new AbortController();
		controller.abort();

		const result = await pollForReadiness(client, "inst-abort", FAST_CONFIG, controller.signal, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("aborted");
			expect(result.pollCount).toBe(0);
		}
	});

	it("returns aborted when signal fires during polling", async () => {
		const controller = new AbortController();
		let callCount = 0;
		const client: CloudInstanceClient = {
			getInstance: async (instanceId: string) => {
				callCount += 1;
				if (callCount === 2) {
					controller.abort();
					throw new DOMException("Aborted", "AbortError");
				}
				return { instance_id: instanceId, state: "provisioning" as const };
			},
		};
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-mid-abort", FAST_CONFIG, controller.signal, timers);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toBe("aborted");
		}
	});
});

// ---------------------------------------------------------------------------
// Elapsed time and poll count tracking
// ---------------------------------------------------------------------------

describe("pollForReadiness — metrics", () => {
	it("tracks elapsed time correctly", async () => {
		const client = createSequenceClient([{ state: "provisioning" }, { state: "provisioning" }, { state: "ready" }]);
		const timers = createFakeTimers();
		const config: ReadinessPollerConfig = { ...FAST_CONFIG, pollIntervalMs: 500 };

		const result = await pollForReadiness(client, "inst-time", config, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.elapsedMs).toBe(1000); // 2 delays of 500ms
			expect(result.pollCount).toBe(3);
		}
	});

	it("returns hostname from the ready response", async () => {
		const client = createSequenceClient([{ state: "ready", hostname: "my-runner.cloud.internal" }]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-host", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.hostname).toBe("my-runner.cloud.internal");
		}
	});

	it("returns undefined hostname when not provided", async () => {
		const client = createSequenceClient([{ state: "ready" }]);
		const timers = createFakeTimers();

		const result = await pollForReadiness(client, "inst-nohost", FAST_CONFIG, undefined, timers);

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.hostname).toBeUndefined();
		}
	});
});
