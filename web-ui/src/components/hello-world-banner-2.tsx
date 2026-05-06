import { Rocket, X } from "lucide-react";
import { useState } from "react";

export function HelloWorldBanner2(): React.ReactElement | null {
	const [dismissed, setDismissed] = useState(false);

	if (dismissed) {
		return null;
	}

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 bg-status-green/10 border-b border-status-green/20 text-sm">
			<Rocket size={14} className="text-status-green shrink-0" />
			<span className="flex-1 text-text-primary font-medium">
				🌍 Hello, World — Part 2! Your agents are ready to build. Create a task to get started.
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
