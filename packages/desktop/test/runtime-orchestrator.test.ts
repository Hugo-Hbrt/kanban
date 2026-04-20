import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Electron's powerSaveBlocker is touched by the orchestrator. It has no
// value in these unit tests — just return a stub so the constructor and
// lifecycle calls don't throw.
vi.mock("electron", () => ({
	powerSaveBlocker: {
		start: vi.fn(() => 1),
		stop: vi.fn(),
	},
}));

// The child manager is imported but never exercised in these attached-mode
// tests. Stub it out to avoid pulling in spawn/node-pty.
vi.mock("../src/runtime-child.js", () => ({
	RuntimeChildManager: class {
		on() {
			return this;
		}
		async start() {
			return "http://127.0.0.1:3484";
		}
		async shutdown() {}
		async dispose() {}
	},
}));

const { RuntimeOrchestrator } = await import("../src/runtime-orchestrator.js");

describe("RuntimeOrchestrator attached-runtime crash detection", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits 'crashed' when attached runtime fails probes past threshold", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		});

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 3,
		});

		const crashed = vi.fn();
		orchestrator.on("crashed", crashed);

		// Initial probe succeeds (before attaching).
		await orchestrator.connect();
		expect(orchestrator.getUrl()).toBe("http://127.0.0.1:3484");
		expect(orchestrator.isOwned()).toBe(false);

		// Simulate the external runtime dying.
		healthy = false;

		// Advance time, flushing each probe's async work between ticks.
		for (let i = 0; i < 3; i += 1) {
			await vi.advanceTimersByTimeAsync(100);
		}

		expect(crashed).toHaveBeenCalledTimes(1);
		expect(orchestrator.getUrl()).toBeNull();
	});

	it("does not emit 'crashed' while attached runtime stays healthy", async () => {
		const fetchImpl = vi.fn(
			async () => ({ ok: true }) as Response,
		) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
		});

		const crashed = vi.fn();
		orchestrator.on("crashed", crashed);

		await orchestrator.connect();

		for (let i = 0; i < 5; i += 1) {
			await vi.advanceTimersByTimeAsync(100);
		}

		expect(crashed).not.toHaveBeenCalled();
		expect(orchestrator.getUrl()).toBe("http://127.0.0.1:3484");
	});

	it("resets failure count after a transient probe failure recovers", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 3,
		});

		const crashed = vi.fn();
		orchestrator.on("crashed", crashed);

		await orchestrator.connect();

		// Two failures, then recover, then two failures again — should NOT crash.
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		healthy = true;
		await vi.advanceTimersByTimeAsync(100);
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(crashed).not.toHaveBeenCalled();
	});

	it("stops probing after dispose()", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
		});

		await orchestrator.connect();
		const callsBeforeDispose = fetchImpl.mock.calls.length;

		await orchestrator.dispose();

		await vi.advanceTimersByTimeAsync(500);
		// No additional probes after dispose.
		expect(fetchImpl.mock.calls.length).toBe(callsBeforeDispose);
	});

	it("does not start probing when we own the child (post-restart)", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
		});

		await orchestrator.connect();
		// After connect() we're in attached mode; a restart flips us to owned.
		await orchestrator.restart();
		expect(orchestrator.isOwned()).toBe(true);

		const crashed = vi.fn();
		orchestrator.on("crashed", crashed);
		const callsAfterRestart = fetchImpl.mock.calls.length;

		await vi.advanceTimersByTimeAsync(500);

		// Owned mode relies on child manager "crashed" events, not our
		// probe. So no extra fetch calls.
		expect(fetchImpl.mock.calls.length).toBe(callsAfterRestart);
		expect(crashed).not.toHaveBeenCalled();
	});
});

