import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural verification that main.ts implements the thin shell model.
 * These tests read the source code and verify the expected patterns
 * exist — they don't execute Electron APIs.
 *
 * Shell model:
 *   1. Attach to existing runtime on configured endpoint
 *   2. Start runtime if endpoint is down
 *   3. Show disconnected screen on runtime death; user-initiated restart
 *   4. Multi-window loads same runtime URL
 */

const mainSrc = readFileSync(
	new URL("../src/main.ts", import.meta.url),
	"utf-8",
);

// ---------------------------------------------------------------------------
// 1. Attach to existing runtime
// ---------------------------------------------------------------------------

describe("attach to existing runtime", () => {
	it("health-checks the default endpoint before starting a child", () => {
		expect(mainSrc).toContain("checkHealth(defaultOrigin)");
	});

	it("sets runtimeUrl to the existing runtime when healthy", () => {
		expect(mainSrc).toContain("runtimeUrl = defaultOrigin");
		expect(mainSrc).toContain("ownsChild = false");
	});

	it("loads the external runtime URL into all windows", () => {
		expect(mainSrc).toContain("windowRegistry.loadUrlInAllWindows(runtimeUrl)");
	});
});

// ---------------------------------------------------------------------------
// 2. Start runtime if missing
// ---------------------------------------------------------------------------

describe("start runtime if missing", () => {
	it("calls startOwnRuntime when no existing runtime is found", () => {
		expect(mainSrc).toContain("await startOwnRuntime()");
	});

	it("creates a RuntimeChildManager as a thin launcher (no heartbeat/restart config)", () => {
		expect(mainSrc).toContain("new RuntimeChildManager(");
		// The thin shell model does NOT configure heartbeat or auto-restart
		expect(mainSrc).not.toContain("maxRestarts:");
		expect(mainSrc).not.toContain("heartbeatTimeoutMs:");
		expect(mainSrc).not.toContain("heartbeatIntervalMs:");
	});

	it("sets ownsChild = true after starting", () => {
		expect(mainSrc).toContain("ownsChild = true");
	});

	it("does not manage auth cookies locally (runtime handles its own auth)", () => {
		expect(mainSrc).not.toContain("setAuthCookie(");
		expect(mainSrc).not.toContain("clearAuthCookie(");
		expect(mainSrc).not.toContain('name: "kanban-auth"');
	});
});

// ---------------------------------------------------------------------------
// 3. Disconnected screen + user-initiated restart
// ---------------------------------------------------------------------------

describe("disconnected screen and user-initiated restart", () => {
	it("shows disconnected screen when runtime crashes", () => {
		expect(mainSrc).toContain("showDisconnectedScreen()");
	});

	it("shows disconnected screen when runtime health check fails on did-fail-load", () => {
		expect(mainSrc).toContain("did-fail-load");
		expect(mainSrc).toContain("checkHealth(origin)");
	});

	it("has a disconnected HTML page with a restart button", () => {
		const disconnectedHtml = readFileSync(
			new URL("../src/disconnected.html", import.meta.url),
			"utf-8",
		);
		expect(disconnectedHtml).toContain("Runtime Disconnected");
		expect(disconnectedHtml).toContain("restartRuntime");
		expect(disconnectedHtml).toContain("<code>kanban</code>");
	});

	it("handles restart-runtime IPC from the disconnected screen", () => {
		expect(mainSrc).toContain('"restart-runtime"');
		expect(mainSrc).toContain("void restartRuntime()");
	});

	it("deduplicates concurrent restart calls via restartPromise", () => {
		expect(mainSrc).toContain("restartPromise");
	});

	it("does not have hidden auto-restart (no powerMonitor health-check)", () => {
		expect(mainSrc).not.toContain("powerMonitor");
		expect(mainSrc).not.toContain("setupPowerMonitorHealthCheck");
	});
});

// ---------------------------------------------------------------------------
// 4. Multi-window loads same URL
// ---------------------------------------------------------------------------

describe("multi-window same URL", () => {
	it("creates windows via windowRegistry.createWindow", () => {
		expect(mainSrc).toContain("windowRegistry.createWindow(");
	});

	it("loads the same runtimeUrl in new windows", () => {
		expect(mainSrc).toContain("window.loadURL(url)");
	});

	it("has a New Window menu accelerator", () => {
		expect(mainSrc).toContain('"New Window"');
		expect(mainSrc).toContain("CmdOrCtrl+Shift+N");
	});

	it("supports --project flag to open project-specific windows", () => {
		expect(mainSrc).toContain('parseProjectFromArgv');
		expect(mainSrc).toContain("open-project-window");
	});

	it("handles second-instance by focusing existing or opening new window", () => {
		expect(mainSrc).toContain('"second-instance"');
		expect(mainSrc).toContain("requestSingleInstanceLock");
	});
});

// ---------------------------------------------------------------------------
// No leftover multi-runtime or stale concepts
// ---------------------------------------------------------------------------

describe("no leftover multi-runtime concepts", () => {
	it("does not import ConnectionManager", () => {
		expect(mainSrc).not.toMatch(/import\s.*ConnectionManager/);
		expect(mainSrc).not.toMatch(/from\s+["'].*connection-manager/);
	});

	it("does not import ConnectionStore", () => {
		expect(mainSrc).not.toMatch(/import\s.*ConnectionStore/);
		expect(mainSrc).not.toMatch(/from\s+["'].*connection-store/);
	});

	it("does not reference runtime descriptors", () => {
		expect(mainSrc).not.toContain("readRuntimeDescriptor");
		expect(mainSrc).not.toContain("writeRuntimeDescriptor");
		expect(mainSrc).not.toContain("clearRuntimeDescriptor");
		expect(mainSrc).not.toContain("evaluateDescriptorTrust");
	});

	it("does not reference takeover or failover", () => {
		expect(mainSrc).not.toContain("handleRuntimeDisconnect");
		expect(mainSrc).not.toContain("descriptorWatcher");
	});

	it("does not have desktop boot state machine", () => {
		expect(mainSrc).not.toContain("advanceBootPhase");
		expect(mainSrc).not.toContain("recordBootFailure");
		expect(mainSrc).not.toContain("getBootState");
	});

	it("does not import session (no local cookie management)", () => {
		// "session" should not appear as an Electron import
		expect(mainSrc).not.toMatch(/\bsession\b.*from\s+["']electron["']/);
		expect(mainSrc).not.toMatch(/import\s*\{[^}]*\bsession\b[^}]*\}\s*from\s*["']electron["']/);
	});
});
