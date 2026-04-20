import { AlertCircle, RefreshCw, Terminal } from "lucide-react";
import type { ReactElement } from "react";

export function RuntimeDisconnectedFallback(): ReactElement {
	return (
		<div
			style={{
				display: "flex",
				height: "100svh",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--color-surface-0)",
				padding: "24px",
			}}
		>
			<div className="flex w-full max-w-md flex-col items-center gap-5 py-8">
				<AlertCircle size={48} className="text-text-tertiary" />
				<h3 className="text-lg font-semibold text-text-primary">
					Disconnected from Cline
				</h3>
				<p className="text-center text-sm text-text-secondary">
					The Kanban runtime is no longer reachable. Recover with either of
					these options:
				</p>
				<div className="flex w-full flex-col gap-3">
					<div className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
						<Terminal size={18} className="mt-0.5 shrink-0 text-text-tertiary" />
						<div className="flex-1">
							<div className="text-sm font-medium text-text-primary">
								Start the runtime from your terminal
							</div>
							<div className="mt-1 text-xs text-text-secondary">
								Run{" "}
								<code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-text-primary">
									cline
								</code>{" "}
								(or{" "}
								<code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-text-primary">
									kanban
								</code>
								) in any terminal, then reload this tab.
							</div>
						</div>
					</div>
					<div className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
						<RefreshCw size={18} className="mt-0.5 shrink-0 text-text-tertiary" />
						<div className="flex-1">
							<div className="text-sm font-medium text-text-primary">
								Restart the Kanban desktop app
							</div>
							<div className="mt-1 text-xs text-text-secondary">
								Quit and relaunch the app to spawn a new runtime automatically.
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
