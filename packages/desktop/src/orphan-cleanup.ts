/**
 * Orphan desktop runtime cleanup — best-effort termination of orphaned
 * runtime processes left behind by a prior desktop session that crashed.
 *
 * Strategy: SIGTERM → wait 3 s → SIGKILL → wait 2 s → clearRuntimeDescriptor().
 *
 * Platform note: On Windows, `process.kill()` does not support signals —
 * both SIGTERM and SIGKILL terminate unconditionally. Grandchild processes
 * (agent PTY sessions) become orphans themselves and will die when their
 * parent heartbeat stops. This is acceptable because orphan cleanup is
 * best-effort.
 */

import { clearRuntimeDescriptor, readRuntimeDescriptor } from "kanban";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanCleanupResult {
	cleaned: boolean;
	method: string;
}

/**
 * Descriptor-like shape — we only need the `pid` field for cleanup.
 * Accepts the full RuntimeDescriptor or any object with a numeric pid.
 */
export interface OrphanDescriptor {
	pid: number;
}

// ---------------------------------------------------------------------------
// PID death polling
// ---------------------------------------------------------------------------

/**
 * Wait for a process to die by polling `process.kill(pid, 0)`.
 *
 * Returns `true` if the process died within `timeoutMs`, `false` if it is
 * still alive when the timeout elapses.
 *
 * @internal Exported for testing only.
 */
export async function waitForPidDeath(pid: number, timeoutMs: number): Promise<boolean> {
	const POLL_INTERVAL_MS = 200;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			// signal 0 checks existence without sending a signal.
			process.kill(pid, 0);
		} catch {
			// ESRCH — process no longer exists.
			return true;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	// One final check after the loop in case the last sleep overshot.
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Safe descriptor clear — only clear if the descriptor still belongs to
// the orphaned PID. Between killing the orphan and clearing, another
// process (e.g. CLI) may have written a fresh descriptor.
// ---------------------------------------------------------------------------

async function clearDescriptorIfStillOrphan(orphanPid: number): Promise<void> {
	const current = await readRuntimeDescriptor();
	if (!current || current.pid === orphanPid) {
		await clearRuntimeDescriptor();
	}
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

/**
 * Attempt to terminate an orphaned desktop runtime process.
 *
 * 1. Send SIGTERM and wait up to 3 s for the process to exit.
 * 2. If still alive, escalate to SIGKILL and wait up to 2 s.
 * 3. If the process is gone (by either signal or was already dead),
 *    clear the stale runtime descriptor — but only if it still belongs
 *    to the orphaned PID (another process may have claimed it).
 *
 * This function **never throws** — all errors are caught and returned
 * as part of the result so callers can fire-and-forget safely.
 */
export async function attemptOrphanCleanup(
	descriptor: OrphanDescriptor,
	options?: { sigtermTimeoutMs?: number; sigkillTimeoutMs?: number },
): Promise<OrphanCleanupResult> {
	const sigtermTimeout = options?.sigtermTimeoutMs ?? 3_000;
	const sigkillTimeout = options?.sigkillTimeoutMs ?? 2_000;
	try {
		process.kill(descriptor.pid, "SIGTERM");

		const died = await waitForPidDeath(descriptor.pid, sigtermTimeout);
		if (died) {
			await clearDescriptorIfStillOrphan(descriptor.pid);
			return { cleaned: true, method: "SIGTERM" };
		}

		process.kill(descriptor.pid, "SIGKILL");

		const killedHard = await waitForPidDeath(descriptor.pid, sigkillTimeout);
		if (killedHard) {
			await clearDescriptorIfStillOrphan(descriptor.pid);
			return { cleaned: true, method: "SIGKILL" };
		}

		return { cleaned: false, method: "failed" };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") {
			// Process was already dead when we tried to signal it.
			await clearDescriptorIfStillOrphan(descriptor.pid);
			return { cleaned: true, method: "already-dead" };
		}
		return { cleaned: false, method: `error:${code}` };
	}
}
