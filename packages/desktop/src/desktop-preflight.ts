/**
 * Desktop preflight validation — checks that critical packaged/dev resources
 * exist before the app gets deep into boot.
 *
 * Run this early in the app.whenReady() boot path so that missing preload
 * scripts, CLI binaries, or CLI shims fail deterministically with
 * actionable messages rather than opaque late-boot crashes.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// `module: "ESNext"` in tsconfig.base.json means this file is emitted as ESM,
// so `require` is not a global. Bind a CJS `require` to this module's URL so
// the node-pty probe below can force-load the native binding.
const require = createRequire(import.meta.url);

/** Codes for hard failures — the app cannot boot correctly until they're fixed. */
export type DesktopPreflightFailureCode = "PRELOAD_MISSING" | "CLI_SHIM_MISSING";

/** Codes for soft failures — the app boots but some features are degraded. */
export type DesktopPreflightWarningCode = "NODE_PTY_UNAVAILABLE";

interface DesktopPreflightIssueBase {
	message: string;
	details?: Record<string, string | boolean | null>;
}

export interface DesktopPreflightFailure extends DesktopPreflightIssueBase {
	code: DesktopPreflightFailureCode;
}

export interface DesktopPreflightWarning extends DesktopPreflightIssueBase {
	code: DesktopPreflightWarningCode;
}

export interface DesktopPreflightOptions {
	/** Absolute path to preload.js. */
	preloadPath: string;
	/**
	 * Path to the Kanban CLI shim script that the runtime manager will spawn.
	 * In our packaging, this is `Resources/bin/kanban{,.cmd}` — a shell
	 * script that lives OUTSIDE the asar bundle and execs node against the
	 * asar-unpacked `cli/cli.js`. Preflight only needs to verify that this
	 * entry point exists; the shim itself validates the interior binary.
	 */
	cliShimPath: string;
	isPackaged: boolean;
	/** When true, attempt to verify that node-pty can be loaded. Defaults to false. */
	checkNodePty?: boolean;
}

export interface DesktopPreflightResult {
	/**
	 * `true` iff there are no `failures` (warnings do not affect `ok`).
	 * Callers that want to surface warnings separately should iterate
	 * `warnings` explicitly.
	 */
	ok: boolean;
	/** Hard failures — the app cannot boot correctly without fixing these. */
	failures: DesktopPreflightFailure[];
	/** Soft failures — the app will boot but some features may be degraded. */
	warnings: DesktopPreflightWarning[];
	resources: {
		preloadExists: boolean;
		cliShimExists: boolean;
		nodePtyLoadable: boolean | null;
	};
}

export function runDesktopPreflight(
	opts: DesktopPreflightOptions,
): DesktopPreflightResult {
	const failures: DesktopPreflightFailure[] = [];
	const warnings: DesktopPreflightWarning[] = [];

	// 1. Preload script
	const preloadExists = existsSync(opts.preloadPath);
	if (!preloadExists) {
		failures.push({
			code: "PRELOAD_MISSING",
			message: `Preload script not found at: ${opts.preloadPath}`,
			details: { path: opts.preloadPath, isPackaged: opts.isPackaged },
		});
	}

	// 2. CLI shim — the spawn entry point (RuntimeChildManager invokes this).
	const cliShimExists = existsSync(opts.cliShimPath);
	if (!cliShimExists) {
		failures.push({
			code: "CLI_SHIM_MISSING",
			message: `CLI shim not found at: ${opts.cliShimPath}`,
			details: { path: opts.cliShimPath, isPackaged: opts.isPackaged },
		});
	}

	// 3. node-pty (optional, warning only). Actually `require()` the module
	//    rather than `require.resolve()` — we specifically want to verify
	//    the native binding loads against the current Electron ABI, not just
	//    that the package exists on disk.
	let nodePtyLoadable: boolean | null = null;
	if (opts.checkNodePty) {
		try {
			require("node-pty");
			nodePtyLoadable = true;
		} catch (err) {
			nodePtyLoadable = false;
			warnings.push({
				code: "NODE_PTY_UNAVAILABLE",
				message: "node-pty could not be loaded. Terminal features may be unavailable.",
				details: {
					error: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}

	return {
		ok: failures.length === 0,
		failures,
		warnings,
		resources: {
			preloadExists,
			cliShimExists,
			nodePtyLoadable,
		},
	};
}
