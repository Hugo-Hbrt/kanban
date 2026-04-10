// ---------------------------------------------------------------------------
// CloudExecutionDetailPanel — rich runtime detail view for cloud-agent tasks (P3-1)
// ---------------------------------------------------------------------------
//
// Displays execution timeline, attempt history, instance metadata, streaming
// log status, and artifact/error output for cloud-agent tasks.
//
// Architecture rules (PRD Section 6.5, Section 12):
//   - Board column semantics are unchanged — this panel is supplementary
//   - All cloud execution detail is confined to the card detail panel
//   - Detail reads from the execution history model (P2-5 foundations)
//
// PRD: Section 10 Phase 4, Section 17.4 CP4
// ---------------------------------------------------------------------------

import type { ExecutionTimelineEntry } from "@runtime-contract";
import type { RuntimeAppRouterOutputs } from "@runtime-trpc";
import { AlertTriangle, CheckCircle, Clock, Cloud, RefreshCw, XCircle } from "lucide-react";
import { useCallback } from "react";
import { CloudExecutionStateBadge } from "@/components/detail-panels/cloud-execution-state-badge";

type CloudExecutionTimelineResponse = RuntimeAppRouterOutputs["runtime"]["getCloudExecutionTimeline"];
type CloudExecutionSummaryResponse = RuntimeAppRouterOutputs["runtime"]["getCloudExecutionSummary"];

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = Math.round(seconds % 60);
	return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatTimestamp(iso: string): string {
	try {
		return new Date(iso).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			second: "2-digit",
		});
	} catch {
		return iso;
	}
}

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
	return (
		<div className="text-xs font-semibold text-text-secondary uppercase tracking-wider" style={{ marginBottom: 6 }}>
			{children}
		</div>
	);
}

function MetaRow({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: React.ReactNode;
	mono?: boolean;
}): React.ReactElement {
	return (
		<div className="flex items-start gap-2" style={{ fontSize: 12 }}>
			<span className="text-text-tertiary shrink-0" style={{ width: 120 }}>
				{label}
			</span>
			<span className={`text-text-primary break-all ${mono ? "font-mono" : ""}`}>{value}</span>
		</div>
	);
}

function TimelineEntryRow({ entry }: { entry: ExecutionTimelineEntry }): React.ReactElement {
	const iconMap: Record<string, React.ReactElement> = {
		reconciler: <RefreshCw size={12} className="text-amber-500 shrink-0" />,
		cancel: <XCircle size={12} className="text-red-500 shrink-0" />,
		retry: <RefreshCw size={12} className="text-blue-500 shrink-0" />,
		replay: <RefreshCw size={12} className="text-purple-500 shrink-0" />,
		teardown: <XCircle size={12} className="text-text-secondary shrink-0" />,
		callback: <CheckCircle size={12} className="text-green-500 shrink-0" />,
	};
	const icon = iconMap[entry.category] ?? <Clock size={12} className="text-text-secondary shrink-0" />;
	return (
		<div
			data-testid="timeline-entry"
			data-category={entry.category}
			className="flex items-start gap-2 py-1"
			style={{ fontSize: 12 }}
		>
			<span className="pt-0.5">{icon}</span>
			<div className="flex-1 min-w-0">
				<div className="text-text-primary">{entry.summary}</div>
				{entry.fromState && entry.toState ? (
					<div className="text-text-tertiary" style={{ fontSize: 11 }}>
						{entry.fromState} → {entry.toState}
					</div>
				) : null}
			</div>
			<div className="text-text-tertiary shrink-0" style={{ fontSize: 11 }}>
				{formatTimestamp(entry.timestamp)}
			</div>
		</div>
	);
}

export interface CloudExecutionDetailPanelProps {
	taskId: string;
	timeline: CloudExecutionTimelineResponse | null;
	summary: CloudExecutionSummaryResponse | null;
	isLoading: boolean;
	isError: boolean;
	onRefetch?: () => Promise<void>;
}

