/**
 * Integration tests for the ConnectionStore / ConnectionManager wiring
 * in the desktop app startup path.
 *
 * These tests exercise the ConnectionManager in isolation using mock
 * implementations of BrowserWindow, RuntimeChildManager, and Electron APIs.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mock Electron modules
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
	BrowserWindow: vi.fn(),
	Menu: {
		buildFromTemplate: vi.fn(),
		setApplicationMenu: vi.fn(),
		getApplicationMenu: vi.fn(() => null),
	},
	dialog: {
		showMessageBox: vi.fn(async () => ({ response: 0 })),
		showErrorBox: vi.fn(),
	},
	app: { name: "Kanban", isPackaged: false },
	ipcMain: { on: vi.fn(), removeListener: vi.fn() },
	safeStorage: {
		isEncryptionAvailable: vi.fn(() => false),
		encryptString: vi.fn((s: string) => Buffer.from(s)),
		decryptString: vi.fn((b: Buffer) => b.toString()),
	},
	powerMonitor: { on: vi.fn() },
	powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
	shell: { openExternal: vi.fn() },
}));

import { ConnectionStore } from "../src/connection-store.js";
import { ConnectionManager } from "../src/connection-manager.js";
import type { RuntimeChildManager } from "../src/runtime-child.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWindow() {
	return {
		loadURL: vi.fn(async () => {}),
		webContents: {
			session: {
				webRequest: { onBeforeSendHeaders: vi.fn() },
				cookies: {
					set: vi.fn().mockResolvedValue(undefined),
					remove: vi.fn().mockResolvedValue(undefined),
				},
			},
		},
	};
}

function createMockChildManager(opts?: {
	startUrl?: string;
	startShouldFail?: boolean;
}): RuntimeChildManager {
	const url = opts?.startUrl ?? "http://127.0.0.1:54321";
	const fail = opts?.startShouldFail ?? false;
	return {
		start: vi.fn(async () => { if (fail) throw new Error("fail"); return url; }),
		shutdown: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		running: false,
		send: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		removeAllListeners: vi.fn(),
	} as unknown as RuntimeChildManager;
}

type BW = import("electron").BrowserWindow;

/** Mock http.get to simulate a healthy remote server. */
function mockHttpHealthy() {
	const { PassThrough } = require("node:stream");
	const mockGet = vi.fn((_url: unknown, _opts: unknown, cb: (res: any) => void) => {
		const res = new PassThrough();
		res.statusCode = 200;
		cb(res);
		res.end();
		return { on: vi.fn(), destroy: vi.fn() };
	});
	vi.spyOn(require("node:http"), "get").mockImplementation(mockGet);
	vi.spyOn(require("node:https"), "get").mockImplementation(mockGet);
}

