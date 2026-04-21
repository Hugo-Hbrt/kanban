import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
	class MockBrowserWindow {
		static instances: MockBrowserWindow[] = [];
		static nextId = 1;

		static getFocusedWindow(): MockBrowserWindow | null {
			return null;
		}

		static resetMock(): void {
			MockBrowserWindow.instances = [];
			MockBrowserWindow.nextId = 1;
		}

		id: number;
		private readonly _listeners = new Map<string, Array<(...args: unknown[]) => void>>();
		private _destroyed = false;
		private _visible = true;

		webContents = {
			on: vi.fn(),
			setWindowOpenHandler: vi.fn(),
		};

		constructor() {
			this.id = MockBrowserWindow.nextId++;
			MockBrowserWindow.instances.push(this);
		}

		on(event: string, handler: (...args: unknown[]) => void): void {
			const handlers = this._listeners.get(event) ?? [];
			handlers.push(handler);
			this._listeners.set(event, handlers);
		}

		once(event: string, handler: (...args: unknown[]) => void): void {
			this.on(event, handler);
		}

		simulateClose(): boolean {
			const event = {
				defaultPrevented: false,
				preventDefault() {
					this.defaultPrevented = true;
				},
			};
			for (const handler of this._listeners.get("close") ?? []) {
				handler(event);
			}
			if (!event.defaultPrevented) {
				this._destroyed = true;
				this._visible = false;
				for (const handler of this._listeners.get("closed") ?? []) {
					handler();
				}
			}
			return event.defaultPrevented;
		}

		hide(): void {
			this._visible = false;
		}

		show(): void {
			this._visible = true;
		}

		isVisible(): boolean {
			return this._visible;
		}

		isDestroyed(): boolean {
			return this._destroyed;
		}

		maximize(): void {}
		isMaximized(): boolean {
			return false;
		}
		getTitle(): string {
			return "Kanban";
		}
		getBounds(): { x: number; y: number; width: number; height: number } {
			return { x: 0, y: 0, width: 1400, height: 900 };
		}
		getNormalBounds(): { x: number; y: number; width: number; height: number } {
			return this.getBounds();
		}
		isMinimized(): boolean {
			return false;
		}
		restore(): void {}
		focus(): void {}
		setTitle(): void {}
	}

	return {
		BrowserWindow: MockBrowserWindow,
		shell: { openExternal: vi.fn() },
	};
});

import { BrowserWindow } from "electron";
import { WindowRegistry } from "../src/window-registry.js";

interface MockWindow {
	simulateClose(): boolean;
	hide(): void;
	show(): void;
	isVisible(): boolean;
	isDestroyed(): boolean;
}

const DEFAULT_OPTIONS = {
	preloadPath: "/tmp/preload.js",
	isPackaged: false,
};

beforeEach(() => {
	const Mock = BrowserWindow as unknown as { resetMock(): void };
	Mock.resetMock();
});

function withDarwin<T>(fn: () => T): T {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", { value: original, configurable: true });
	}
}

describe("WindowRegistry.buildWindowUrl", () => {
	it("returns base URL unchanged when projectId is null", () => {
		expect(WindowRegistry.buildWindowUrl("http://localhost:52341", null)).toBe(
			"http://localhost:52341",
		);
	});

	it("encodes projectId as the URL pathname", () => {
		const url = WindowRegistry.buildWindowUrl("http://localhost:52341", "project-abc");
		expect(url).toBe("http://localhost:52341/project-abc");
	});

	it("overwrites any existing path in the base URL", () => {
		// The path is the project; any pre-existing path on the base URL
		// is irrelevant and gets replaced.
		const url = WindowRegistry.buildWindowUrl("http://localhost:52341/some/path", "proj-1");
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/proj-1");
	});

	it("preserves existing query parameters", () => {
		const url = WindowRegistry.buildWindowUrl("http://localhost:52341/?token=abc", "proj-2");
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/proj-2");
		expect(parsed.searchParams.get("token")).toBe("abc");
	});

	it("URL-encodes projectIds containing slashes or whitespace", () => {
		// Matches the web-ui's buildProjectPathname encoding so that
		// parseProjectIdFromPathname round-trips the value back via
		// decodeURIComponent on the first path segment.
		const url = WindowRegistry.buildWindowUrl("http://localhost:52341", "/Users/john/my project");
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/%2FUsers%2Fjohn%2Fmy%20project");
		expect(decodeURIComponent(parsed.pathname.slice(1))).toBe("/Users/john/my project");
	});

	it("returns base URL unchanged when projectId is empty string", () => {
		expect(WindowRegistry.buildWindowUrl("http://localhost:52341", "")).toBe(
			"http://localhost:52341",
		);
	});
});

