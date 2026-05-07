import type { ReactElement } from "react";

export function HelloWorldPartTwoBanner(): ReactElement {
	return (
		<div
			role="status"
			aria-label="Hello world part 2 banner"
			className="border-b border-border bg-surface-1 px-4 py-2 text-center text-sm font-semibold tracking-wide text-text-primary"
		>
			hello world part 2
		</div>
	);
}
