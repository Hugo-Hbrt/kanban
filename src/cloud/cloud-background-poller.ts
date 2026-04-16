// ---------------------------------------------------------------------------
// Cloud Background Poller
//
// After a cloud task is dispatched, the orchestrator needs to continue
// polling cloud-platform for status updates. This module manages periodic
// processTask() calls for all active cloud tasks and invokes a callback
// when a task reaches a terminal state.
// ---------------------------------------------------------------------------

import type { CloudExecutionOrchestrator, OrchestratorLogger } from "./cloud-execution-orchestrator";

export interface CloudBackgroundPollerConfig {
	readonly orchestrator: CloudExecutionOrchestrator;
	readonly pollIntervalMs?: number;
	readonly onTerminal?: (taskId: string, terminalState: string) => void;
	readonly logger?: OrchestratorLogger;
}

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "archived", "teardown"]);
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class CloudBackgroundPoller {
	private readonly config: CloudBackgroundPollerConfig;
	private readonly activeTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly pollIntervalMs: number;

	constructor(config: CloudBackgroundPollerConfig) {
		this.config = config;
		this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	register(taskId: string): void {
		if (this.activeTimers.has(taskId)) return;

		this.config.logger?.info("[cloud-poller] Registered background polling", { taskId });

		const timer = setInterval(() => {
			void this.pollOnce(taskId);
		}, this.pollIntervalMs);

		this.activeTimers.set(taskId, timer);
	}

	unregister(taskId: string): void {
		const timer = this.activeTimers.get(taskId);
		if (timer) {
			clearInterval(timer);
			this.activeTimers.delete(taskId);
			this.config.logger?.info("[cloud-poller] Unregistered background polling", { taskId });
		}
	}

	private async pollOnce(taskId: string): Promise<void> {
		try {
			const result = await this.config.orchestrator.processTask(taskId);

			if (!result) {
				this.config.logger?.info("[cloud-poller] No state change", { taskId });
				return;
			}

			this.config.logger?.info("[cloud-poller] State update", {
				taskId,
				newState: result.newState,
			});

			if (TERMINAL_STATES.has(result.newState)) {
				this.unregister(taskId);
				this.config.onTerminal?.(taskId, result.newState);
			}
		} catch (err) {
			this.config.logger?.warn("[cloud-poller] Poll error (will retry)", { taskId, error: err });
		}
	}

	get activeTaskIds(): string[] {
		return [...this.activeTimers.keys()];
	}

	stopAll(): void {
		for (const taskId of this.activeTimers.keys()) {
			this.unregister(taskId);
		}
	}
}
