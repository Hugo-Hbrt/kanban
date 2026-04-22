/**
 * Desktop preflight validation — checks that critical packaged/dev resources
 * exist before the app gets deep into boot.
 *
 * Run this early in the app.whenReady() boot path so that missing preload
 * scripts, CLI binaries, or CLI shims fail deterministically with
 * actionable messages rather than opaque late-boot crashes.
 */
import { existsSync } from "node:fs";
export function runDesktopPreflight(opts) {
    const failures = [];
    const warnings = [];
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
    let nodePtyLoadable = null;
    if (opts.checkNodePty) {
        try {
            require("node-pty");
            nodePtyLoadable = true;
        }
        catch (err) {
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
//# sourceMappingURL=desktop-preflight.js.map