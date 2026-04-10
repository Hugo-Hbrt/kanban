import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudExecutionDetailPanel } from "@/components/detail-panels/cloud-execution-detail-panel";
import { CloudExecutionStateBadge } from "@/components/detail-panels/cloud-execution-state-badge";

describe("CloudExecutionStateBadge", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("renders badge with correct data-state attribute", async () => {
		await act(async () => {
			root.render(createElement(CloudExecutionStateBadge, { state: "running" }));
		});
		const badge = container.querySelector('[data-testid="cloud-execution-state-badge"]');
		expect(badge).toBeTruthy();
		expect(badge?.getAttribute("data-state")).toBe("running");
		expect(badge?.textContent).toContain("Running");
	});

	it("renders provisioning badge", async () => {
		await act(async () => {
			root.render(createElement(CloudExecutionStateBadge, { state: "provisioning" }));
		});
		const badge = container.querySelector('[data-testid="cloud-execution-state-badge"]');
		expect(badge?.getAttribute("data-state")).toBe("provisioning");
		expect(badge?.textContent).toContain("Provisioning");
	});

	it("renders completed badge", async () => {
		await act(async () => {
			root.render(createElement(CloudExecutionStateBadge, { state: "completed" }));
		});
		const badge = container.querySelector('[data-testid="cloud-execution-state-badge"]');
		expect(badge?.textContent).toContain("Completed");
	});

	it("renders failed badge", async () => {
		await act(async () => {
			root.render(createElement(CloudExecutionStateBadge, { state: "failed" }));
		});
		const badge = container.querySelector('[data-testid="cloud-execution-state-badge"]');
		expect(badge?.textContent).toContain("Failed");
	});

	it("renders aria-label with state name", async () => {
		await act(async () => {
			root.render(createElement(CloudExecutionStateBadge, { state: "queued" }));
		});
		const badge = container.querySelector('[data-testid="cloud-execution-state-badge"]');
		expect(badge?.getAttribute("aria-label")).toContain("Queued");
	});
});