describe("RuntimeOrchestrator post-crash recovery probe", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("auto-reattaches when a runtime returns at the last-known origin", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
			recoveryProbeIntervalMs: 200,
		});

		const crashed = vi.fn();
		const urlChanges: Array<string | null> = [];
		orchestrator.on("crashed", crashed);
		orchestrator.on("url-changed", (url) => urlChanges.push(url));

		// Connect, then simulate the external runtime dying → crash path.
		await orchestrator.connect();
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(crashed).toHaveBeenCalledTimes(1);
		expect(orchestrator.getUrl()).toBeNull();

		// While on the disconnected screen, the recovery probe is polling
		// the last-known origin. Simulate the user running `kanban` in a
		// terminal — runtime returns on the same origin.
		healthy = true;

		// Wait one recovery interval for the probe to notice.
		await vi.advanceTimersByTimeAsync(200);

		// Orchestrator should have auto-reattached without a second crash.
		expect(orchestrator.getUrl()).toBe("http://127.0.0.1:3484");
		expect(orchestrator.isOwned()).toBe(false);
		expect(crashed).toHaveBeenCalledTimes(1);
		// The shell's url-changed listener would now reload every window
		// away from disconnected.html back to the runtime.
		expect(urlChanges).toEqual([
			"http://127.0.0.1:3484",
			null,
			"http://127.0.0.1:3484",
		]);
	});

	it("keeps polling silently while the runtime stays down", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
			recoveryProbeIntervalMs: 200,
		});

		const crashed = vi.fn();
		orchestrator.on("crashed", crashed);

		await orchestrator.connect();
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(crashed).toHaveBeenCalledTimes(1);

		// Runtime never comes back. Recovery probe should keep polling
		// without re-emitting "crashed" and without accidentally flipping
		// into a connected state.
		for (let i = 0; i < 5; i += 1) {
			await vi.advanceTimersByTimeAsync(200);
		}

		expect(crashed).toHaveBeenCalledTimes(1);
		expect(orchestrator.getUrl()).toBeNull();
	});

	it("stops the recovery probe when the user clicks Restart", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
			recoveryProbeIntervalMs: 200,
		});

		await orchestrator.connect();
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(orchestrator.getUrl()).toBeNull();

		// User clicks Restart while still down. The mocked child manager
		// returns a fixed URL from start(), so restart() flips us into
		// owned mode — recovery must stop.
		await orchestrator.restart();
		expect(orchestrator.isOwned()).toBe(true);

		const callsAfterRestart = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
			.mock.calls.length;

		// Advance well past several recovery intervals; no more probes.
		await vi.advanceTimersByTimeAsync(1_000);

		expect(
			(fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(callsAfterRestart);
	});

	it("stops the recovery probe after dispose()", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
			recoveryProbeIntervalMs: 200,
		});

		await orchestrator.connect();
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		const callsBeforeDispose = (
			fetchImpl as unknown as ReturnType<typeof vi.fn>
		).mock.calls.length;

		await orchestrator.dispose();

		await vi.advanceTimersByTimeAsync(1_000);

		expect(
			(fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(callsBeforeDispose);
	});

	it("does not start recovery when recoveryProbeIntervalMs is 0", async () => {
		let healthy = true;
		const fetchImpl = vi.fn(async () => {
			return healthy
				? ({ ok: true } as Response)
				: Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const orchestrator = new RuntimeOrchestrator({
			host: "127.0.0.1",
			port: 3484,
			healthTimeoutMs: 500,
			resolveCliShimPath: () => "/unused",
			fetchImpl,
			attachedProbeIntervalMs: 100,
			attachedProbeFailureThreshold: 2,
			recoveryProbeIntervalMs: 0,
		});

		await orchestrator.connect();
		healthy = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(orchestrator.getUrl()).toBeNull();

		const callsAfterCrash = (
			fetchImpl as unknown as ReturnType<typeof vi.fn>
		).mock.calls.length;

		// Bring the runtime back — with recovery disabled, nothing watches.
		healthy = true;
		await vi.advanceTimersByTimeAsync(1_000);

		expect(
			(fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(callsAfterCrash);
		expect(orchestrator.getUrl()).toBeNull();
	});
});
