/**
 * Normalized failure codes for the desktop app startup sequence.
 *
 * Each code identifies a specific category of failure so that diagnostics,
 * logging, and future telemetry can classify startup errors without
 * parsing free-form strings.
 */

export type DesktopFailureCode =
	| "PRELOAD_LOAD_FAILED"
	| "RUNTIME_CHILD_ENTRY_MISSING"
	| "RUNTIME_CHILD_START_FAILED"
	| "PACKAGED_SHIM_MISSING"
	| "CONNECTION_STORE_CORRUPT"
	| "REMOTE_CONNECTION_UNREACHABLE"
	| "REMOTE_AUTH_REJECTED"
	| "DESCRIPTOR_STALE"
	| "DESKTOP_RUNTIME_ORPHANED"
	| "RUNTIME_HEALTHCHECK_FAILED"
	| "PREFLIGHT_FAILED"
	| "UNKNOWN_STARTUP_FAILURE";