/** Mock http.get to simulate an unreachable remote server. */
function mockHttpUnhealthy() {
	const mockGet = vi.fn((_url: unknown, _opts: unknown, _cb: unknown) => {
		const req = { on: vi.fn(), destroy: vi.fn() };
		setTimeout(() => {
			const errorHandler = req.on.mock.calls.find((c: any[]) => c[0] === "error")?.[1];
			if (errorHandler) errorHandler(new Error("ECONNREFUSED"));
		}, 0);
		return req;
	});
	vi.spyOn(require("node:http"), "get").mockImplementation(mockGet);
	vi.spyOn(require("node:https"), "get").mockImplementation(mockGet);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectionManager integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-cm-test-"));
		vi.clearAllMocks();
		// Default: health checks succeed (mock node:http/https).
		mockHttpHealthy();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("starts local runtime when no saved remote exists (default path)", async () => {
		const store = new ConnectionStore(tmpDir);
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store });
		await mgr.initialize();
		expect(child.start).toHaveBeenCalledOnce();
		expect(win.loadURL).toHaveBeenCalledWith("http://127.0.0.1:54321");
		expect(store.getActiveConnectionId()).toBe("local");
	});

	it("always starts local child even when active connection is remote", async () => {
		const store = new ConnectionStore(tmpDir);
		const conn = store.addConnection({ label: "Remote", serverUrl: "https://r.example.com", authToken: "t" });
		store.setActiveConnection(conn.id);
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store });
		await mgr.initialize();
		// Local child always starts for fallback.
		expect(child.start).toHaveBeenCalledOnce();
		// Renderer loads the remote URL.
		expect(win.loadURL).toHaveBeenCalledWith("https://r.example.com");
	});

	it("switches to a saved remote and loads its URL", async () => {
		const store = new ConnectionStore(tmpDir);
		const conn = store.addConnection({ label: "Remote", serverUrl: "https://cline.bot" });
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store });
		await mgr.initialize();
		await mgr.switchTo(conn.id);
		expect(win.loadURL).toHaveBeenCalledWith("https://cline.bot");
		expect(store.getActiveConnectionId()).toBe(conn.id);
	});

	it("shutdown delegates through the connection manager", async () => {
		const store = new ConnectionStore(tmpDir);
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store });
		await mgr.initialize();
		expect(mgr.isChildRunning()).toBe(true);
		await mgr.shutdown();
		expect(child.shutdown).toHaveBeenCalledOnce();
		expect(mgr.isChildRunning()).toBe(false);
	});

	it("honors a non-local active connection persisted in the store", async () => {
		const s1 = new ConnectionStore(tmpDir);
		const conn = s1.addConnection({ label: "Prod", serverUrl: "https://prod.io" });
		s1.setActiveConnection(conn.id);
		const s2 = new ConnectionStore(tmpDir);
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store: s2 });
		await mgr.initialize();
		// Local child always starts.
		expect(child.start).toHaveBeenCalledOnce();
		// Renderer loads the remote URL.
		expect(win.loadURL).toHaveBeenCalledWith("https://prod.io");
	});

	it("falls back safely when stale active ID is in the persisted store", async () => {
		const fp = path.join(tmpDir, "connections.json");
		fs.writeFileSync(fp, JSON.stringify({
			connections: [{ id: "local", label: "Local", serverUrl: "" }],
			activeConnectionId: "deleted-remote",
		}));
		const store = new ConnectionStore(tmpDir);
		expect(store.getActiveConnection().id).toBe("local");
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store });
		await mgr.initialize();
		expect(child.start).toHaveBeenCalledOnce();
		expect(win.loadURL).toHaveBeenCalledWith("http://127.0.0.1:54321");
	});

	it("falls back to local when remote health check fails during initialize", async () => {
		mockHttpUnhealthy();
		const store = new ConnectionStore(tmpDir);
		const conn = store.addConnection({ label: "Broken", serverUrl: "https://broken.io" });
		store.setActiveConnection(conn.id);
		const win = createMockWindow();
		const child = createMockChildManager();
		const onChange = vi.fn();
		const mgr = new ConnectionManager({
			window: win as unknown as BW, childManager: child, store, onConnectionChanged: onChange,
		});
		await mgr.initialize();
		expect(store.getActiveConnectionId()).toBe("local");
		expect(child.start).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalled();
	});

	it("updates persisted active connection state on switch", async () => {
		const store = new ConnectionStore(tmpDir);
		const conn = store.addConnection({ label: "R", serverUrl: "https://r.io" });
		const win = createMockWindow();
		const child = createMockChildManager();
		const mgr = new ConnectionManager({ window: win as unknown as BW, childManager: child, store });
		await mgr.initialize();
		expect(store.getActiveConnectionId()).toBe("local");
		await mgr.switchTo(conn.id);
		expect(store.getActiveConnectionId()).toBe(conn.id);
		const s2 = new ConnectionStore(tmpDir);
		expect(s2.getActiveConnectionId()).toBe(conn.id);
	});

	it("re-initializes after shutdown (resume/restart)", async () => {
		const store = new ConnectionStore(tmpDir);
		const win = createMockWindow();
		const child = createMockChildManager();
		const onReady = vi.fn();
		const mgr = new ConnectionManager({
			window: win as unknown as BW, childManager: child, store, onLocalRuntimeReady: onReady,
		});
		await mgr.initialize();
		expect(child.start).toHaveBeenCalledOnce();
		expect(onReady).toHaveBeenCalledOnce();
		await mgr.shutdown();
		await mgr.initialize();
		expect(child.start).toHaveBeenCalledTimes(2);
		expect(onReady).toHaveBeenCalledTimes(2);
	});

	it("fires onLocalRuntimeReady on local startup", async () => {
		const store = new ConnectionStore(tmpDir);
		const win = createMockWindow();
		const child = createMockChildManager({ startUrl: "http://127.0.0.1:9999" });
		const onReady = vi.fn();
		const mgr = new ConnectionManager({
			window: win as unknown as BW, childManager: child, store, onLocalRuntimeReady: onReady,
		});
		await mgr.initialize();
		expect(onReady).toHaveBeenCalledWith("http://127.0.0.1:9999", expect.any(String));
	});

	it("does NOT fire onLocalRuntimeStopped when switching to remote (child stays alive)", async () => {
		const store = new ConnectionStore(tmpDir);
		const conn = store.addConnection({ label: "R", serverUrl: "https://r.io" });
		const win = createMockWindow();
		const child = createMockChildManager();
		const onStopped = vi.fn();
		const mgr = new ConnectionManager({
			window: win as unknown as BW, childManager: child, store, onLocalRuntimeStopped: onStopped,
		});
		await mgr.initialize();
		expect(onStopped).not.toHaveBeenCalled();
		await mgr.switchTo(conn.id);
		// Local child stays alive — onLocalRuntimeStopped should NOT fire.
		expect(onStopped).not.toHaveBeenCalled();
	});

	it("fires onLocalRuntimeStopped on shutdown", async () => {
		const store = new ConnectionStore(tmpDir);
		const win = createMockWindow();
		const child = createMockChildManager();
		const onStopped = vi.fn();
		const mgr = new ConnectionManager({
			window: win as unknown as BW, childManager: child, store, onLocalRuntimeStopped: onStopped,
		});
		await mgr.initialize();
		await mgr.shutdown();
		expect(onStopped).toHaveBeenCalledOnce();
	});

	it("invokes onConnectionChanged on switch", async () => {
		const store = new ConnectionStore(tmpDir);
		const conn = store.addConnection({ label: "R", serverUrl: "https://r.io" });
		const win = createMockWindow();
		const child = createMockChildManager();
		const onChange = vi.fn();
		const mgr = new ConnectionManager({
			window: win as unknown as BW, childManager: child, store, onConnectionChanged: onChange,
		});
		await mgr.initialize();
		expect(onChange).not.toHaveBeenCalled();
		await mgr.switchTo(conn.id);
		expect(onChange).toHaveBeenCalledOnce();
		await mgr.switchTo("local");
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});
