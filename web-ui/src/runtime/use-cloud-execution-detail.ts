// ---------------------------------------------------------------------------
// use-cloud-execution-detail — hook for cloud execution runtime detail views (P3-1)
// ---------------------------------------------------------------------------
//
// Fetches the execution timeline and summary for a task's cloud execution.
// Polls during active execution states (provisioning, running) and refetches
// when the workspace state version changes.
//
// Architecture rules:
//   - Board column semantics are unchanged — this is supplementary detail data
//   - All cloud execution state is surfaced in the card detail panel only
//   - This hook reads from the server-side execution history model (P2-5)
//
// PRD: Section 6.5, Section 10 Phase 4, Section 17.4 CP4
// ---------------------------------------------------------------------------

import type { RuntimeAppRouterOutputs } from "@runtime-trpc";
import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

type CloudExecutionTimelineOutput = RuntimeAppRouterOutputs["runtime"]["getCloudExecutionTimeline"];
type CloudExecutionSummaryOutput = RuntimeAppRouterOutputs["runtime"]["getCloudExecutionSummary"];

export interface CloudExecutionDetailResult {
	timeline: CloudExecutionTimelineOutput | null;
	summary: CloudExecutionSummaryOutput | null;
	isLoading: boolean;
	isError: boolean;
	refetch: () => Promise<void>;
}

const ACTIVE_POLL_INTERVAL_MS = 3000;

// States that indicate execution is actively in progress — poll more aggressively.
const ACTIVE_EXECUTION_STATES = new Set(["queued", "policy_check", "provisioning", "running", "completing"]);

function isActiveExecutionState(state: string | undefined): boolean {
	return state !== undefined && ACTIVE_EXECUTION_STATES.has(state);
}

export function useCloudExecutionDetail(
	taskId: string | null,
	workspaceId: string | null,
	stateVersion = 0,
): CloudExecutionDetailResult {
	const [timeline, setTimeline] = useState<CloudExecutionTimelineOutput | null>(null);
	const [summary, setSummary] = useState<CloudExecutionSummaryOutput | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isError, setIsError] = useState(false);
	const isMountedRef = useRef(true);
	const requestIdRef = useRef(0);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const fetchDetail = useCallback(async (): Promise<void> => {
		if (!taskId || !workspaceId) {
			setIsLoading(false);
			setIsError(false);
			return;
		}
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setIsLoading(true);
		setIsError(false);
		try {
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const [timelineResult, summaryResult] = await Promise.all([
				trpcClient.runtime.getCloudExecutionTimeline.query({ taskId }),
				trpcClient.runtime.getCloudExecutionSummary.query({ taskId }),
			]);
			if (!isMountedRef.current || requestIdRef.current !== requestId) {
				return;
			}
			setTimeline(timelineResult);
			setSummary(summaryResult);
			setIsLoading(false);
		} catch {
			if (!isMountedRef.current || requestIdRef.current !== requestId) {
				return;
			}
			setIsLoading(false);
			setIsError(true);
		}
	}, [taskId, workspaceId]);

	// Initial fetch and refetch on inputs changing
	useEffect(() => {
		if (!taskId || !workspaceId) {
			requestIdRef.current += 1;
			setTimeline(null);
			setSummary(null);
			setIsLoading(false);
			return;
		}
		void fetchDetail();
	}, [fetchDetail, taskId, workspaceId]);

	// Refetch on state version bump
	useEffect(() => {
		if (!taskId || !workspaceId) {
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void fetchDetail();
	}, [fetchDetail, stateVersion, taskId, workspaceId]);

	// Poll during active execution
	const currentState = summary?.summary?.currentState;
	const shouldPoll = isActiveExecutionState(currentState) && !!taskId && !!workspaceId;

	useEffect(() => {
		if (!shouldPoll) {
			return;
		}
		const interval = window.setInterval(() => {
			void fetchDetail();
		}, ACTIVE_POLL_INTERVAL_MS);
		return () => {
			window.clearInterval(interval);
		};
	}, [fetchDetail, shouldPoll]);

	const refetch = useCallback(async () => {
		await fetchDetail();
	}, [fetchDetail]);

	return { timeline, summary, isLoading, isError, refetch };
}
