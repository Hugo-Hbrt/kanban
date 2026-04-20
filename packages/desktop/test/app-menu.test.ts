import { describe, expect, it } from "vitest";

import { resolveInheritedPath } from "../src/app-menu.js";

// ---------------------------------------------------------------------------
// resolveInheritedPath — decides whether a new window (File → New Window)
// should inherit the focused window's pathname.
//
// The key defensive case: when the focused window shows the local
// `disconnected.html` fallback, its URL is a `file://` URL whose pathname
// looks like `/Users/.../disconnected.html`. Replaying that pathname
// against the runtime origin would strand the new window on a 404.
// ---------------------------------------------------------------------------

describe("resolveInheritedPath", () => {
	// ── Happy path ────────────────────────────────────────────────────

	it("returns the pathname for a normal http runtime URL", () => {
		expect(resolveInheritedPath("http://127.0.0.1:3484/my-project")).toBe(
			"/my-project",
		);
	});

	it("returns the pathname for a normal https runtime URL", () => {
		expect(resolveInheritedPath("https://example.com/project/task-42")).toBe(
			"/project/task-42",
		);
	});

	it("preserves multi-segment pathnames", () => {
		expect(
			resolveInheritedPath("http://localhost:3484/team/alpha/task/123"),
		).toBe("/team/alpha/task/123");
	});

	// ── Guards against the disconnected.html footgun ──────────────────

	it("returns null for a file:// URL pointing at a disconnected.html fallback", () => {
		const url =
			"file:///Users/dev/Library/Application%20Support/Kanban/disconnected.html";
		expect(resolveInheritedPath(url)).toBeNull();
	});

	it("returns null for a file:// URL pointing at a /home/ path (Linux)", () => {
		const url = "file:///home/dev/.config/Kanban/disconnected.html";
		expect(resolveInheritedPath(url)).toBeNull();
	});

	it("returns null for any file:// URL regardless of path", () => {
		expect(resolveInheritedPath("file:///tmp/something")).toBeNull();
	});

	// ── Other defensive cases ─────────────────────────────────────────

	it("returns null for the root pathname (no useful route to inherit)", () => {
		expect(resolveInheritedPath("http://127.0.0.1:3484/")).toBeNull();
	});

	it("returns null for about:blank", () => {
		expect(resolveInheritedPath("about:blank")).toBeNull();
	});

	it("returns null for a pathname ending in .html", () => {
		expect(
			resolveInheritedPath("http://127.0.0.1:3484/foo.html"),
		).toBeNull();
	});

	it("returns null for a Windows-style file URL (/C:/…)", () => {
		expect(
			resolveInheritedPath("http://127.0.0.1:3484/C:/Users/dev/app"),
		).toBeNull();
	});

	it("returns null for a malformed URL", () => {
		expect(resolveInheritedPath("not a url")).toBeNull();
	});

	it("returns null for undefined input", () => {
		expect(resolveInheritedPath(undefined)).toBeNull();
	});

	it("returns null for null input", () => {
		expect(resolveInheritedPath(null)).toBeNull();
	});

	it("returns null for empty string input", () => {
		expect(resolveInheritedPath("")).toBeNull();
	});

	// ── Query strings and fragments are ignored (not part of pathname) ──

	it("strips query strings (not part of the pathname)", () => {
		expect(
			resolveInheritedPath("http://127.0.0.1:3484/project?foo=bar"),
		).toBe("/project");
	});

	it("strips fragments (not part of the pathname)", () => {
		expect(resolveInheritedPath("http://127.0.0.1:3484/project#top")).toBe(
			"/project",
		);
	});
});
