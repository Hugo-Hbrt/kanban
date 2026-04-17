/**
 * Window state persistence — stores BrowserWindow position, size, and
 * maximized state to userData so windows reopen in the same position.
 *
 * Multi-window format: `window-states.json` (array of PersistedWindowState).
 * A one-time migration converts the legacy `window-state.json` on first read.
 *
 * Intentionally free of Electron imports so pure functions can be unit-tested.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WindowState {
	x: number | undefined;
	y: number | undefined;
	width: number;
	height: number;
	isMaximized: boolean;
}

export interface PersistedWindowState extends WindowState {
	projectId: string | null;
	lastViewedPath?: string | null;
}

const LEGACY_STATE_FILE = "window-state.json";
const MULTI_STATE_FILE = "window-states.json";

export function resolveWindowStatePath(userDataPath: string): string {
	return path.join(userDataPath, LEGACY_STATE_FILE);
}

export function resolveMultiWindowStatePath(userDataPath: string): string {
	return path.join(userDataPath, MULTI_STATE_FILE);
}

function parseWindowState(parsed: Record<string, unknown>): WindowState | undefined {
	if (
		typeof parsed.width !== "number" ||
		typeof parsed.height !== "number" ||
		typeof parsed.isMaximized !== "boolean"
	) {
		return undefined;
	}
	return {
		x: typeof parsed.x === "number" ? parsed.x : undefined,
		y: typeof parsed.y === "number" ? parsed.y : undefined,
		width: parsed.width,
		height: parsed.height,
		isMaximized: parsed.isMaximized,
	};
}

function parsePersistedWindowState(raw: Record<string, unknown>): PersistedWindowState | undefined {
	const base = parseWindowState(raw);
	if (!base) return undefined;
	const state: PersistedWindowState = {
		...base,
		projectId: typeof raw.projectId === "string" ? raw.projectId : null,
	};
	if (typeof raw.lastViewedPath === "string" && raw.lastViewedPath) {
		state.lastViewedPath = raw.lastViewedPath;
	}
	return state;
}

export function migrateWindowStateIfNeeded(userDataPath: string): boolean {
	const legacyPath = resolveWindowStatePath(userDataPath);
	const multiPath = resolveMultiWindowStatePath(userDataPath);
	if (existsSync(multiPath)) return false;
	if (!existsSync(legacyPath)) return false;
	try {
		const raw = readFileSync(legacyPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const state = parseWindowState(parsed);
		if (!state) return false;
		const persisted: PersistedWindowState = { ...state, projectId: null };
		writeFileSync(multiPath, JSON.stringify([persisted], null, "\t"), "utf-8");
		return true;
	} catch {
		return false;
	}
}

export function loadAllWindowStates(userDataPath: string): PersistedWindowState[] {
	migrateWindowStateIfNeeded(userDataPath);
	const filePath = resolveMultiWindowStatePath(userDataPath);
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const results: PersistedWindowState[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "object" || entry === null) continue;
			const state = parsePersistedWindowState(entry as Record<string, unknown>);
			if (state) results.push(state);
		}
		return results;
	} catch {
		return [];
	}
}

export function saveAllWindowStates(userDataPath: string, states: PersistedWindowState[]): void {
	try {
		const filePath = resolveMultiWindowStatePath(userDataPath);
		writeFileSync(filePath, JSON.stringify(states, null, "\t"), "utf-8");
	} catch {
		// Best-effort — don't crash if userData is read-only.
	}
}

/** @deprecated Use {@link loadAllWindowStates} instead. */
export function loadWindowState(userDataPath: string): WindowState | undefined {
	try {
		const filePath = resolveWindowStatePath(userDataPath);
		if (!existsSync(filePath)) return undefined;
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return parseWindowState(parsed);
	} catch {
		return undefined;
	}
}

/** @deprecated Use {@link saveAllWindowStates} instead. */
export function saveWindowState(userDataPath: string, state: WindowState): void {
	try {
		const filePath = resolveWindowStatePath(userDataPath);
		writeFileSync(filePath, JSON.stringify(state, null, "\t"), "utf-8");
	} catch {
		// Best-effort — don't crash if userData is read-only.
	}
}
