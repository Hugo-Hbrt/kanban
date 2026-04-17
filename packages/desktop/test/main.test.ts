import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type WindowState,
	loadWindowState,
	resolveWindowStatePath,
	saveWindowState,
} from "../src/window-state.js";

// ---------------------------------------------------------------------------
// resolveWindowStatePath
// ---------------------------------------------------------------------------

describe("resolveWindowStatePath", () => {
	it("joins userData path with window-state.json", () => {
		const result = resolveWindowStatePath("/home/user/.config/Kanban");
		expect(result).toBe(
			path.join("/home/user/.config/Kanban", "window-state.json"),
		);
	});

	it("works with trailing separator", () => {
		const result = resolveWindowStatePath(
			`/home/user/.config/Kanban${path.sep}`,
		);
		expect(result).toBe(
			path.join("/home/user/.config/Kanban", "window-state.json"),
		);
	});
});

// ---------------------------------------------------------------------------
// loadWindowState / saveWindowState
// ---------------------------------------------------------------------------

describe("Window state persistence", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "kanban-main-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------
	// loadWindowState
	// -------------------------------------------------------------------

	describe("loadWindowState", () => {
		it("returns undefined when file does not exist", () => {
			const result = loadWindowState(tempDir);
			expect(result).toBeUndefined();
		});

		it("returns undefined when file contains invalid JSON", () => {
			const filePath = resolveWindowStatePath(tempDir);
			writeFileSync(filePath, "not json", "utf-8");
			expect(loadWindowState(tempDir)).toBeUndefined();
		});

		it("returns undefined when width is missing", () => {
			const filePath = resolveWindowStatePath(tempDir);
			writeFileSync(
				filePath,
				JSON.stringify({ height: 900, isMaximized: false }),
				"utf-8",
			);
			expect(loadWindowState(tempDir)).toBeUndefined();
		});

		it("returns undefined when height is missing", () => {
			const filePath = resolveWindowStatePath(tempDir);
			writeFileSync(
				filePath,
				JSON.stringify({ width: 1400, isMaximized: false }),
				"utf-8",
			);
			expect(loadWindowState(tempDir)).toBeUndefined();
		});

		it("returns undefined when isMaximized is missing", () => {
			const filePath = resolveWindowStatePath(tempDir);
			writeFileSync(
				filePath,
				JSON.stringify({ width: 1400, height: 900 }),
				"utf-8",
			);
			expect(loadWindowState(tempDir)).toBeUndefined();
		});

		it("returns undefined when width is not a number", () => {
			const filePath = resolveWindowStatePath(tempDir);
			writeFileSync(
				filePath,
				JSON.stringify({ width: "big", height: 900, isMaximized: false }),
				"utf-8",
			);
			expect(loadWindowState(tempDir)).toBeUndefined();
		});

		it("loads a valid state with x and y", () => {
			const filePath = resolveWindowStatePath(tempDir);
			const state: WindowState = {
				x: 100,
				y: 200,
				width: 1400,
				height: 900,
				isMaximized: false,
			};
			writeFileSync(filePath, JSON.stringify(state), "utf-8");
			expect(loadWindowState(tempDir)).toEqual(state);
		});

		it("loads a valid state without x and y", () => {
			const filePath = resolveWindowStatePath(tempDir);
			const stored = { width: 1200, height: 800, isMaximized: true };
			writeFileSync(filePath, JSON.stringify(stored), "utf-8");

			expect(loadWindowState(tempDir)).toEqual({
				x: undefined,
				y: undefined,
				width: 1200,
				height: 800,
				isMaximized: true,
			});
		});

		it("treats non-number x/y as undefined", () => {
			const filePath = resolveWindowStatePath(tempDir);
			const stored = {
				x: "left",
				y: null,
				width: 1000,
				height: 700,
				isMaximized: false,
			};
			writeFileSync(filePath, JSON.stringify(stored), "utf-8");

			expect(loadWindowState(tempDir)).toEqual({
				x: undefined,
				y: undefined,
				width: 1000,
				height: 700,
				isMaximized: false,
			});
		});
	});

	// -------------------------------------------------------------------
	// saveWindowState
	// -------------------------------------------------------------------

	describe("saveWindowState", () => {
		it("creates the file with the given state", () => {
			const state: WindowState = {
				x: 50,
				y: 75,
				width: 1400,
				height: 900,
				isMaximized: false,
			};

			saveWindowState(tempDir, state);

			const filePath = resolveWindowStatePath(tempDir);
			expect(existsSync(filePath)).toBe(true);

			const raw = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw);
			expect(parsed).toEqual(state);
		});

		it("overwrites an existing file", () => {
			const state1: WindowState = {
				x: 0,
				y: 0,
				width: 800,
				height: 600,
				isMaximized: false,
			};
			const state2: WindowState = {
				x: 100,
				y: 200,
				width: 1920,
				height: 1080,
				isMaximized: true,
			};

			saveWindowState(tempDir, state1);
			saveWindowState(tempDir, state2);

			expect(loadWindowState(tempDir)).toEqual(state2);
		});

		it("does not throw when directory does not exist", () => {
			const state: WindowState = {
				x: 0,
				y: 0,
				width: 1000,
				height: 700,
				isMaximized: false,
			};

			expect(() =>
				saveWindowState("/nonexistent/deeply/nested/path", state),
			).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// round-trip
	// -------------------------------------------------------------------

	describe("round-trip", () => {
		it("save then load returns the same state", () => {
			const state: WindowState = {
				x: 42,
				y: 84,
				width: 1600,
				height: 1000,
				isMaximized: false,
			};

			saveWindowState(tempDir, state);
			expect(loadWindowState(tempDir)).toEqual(state);
		});

		it("round-trips maximized state with undefined x/y", () => {
			const state: WindowState = {
				x: undefined,
				y: undefined,
				width: 1920,
				height: 1080,
				isMaximized: true,
			};

			saveWindowState(tempDir, state);
			expect(loadWindowState(tempDir)).toEqual({
				x: undefined,
				y: undefined,
				width: 1920,
				height: 1080,
				isMaximized: true,
			});
		});
	});
});

// ---------------------------------------------------------------------------
// before-quit shutdown safety (structural source-code check)
// ---------------------------------------------------------------------------
//
// The invariant under test is: the app can never hang on quit. The shutdown
// path now has two layers:
//
//   1. main.ts's `before-quit` handler calls `orchestrator.shutdown()` and
//      then `app.quit()`. It does NOT need try/finally because
//      orchestrator.shutdown() is contractually non-throwing.
//
//   2. orchestrator.shutdown() wraps `manager.shutdown()` in `.catch(...)`
//      that logs with the `[desktop] Runtime shutdown error:` prefix and
//      swallows the error.
//
// If either layer changes shape, these tests will catch it.

describe("before-quit shutdown safety", () => {
	const mainSrc = readFileSync(
		new URL("../src/main.ts", import.meta.url),
		"utf-8",
	);
	const orchestratorSrc = readFileSync(
		new URL("../src/runtime-orchestrator.ts", import.meta.url),
		"utf-8",
	);

	/** Extracts a handler body by scanning for a marker line + brace balancing. */
	function extractBlock(src: string, marker: string, label: string): string {
		const lines = src.split("\n");
		const startIdx = lines.findIndex((l) => l.includes(marker));
		if (startIdx === -1) throw new Error(`${label} not found`);

		let depth = 0;
		let started = false;
		const collected: string[] = [];
		for (let i = startIdx; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === "{") {
					depth++;
					started = true;
				}
				if (ch === "}") depth--;
			}
			collected.push(lines[i]);
			if (started && depth === 0) break;
		}
		return collected.join("\n");
	}

	it("main.ts calls orchestrator.shutdown() then app.quit() after event.preventDefault()", () => {
		const handler = extractBlock(
			mainSrc,
			'app.on("before-quit"',
			"before-quit handler",
		);

		expect(handler).toContain("event.preventDefault()");
		expect(handler).toContain("orchestrator.shutdown()");
		expect(handler).toContain("app.quit()");

		// Order within the preventDefault branch: preventDefault → shutdown → quit.
		const preventIdx = handler.indexOf("event.preventDefault()");
		const shutdownIdx = handler.indexOf("orchestrator.shutdown()", preventIdx);
		const quitIdx = handler.indexOf("app.quit()", shutdownIdx);

		expect(shutdownIdx).toBeGreaterThan(preventIdx);
		expect(quitIdx).toBeGreaterThan(shutdownIdx);
	});

	it("orchestrator.shutdown() catches and logs manager.shutdown errors", () => {
		const shutdownBody = extractBlock(
			orchestratorSrc,
			"async shutdown(): Promise<void>",
			"RuntimeOrchestrator.shutdown",
		);

		// manager.shutdown() must be wrapped so it never rejects — either
		// via try/catch or .catch(...). The log prefix lets grep-level
		// triage pin down startup hangs immediately.
		expect(shutdownBody).toContain("manager.shutdown()");
		expect(shutdownBody).toMatch(/\.catch\(|try\s*\{/);
		expect(shutdownBody).toContain("[desktop] Runtime shutdown error:");
	});

	it("orchestrator.shutdown() always stops the power-save blocker", () => {
		const shutdownBody = extractBlock(
			orchestratorSrc,
			"async shutdown(): Promise<void>",
			"RuntimeOrchestrator.shutdown",
		);

		// Called before manager.shutdown() so it runs even if there is no
		// owned child — and always before any awaited work that could hang.
		expect(shutdownBody).toContain("stopAppNapPrevention()");
		const stopIdx = shutdownBody.indexOf("stopAppNapPrevention()");
		const mgrIdx = shutdownBody.indexOf("manager.shutdown()");
		expect(stopIdx).toBeGreaterThan(-1);
		if (mgrIdx !== -1) expect(stopIdx).toBeLessThan(mgrIdx);
	});
});