describe("CloudExecutionDetailPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("shows no-data state when no execution history", async () => {
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary: null,
					isLoading: false,
					isError: false,
				}),
			);
		});
		const panel = container.querySelector('[data-testid="cloud-execution-detail-panel"]');
		expect(panel?.getAttribute("data-state")).toBe("no-data");
		expect(panel?.textContent).toContain("No cloud execution history");
	});

	it("shows loading state during initial load", async () => {
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary: null,
					isLoading: true,
					isError: false,
				}),
			);
		});
		const panel = container.querySelector('[data-testid="cloud-execution-detail-panel"]');
		expect(panel?.getAttribute("data-state")).toBe("loading");
		expect(panel?.textContent).toContain("Loading");
	});

	it("shows error state with retry button", async () => {
		const onRefetch = vi.fn(async () => {});
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary: null,
					isLoading: false,
					isError: true,
					onRefetch,
				}),
			);
		});
		const panel = container.querySelector('[data-testid="cloud-execution-detail-panel"]');
		expect(panel?.getAttribute("data-state")).toBe("error");
		const retryBtn = container.querySelector("button");
		expect(retryBtn).toBeTruthy();
	});

	it("renders running state with badge", async () => {
		const summary = {
			found: true,
			summary: {
				taskId: "task-1",
				currentState: "running" as const,
				totalAttempts: 1,
				hasBeenRetried: false,
				hasBeenReplayed: false,
				executionMode: "cloud_agent" as const,
				outcomePattern: [null],
				timeInStates: { queued: 5 },
				totalDurationSeconds: 0,
				totalTokenUsage: 0,
				latestAttemptNumber: 1,
				latestExecutionId: "exec-1",
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary,
					isLoading: false,
					isError: false,
				}),
			);
		});
		const panel = container.querySelector('[data-testid="cloud-execution-detail-panel"]');
		expect(panel?.getAttribute("data-state")).toBe("running");
		const badge = container.querySelector('[data-testid="cloud-execution-state-badge"]');
		expect(badge).toBeTruthy();
		expect(badge?.textContent).toContain("Running");
	});

	it("renders attempt history entries", async () => {
		const summary = {
			found: true,
			summary: {
				taskId: "task-1",
				currentState: "completed" as const,
				totalAttempts: 2,
				hasBeenRetried: true,
				hasBeenReplayed: false,
				executionMode: "cloud_agent" as const,
				outcomePattern: ["failed" as const, "completed" as const],
				timeInStates: {},
				totalDurationSeconds: 90,
				totalTokenUsage: 2000,
				latestAttemptNumber: 2,
				latestExecutionId: "exec-2",
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary,
					isLoading: false,
					isError: false,
				}),
			);
		});
		const entries = container.querySelectorAll('[data-testid="attempt-history-entry"]');
		expect(entries).toHaveLength(2);
		expect(entries[0]?.getAttribute("data-attempt")).toBe("1");
		expect(entries[1]?.getAttribute("data-attempt")).toBe("2");
	});

	it("renders timeline entries when provided", async () => {
		const timeline = {
			found: true,
			timeline: {
				taskId: "task-1",
				totalEntries: 2,
				entries: [
					{
						eventId: "e1",
						taskId: "task-1",
						attemptNumber: 1,
						category: "lifecycle" as const,
						timestamp: "2026-04-09T00:01:00Z",
						fromState: "draft" as const,
						toState: "queued" as const,
						trigger: "submit",
						triggerSource: "user",
						summary: "draft \u2192 queued (submit)",
					},
					{
						eventId: "e2",
						taskId: "task-1",
						attemptNumber: 1,
						category: "cancel" as const,
						timestamp: "2026-04-09T00:02:00Z",
						fromState: "running" as const,
						toState: "canceled" as const,
						trigger: "user_cancel",
						triggerSource: "user",
						summary: "Canceled from running",
					},
				],
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline,
					summary: null,
					isLoading: false,
					isError: false,
				}),
			);
		});
		const tl = container.querySelector('[data-testid="execution-timeline"]');
		expect(tl).toBeTruthy();
		const tlEntries = container.querySelectorAll('[data-testid="timeline-entry"]');
		expect(tlEntries).toHaveLength(2);
		expect(tlEntries[0]?.getAttribute("data-category")).toBe("lifecycle");
		expect(tlEntries[1]?.getAttribute("data-category")).toBe("cancel");
	});

	it("shows failed execution notice for failed state", async () => {
		const summary = {
			found: true,
			summary: {
				taskId: "task-1",
				currentState: "failed" as const,
				totalAttempts: 1,
				hasBeenRetried: false,
				hasBeenReplayed: false,
				executionMode: "cloud_agent" as const,
				outcomePattern: ["failed" as const],
				timeInStates: {},
				totalDurationSeconds: 30,
				totalTokenUsage: 0,
				latestAttemptNumber: 1,
				latestExecutionId: "exec-1",
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary,
					isLoading: false,
					isError: false,
				}),
			);
		});
		const panel = container.querySelector('[data-testid="cloud-execution-detail-panel"]');
		expect(panel?.textContent).toContain("Execution Failed");
	});

	it("shows reconciler notice when reconciler events present", async () => {
		const timeline = {
			found: true,
			timeline: {
				taskId: "task-1",
				totalEntries: 1,
				entries: [
					{
						eventId: "r1",
						taskId: "task-1",
						attemptNumber: 1,
						category: "reconciler" as const,
						timestamp: "2026-04-09T00:01:00Z",
						summary: "Reconciler: stale recovery",
					},
				],
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline,
					summary: null,
					isLoading: false,
					isError: false,
				}),
			);
		});
		expect(container.textContent).toContain("Reconciler actions recorded");
	});

	it("does not show board column fields in the panel", async () => {
		const summary = {
			found: true,
			summary: {
				taskId: "task-1",
				currentState: "running" as const,
				totalAttempts: 1,
				hasBeenRetried: false,
				hasBeenReplayed: false,
				executionMode: "cloud_agent" as const,
				outcomePattern: [null],
				timeInStates: {},
				totalDurationSeconds: 0,
				totalTokenUsage: 0,
				latestAttemptNumber: 1,
				latestExecutionId: "exec-1",
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-1",
					timeline: null,
					summary,
					isLoading: false,
					isError: false,
				}),
			);
		});
		// Board-column specific labels must not appear
		expect(container.textContent).not.toContain("backlog");
		expect(container.textContent).not.toContain("in_progress");
		expect(container.textContent).not.toContain("review");
		expect(container.textContent).not.toContain("trash");
	});

	it("panel carries data-task-id attribute", async () => {
		const summary = {
			found: true,
			summary: {
				taskId: "task-abc",
				currentState: "running" as const,
				totalAttempts: 1,
				hasBeenRetried: false,
				hasBeenReplayed: false,
				executionMode: "cloud_agent" as const,
				outcomePattern: [null],
				timeInStates: {},
				totalDurationSeconds: 0,
				totalTokenUsage: 0,
				latestAttemptNumber: 1,
				latestExecutionId: "exec-1",
			},
		};
		await act(async () => {
			root.render(
				createElement(CloudExecutionDetailPanel, {
					taskId: "task-abc",
					timeline: null,
					summary,
					isLoading: false,
					isError: false,
				}),
			);
		});
		const panel = container.querySelector('[data-testid="cloud-execution-detail-panel"]');
		expect(panel?.getAttribute("data-task-id")).toBe("task-abc");
	});
});
