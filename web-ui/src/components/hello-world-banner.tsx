import { Sparkles, X } from "lucide-react";
import { useState } from "react";

export function HelloWorldBanner(): React.ReactElement | null {
	const [dismissed, setDismissed] = useState(false);

	if (dismissed) {
		return null;
	}

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 bg-accent/10 border-b border-accent/20 text-sm">
			<Sparkles size={14} className="text-accent shrink-0" />
			<span className="flex-1 text-text-primary font-medium">
				👋 Hello, World! Welcome to Kanban — your AI-powered task board.
			</span>
			<button
				type="button"
				onClick={() => setDismissed(true)}
				className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
				aria-label="Dismiss banner"
			>
				<X size={14} />
			</button>
		</div>
	);
}
