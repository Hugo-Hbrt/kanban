/**
 * Desktop boot state — tracks the current phase of the desktop app startup
 * sequence and records failures with normalized codes.
 *
 * Module-level singleton: the boot state is a process-wide concern (there is
 * only one Electron main process) so we expose simple functions rather than
 * requiring callers to manage an instance.
 */

import type { DesktopFailureCode } from "./desktop-failure-codes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesktopBootPhase =
	| "preflight"
	| "create-window"
	| "load-persisted-state"
	| "initialize-connections"
	| "start-local-runtime"
	| "connect-remote-runtime"
	| "load-renderer"
	| "ready"
	| "failed";

export interface DesktopBootPhaseEntry {
	phase: DesktopBootPhase;
	timestamp: string;
}

export interface DesktopBootState {
	currentPhase: DesktopBootPhase;
	lastSuccessfulPhase: DesktopBootPhase | null;
	failureCode: DesktopFailureCode | null;
	failureMessage: string | null;
	startedAt: string;
	phaseHistory: DesktopBootPhaseEntry[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

function createInitialState(): DesktopBootState {
	const now = new Date().toISOString();
	return {
		currentPhase: "preflight",
		lastSuccessfulPhase: null,
		failureCode: null,
		failureMessage: null,
		startedAt: now,
		phaseHistory: [{ phase: "preflight", timestamp: now }],
	};
}

let state: DesktopBootState = createInitialState();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a readonly snapshot of the current boot state.
 */
export function getBootState(): Readonly<DesktopBootState> {
	return state;
}

/**
 * Advance to a new boot phase.
 *
 * Records the transition in `phaseHistory` and updates `lastSuccessfulPhase`
 * to the **previous** `currentPhase` (as long as the previous phase was not
 * `"failed"`).
 */
export function advanceBootPhase(phase: DesktopBootPhase): void {
	const now = new Date().toISOString();

	// Track the previous phase as the last successful one, unless it was 'failed'.
	if (state.currentPhase !== "failed") {
		state.lastSuccessfulPhase = state.currentPhase;
	}

	state.currentPhase = phase;
	state.phaseHistory.push({ phase, timestamp: now });
}

/**
 * Record a boot failure.
 *
 * Transitions to the `"failed"` phase and stores the failure code and
 * human-readable message.  `lastSuccessfulPhase` is preserved so
 * diagnostics can see where boot got to before failing.
 */
export function recordBootFailure(
	code: DesktopFailureCode,
	message: string,
): void {
	const now = new Date().toISOString();

	// Preserve the last successful phase before transitioning to failed.
	if (state.currentPhase !== "failed") {
		state.lastSuccessfulPhase = state.currentPhase;
	}

	state.currentPhase = "failed";
	state.failureCode = code;
	state.failureMessage = message;
	state.phaseHistory.push({ phase: "failed", timestamp: now });
}

/**
 * Reset boot state for restart paths (e.g. `restartRuntimeChild()`).
 *
 * Creates a fresh state so the restart sequence can be tracked independently
 * of the original boot.
 */
export function resetBootState(): void {
	state = createInitialState();
}