describe("WindowRegistry.loadPersistedWindows", () => {
	it("returns empty array for non-existent directory", () => {
		const states = WindowRegistry.loadPersistedWindows("/tmp/non-existent-dir-" + Date.now());
		expect(states).toEqual([]);
	});
});

describe("WindowRegistry macOS close behavior", () => {
	const macOptions = { ...DEFAULT_OPTIONS, hideOnCloseForMac: true, isQuitting: () => false };

	it("hides the last visible window on macOS close", () => {
		withDarwin(() => {
			const registry = new WindowRegistry();
			const window = registry.createWindow({ ...macOptions, projectId: null });
			const prevented = (window as unknown as MockWindow).simulateClose();
			expect(prevented).toBe(true);
			expect(registry.size).toBe(1);
		});
	});

	it("destroys a non-last window on macOS close", () => {
		withDarwin(() => {
			const registry = new WindowRegistry();
			registry.createWindow({ ...macOptions, projectId: null });
			const win2 = registry.createWindow({ ...macOptions, projectId: "project-abc" });
			expect(registry.size).toBe(2);
			const prevented = (win2 as unknown as MockWindow).simulateClose();
			expect(prevented).toBe(false);
			expect(registry.size).toBe(1);
			expect((win2 as unknown as MockWindow).isDestroyed()).toBe(true);
		});
	});

	it("hides the last window even if it is a project window", () => {
		withDarwin(() => {
			const registry = new WindowRegistry();
			const window = registry.createWindow({ ...macOptions, projectId: "project-abc" });
			const prevented = (window as unknown as MockWindow).simulateClose();
			expect(prevented).toBe(true);
			expect(registry.size).toBe(1);
		});
	});

	it("always closes when quitting", () => {
		withDarwin(() => {
			const registry = new WindowRegistry();
			const window = registry.createWindow({
				...macOptions,
				projectId: null,
				isQuitting: () => true,
			});
			const prevented = (window as unknown as MockWindow).simulateClose();
			expect(prevented).toBe(false);
			expect(registry.size).toBe(0);
		});
	});
});

describe("WindowRegistry visibility helpers", () => {
	it("getVisible() excludes hidden windows", () => {
		const registry = new WindowRegistry();
		const win1 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: null });
		registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-a" });
		(win1 as unknown as MockWindow).hide();
		const visible = registry.getVisible();
		expect(visible.length).toBe(1);
		expect(visible[0].projectId).toBe("project-a");
	});

	it("countVisibleWindows() returns correct count", () => {
		const registry = new WindowRegistry();
		const win1 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: null });
		registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-a" });
		registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-b" });
		expect(registry.countVisibleWindows()).toBe(3);
		(win1 as unknown as MockWindow).hide();
		expect(registry.countVisibleWindows()).toBe(2);
	});
});

describe("WindowRegistry multi-window creation", () => {
	it("allows duplicate project windows (same projectId)", () => {
		const registry = new WindowRegistry();
		const win1 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-a" });
		const win2 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-a" });
		expect(win1.id).not.toBe(win2.id);
		expect(registry.size).toBe(2);
	});

	it("allows multiple overview windows (projectId null)", () => {
		const registry = new WindowRegistry();
		const win1 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: null });
		const win2 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: null });
		expect(win1.id).not.toBe(win2.id);
		expect(registry.size).toBe(2);
	});

	it("allows different project windows", () => {
		const registry = new WindowRegistry();
		const win1 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-a" });
		const win2 = registry.createWindow({ ...DEFAULT_OPTIONS, projectId: "project-b" });
		expect(win1.id).not.toBe(win2.id);
		expect(registry.size).toBe(2);
	});
});