export function CloudExecutionDetailPanel({
	taskId,
	timeline,
	summary,
	isLoading,
	isError,
	onRefetch,
}: CloudExecutionDetailPanelProps): React.ReactElement {
	const handleRefetch = useCallback(() => {
		void onRefetch?.();
	}, [onRefetch]);

	if (!summary?.found && !timeline?.found && !isLoading && !isError) {
		return (
			<div
				data-testid="cloud-execution-detail-panel"
				data-state="no-data"
				className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary"
				style={{ fontSize: 13 }}
			>
				<Cloud size={20} className="opacity-40" />
				<span>No cloud execution history</span>
			</div>
		);
	}

	if (isError) {
		return (
			<div
				data-testid="cloud-execution-detail-panel"
				data-state="error"
				className="flex flex-col items-center justify-center gap-2 py-8 text-red-500"
				style={{ fontSize: 13 }}
			>
				<AlertTriangle size={20} />
				<span>Failed to load execution detail</span>
				{onRefetch ? (
					<button type="button" onClick={handleRefetch} className="text-xs text-text-secondary underline">
						Retry
					</button>
				) : null}
			</div>
		);
	}

	if (isLoading && !summary && !timeline) {
		return (
			<div
				data-testid="cloud-execution-detail-panel"
				data-state="loading"
				className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary"
				style={{ fontSize: 13 }}
			>
				<RefreshCw size={16} className="animate-spin" />
				<span>Loading execution detail…</span>
			</div>
		);
	}

	const currentState = summary?.summary?.currentState;
	const execSummary = summary?.summary ?? null;
	const timelineEntries = timeline?.timeline?.entries ?? [];

	return (
		<div
			data-testid="cloud-execution-detail-panel"
			data-state={currentState ?? "no-state"}
			data-task-id={taskId}
			className="flex flex-col gap-4 p-4"
			style={{ fontSize: 13 }}
		>
			{currentState ? (
				<div className="flex items-center gap-2">
					<Cloud size={14} className="text-text-secondary shrink-0" />
					<span className="text-text-secondary font-medium" style={{ fontSize: 12 }}>
						Cloud Execution
					</span>
					<CloudExecutionStateBadge state={currentState} />
					{isLoading ? <RefreshCw size={12} className="animate-spin text-text-tertiary ml-auto" /> : null}
				</div>
			) : null}
			{execSummary ? (
				<div className="flex flex-col gap-1.5">
					<SectionTitle>Instance</SectionTitle>
					{execSummary.currentInstanceId ? (
						<MetaRow label="Instance ID" value={execSummary.currentInstanceId} mono />
					) : null}
					<MetaRow
						label="Attempt"
						value={execSummary.latestAttemptNumber > 0 ? `#${execSummary.latestAttemptNumber}` : "—"}
					/>
					<MetaRow
						label="Mode"
						value={
							execSummary.executionMode === "cloud_agent" ? "Cloud Agent" : (execSummary.executionMode ?? "—")
						}
					/>
				</div>
			) : null}
			{execSummary && (execSummary.totalDurationSeconds > 0 || execSummary.totalTokenUsage > 0) ? (
				<div className="flex flex-col gap-1.5">
					<SectionTitle>Usage</SectionTitle>
					{execSummary.totalDurationSeconds > 0 ? (
						<MetaRow label="Duration" value={formatDuration(execSummary.totalDurationSeconds)} />
					) : null}
					{execSummary.totalTokenUsage > 0 ? (
						<MetaRow label="Token Usage" value={execSummary.totalTokenUsage.toLocaleString()} />
					) : null}
				</div>
			) : null}
			{execSummary && execSummary.totalAttempts > 0 ? (
				<div className="flex flex-col gap-1.5">
					<SectionTitle>
						Attempts ({execSummary.totalAttempts})
						{execSummary.hasBeenRetried ? (
							<span className="ml-1 text-blue-500 normal-case font-normal">(retried)</span>
						) : null}
						{execSummary.hasBeenReplayed ? (
							<span className="ml-1 text-purple-500 normal-case font-normal">(replayed)</span>
						) : null}
					</SectionTitle>
					<div className="flex flex-col gap-1" data-testid="attempt-history-list">
						{execSummary.outcomePattern.map((outcome, idx) => (
							<div
								key={idx}
								data-testid="attempt-history-entry"
								data-attempt={idx + 1}
								className="flex items-center gap-2 py-0.5"
								style={{ fontSize: 12 }}
							>
								<span className="text-text-tertiary w-16 shrink-0">Attempt {idx + 1}</span>
								{outcome === "completed" ? (
									<CheckCircle size={12} className="text-green-500" />
								) : outcome === "failed" ? (
									<XCircle size={12} className="text-red-500" />
								) : outcome === "canceled" ? (
									<XCircle size={12} className="text-text-secondary" />
								) : (
									<Clock size={12} className="text-amber-500" />
								)}
								<span
									className={
										outcome === "completed"
											? "text-green-600 dark:text-green-400"
											: outcome === "failed"
												? "text-red-600 dark:text-red-400"
												: outcome === "canceled"
													? "text-text-secondary"
													: "text-amber-600 dark:text-amber-400"
									}
								>
									{outcome ?? "In progress"}
								</span>
							</div>
						))}
					</div>
				</div>
			) : null}
			{execSummary && Object.keys(execSummary.timeInStates).length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<SectionTitle>State Duration</SectionTitle>
					<div className="flex flex-col gap-1">
						{Object.entries(execSummary.timeInStates).map(([state, seconds]) => (
							<div
								key={state}
								data-testid="state-duration-row"
								className="flex items-center justify-between"
								style={{ fontSize: 12 }}
							>
								<span className="text-text-secondary capitalize">{state.replace("_", " ")}</span>
								<span className="text-text-primary font-mono">{formatDuration(seconds)}</span>
							</div>
						))}
					</div>
				</div>
			) : null}
			{timelineEntries.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<SectionTitle>Timeline ({timelineEntries.length} events)</SectionTitle>
					<div
						data-testid="execution-timeline"
						className="flex flex-col divide-y divide-border-subtle"
						style={{ maxHeight: 320, overflowY: "auto" }}
					>
						{timelineEntries.map((entry) => (
							<TimelineEntryRow key={entry.eventId} entry={entry} />
						))}
					</div>
				</div>
			) : null}
			{timelineEntries.some((e) => e.category === "reconciler") ? (
				<div className="flex items-center gap-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/20">
					<AlertTriangle size={13} className="text-amber-500 shrink-0" />
					<span className="text-amber-600 dark:text-amber-400" style={{ fontSize: 12 }}>
						Reconciler actions recorded — check timeline for details.
					</span>
				</div>
			) : null}
			{currentState === "failed" ? (
				<div className="flex items-start gap-1.5 p-2 rounded bg-red-500/10 border border-red-500/20">
					<XCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
					<div className="flex flex-col gap-0.5">
						<span className="text-red-600 dark:text-red-400 font-medium" style={{ fontSize: 12 }}>
							Execution Failed
						</span>
						<span className="text-text-secondary" style={{ fontSize: 11 }}>
							See timeline for failure details.
						</span>
					</div>
				</div>
			) : null}
			{execSummary?.teardownDecision ? (
				<div className="flex flex-col gap-1.5">
					<SectionTitle>Teardown</SectionTitle>
					<MetaRow
						label="Decision"
						value={
							<span
								className={
									execSummary.teardownDecision === "debug-preserve" ? "text-amber-600 dark:text-amber-400" : ""
								}
							>
								{execSummary.teardownDecision}
							</span>
						}
					/>
				</div>
			) : null}
		</div>
	);
}

export { CloudExecutionStateBadge };
