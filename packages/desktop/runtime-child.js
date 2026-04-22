/**
 * RuntimeChildManager — spawns the Kanban CLI as a subprocess, polls for
 * readiness over HTTP, and manages orderly shutdown.
 *
 * Non-goals (intentional):
 *   - No in-process runtime imports. The CLI lives in its own process.
 *   - No custom IPC. Lifecycle is managed via signals + process events.
 *   - No auto-restart. On crash we emit "crashed"; the main process
 *     decides whether to show a disconnected screen or offer restart.
 *   - No window management.
 *
 * Env/PATH policy is delegated to runtime-child-env.ts.
 */
import { execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import path from "node:path";
import { buildFilteredEnv } from "./runtime-child-env.js";
const DEFAULT_MAX_OLD_SPACE_MB = 4096;
const STDERR_TAIL_MAX_BYTES = 8192;
/**
 * Swap `app.asar` → `app.asar.unpacked` so `spawn()` can execute the CLI
 * from the unpacked bundle (asar archives are not natively executable).
 */
export function resolveCliPath(rawPath) {
    return rawPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}
/** Kill a process tree. Uses `taskkill /T /F` on Windows. */
function treeKill(pid, signal = "SIGTERM") {
    if (process.platform === "win32") {
        try {
            execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
        }
        catch {
            /* already dead */
        }
    }
    else {
        try {
            process.kill(pid, signal);
        }
        catch {
            /* ESRCH */
        }
    }
}
/** Poll an HTTP endpoint until it responds or the deadline is reached. */
function waitForReady(host, port, pollIntervalMs, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            if (signal.aborted) {
                reject(new Error("Health check aborted"));
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error(`Runtime did not become reachable within ${timeoutMs}ms`));
                return;
            }
            const req = http.get({ host, port, path: "/", timeout: 2_000 }, (res) => {
                res.resume();
                resolve();
            });
            req.on("error", () => setTimeout(check, pollIntervalMs));
            req.on("timeout", () => {
                req.destroy();
                setTimeout(check, pollIntervalMs);
            });
        };
        check();
    });
}
export class RuntimeChildManager extends EventEmitter {
    opts;
    child = null;
    shutdownRequested = false;
    disposed = false;
    abortController = null;
    constructor(options) {
        super();
        this.opts = {
            cliPath: options.cliPath,
            shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
            pollIntervalMs: options.pollIntervalMs ?? 200,
            startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
            maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
            spawnFn: options.spawnFn ?? spawn,
        };
    }
    /** Start the CLI subprocess. Resolves with the runtime URL when reachable. */
    async start(config) {
        if (this.disposed)
            throw new Error("RuntimeChildManager has been disposed");
        if (this.child)
            throw new Error("Child process is already running");
        this.shutdownRequested = false;
        return this.spawnChild(config);
    }
    /** Graceful shutdown via SIGTERM; force-kills after shutdownTimeoutMs. */
    async shutdown() {
        if (!this.child)
            return;
        this.shutdownRequested = true;
        this.abortController?.abort();
        return new Promise((resolve) => {
            const forceTimer = setTimeout(() => {
                this.forceKill();
                resolve();
            }, this.opts.shutdownTimeoutMs);
            if (this.child) {
                this.child.once("exit", () => {
                    clearTimeout(forceTimer);
                    resolve();
                });
            }
            const pid = this.child?.pid;
            if (pid !== undefined)
                treeKill(pid, "SIGTERM");
        });
    }
    /** Dispose: kill child and prevent further use. */
    async dispose() {
        this.disposed = true;
        await this.shutdown();
        this.removeAllListeners();
    }
    get running() {
        return this.child !== null;
    }
    get pid() {
        return this.child?.pid ?? null;
    }
    async spawnChild(config) {
        const cliPath = resolveCliPath(this.opts.cliPath);
        const url = `http://${config.host}:${config.port}`;
        const env = buildFilteredEnv();
        env.KANBAN_DESKTOP = "1";
        // `buildFilteredEnv()` does not forward NODE_OPTIONS (not in the
        // allowlist), so we just set ours — no existing-value merge needed.
        env.NODE_OPTIONS = `--max-old-space-size=${this.opts.maxOldSpaceMb}`;
        const args = ["--no-open", "--port", String(config.port), "--host", config.host];
        const child = this.opts.spawnFn(cliPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
            // Detach on Windows so treeKill can reach grandchildren.
            detached: process.platform === "win32",
        });
        this.child = child;
        // Create the abort controller BEFORE attaching exit/error handlers so
        // those handlers can abort a pending health check even if the failure
        // fires synchronously during spawn setup.
        this.abortController = new AbortController();
        // Pre-ready lifecycle contract: failures before "ready" reject start()
        // with a diagnostic; failures after "ready" flow through crashed/error
        // events. One failure never produces both a rejection and an event.
        let readyEmitted = false;
        let startupFailure = null;
        // Drain stdout so the child doesn't block on a full OS pipe buffer.
        child.stdout?.on("data", () => { });
        // Rolling stderr tail — sized to stay in memory for the lifetime of
        // the subprocess and handed to the crashed listener on exit.
        let stderrTail = "";
        child.stderr?.on("data", (chunk) => {
            stderrTail += chunk.toString("utf8");
            if (stderrTail.length > STDERR_TAIL_MAX_BYTES) {
                stderrTail = stderrTail.slice(-STDERR_TAIL_MAX_BYTES);
            }
        });
        child.on("exit", (code, signal) => {
            this.child = null;
            if (this.shutdownRequested)
                return;
            if (!readyEmitted) {
                const tail = stderrTail.trim();
                startupFailure = new Error(`CLI subprocess exited during startup (exitCode=${code ?? "null"}, signal=${signal ?? "null"}). Last stderr: ${tail || "<empty>"}`);
                this.abortController?.abort();
            }
            else {
                this.emit("crashed", code, signal, stderrTail);
            }
        });
        child.on("error", (err) => {
            this.child = null;
            if (!readyEmitted) {
                startupFailure = err;
                this.abortController?.abort();
            }
            else {
                this.emit("error", err.message);
            }
        });
        try {
            await waitForReady(config.host, config.port, this.opts.pollIntervalMs, this.opts.startupTimeoutMs, this.abortController.signal);
        }
        catch (error) {
            // Prefer the captured lifecycle failure (more informative) over
            // waitForReady's abort/timeout error. Tear down a still-alive
            // child so no orphan remains.
            if (this.child)
                this.forceKill();
            throw startupFailure ?? error;
        }
        // Guard against dispose() landing between health check resolving and
        // the ready announcement.
        if (this.disposed) {
            if (this.child)
                this.forceKill();
            throw new Error("RuntimeChildManager was disposed during startup");
        }
        readyEmitted = true;
        this.emit("ready", url);
        return url;
    }
    forceKill() {
        if (!this.child)
            return;
        const pid = this.child.pid;
        if (pid !== undefined)
            treeKill(pid, "SIGKILL");
        try {
            this.child.kill("SIGKILL");
        }
        catch {
            /* already dead */
        }
    }
}
//# sourceMappingURL=runtime-child.js.map