import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// before-quit shutdown safety
//
// Regression tests for the macOS quit bug where a "Quit Kanban" from the
// app menu would leave an orphaned node process running because:
//   1. main.ts's before-quit handler didn't await the runtime shutdown
//      before calling app.quit().
//   2. orchestrator.shutdown() didn't catch errors from the underlying
//      manager.shutdown() and didn't always stop the power-save blocker.
//
// These are source-level structural assertions because the full quit flow
// requires a real Electron app. If either layer changes shape, these tests
// will catch it.
// ---------------------------------------------------------------------------

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
