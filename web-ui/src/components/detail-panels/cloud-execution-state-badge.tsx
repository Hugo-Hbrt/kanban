// ---------------------------------------------------------------------------
// CloudExecutionStateBadge — visual chip for cloud execution lifecycle states
// ---------------------------------------------------------------------------
//
// Renders a colored badge/chip for each CloudExecutionState value.
// Board column semantics are unchanged — this badge is only shown inside the
// card detail panel as supplementary execution lifecycle information.
//
// PRD: Section 6.5, Section 10 Phase 4
// ---------------------------------------------------------------------------

import type { CloudExecutionState } from "@runtime-contract";

interface CloudExecutionStateBadgeProps {
	state: CloudExecutionState;
	className?: string;
}

type BadgeStyle = {
	label: string;
	colorClass: string;
};

const STATE_BADGE_MAP: Record<CloudExecutionState, BadgeStyle> = {
	draft: { label: "Draft", colorClass: "bg-surface-2 text-text-secondary border border-border-subtle" },
	queued: {
		label: "Queued",
		colorClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
	},
	policy_check: {
		label: "Policy Check",
		colorClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
	},
	provisioning: {
		label: "Provisioning",
		colorClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30",
	},
	running: {
		label: "Running",
		colorClass: "bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30",
	},
	completing: {
		label: "Completing",
		colorClass: "bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30",
	},
	completed: {
		label: "Completed",
		colorClass: "bg-green-500/20 text-green-700 dark:text-green-300 border border-green-500/40",
	},
	failed: { label: "Failed", colorClass: "bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30" },
	canceled: { label: "Canceled", colorClass: "bg-surface-2 text-text-secondary border border-border-subtle" },
	teardown: { label: "Teardown", colorClass: "bg-surface-2 text-text-secondary border border-border-subtle" },
	archived: { label: "Archived", colorClass: "bg-surface-2 text-text-tertiary border border-border-subtle" },
};

function PulsingDot({ colorClass }: { colorClass: string }): React.ReactElement {
	return (
		<span
			className={`inline-block w-2 h-2 rounded-full animate-pulse ${colorClass}`}
			aria-hidden
			style={{ flexShrink: 0 }}
		/>
	);
}

const ACTIVE_STATES: ReadonlySet<CloudExecutionState> = new Set<CloudExecutionState>([
	"queued",
	"policy_check",
	"provisioning",
	"running",
	"completing",
]);

export function CloudExecutionStateBadge({ state, className = "" }: CloudExecutionStateBadgeProps): React.ReactElement {
	const badge = STATE_BADGE_MAP[state] ?? {
		label: state,
		colorClass: "bg-surface-2 text-text-secondary border border-border-subtle",
	};
	const isActive = ACTIVE_STATES.has(state);

	return (
		<span
			data-testid="cloud-execution-state-badge"
			data-state={state}
			className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${badge.colorClass} ${className}`}
			role="img"
			aria-label={`Cloud execution state: ${badge.label}`}
		>
			{isActive ? (
				<PulsingDot
					colorClass={
						state === "running" || state === "completing"
							? "bg-green-500"
							: state === "provisioning"
								? "bg-blue-500"
								: "bg-amber-500"
					}
				/>
			) : null}
			{badge.label}
		</span>
	);
}
