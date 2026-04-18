import { describe, it, expect } from "vitest";
import { CloudTaskChatService } from "../../../src/cloud/cloud-task-chat-service";

describe("repro: /ask → reply → state goes back to running", () => {
	it("emits awaiting_review then running as summaries", () => {
		let now = 1000;
		const svc = new CloudTaskChatService({
			sendToTask: () => ({ ok: true }),
			now: () => now++,
		});

		const summaries: any[] = [];
		svc.onSummary((s) => summaries.push({ state: s.state, reviewReason: s.reviewReason, updatedAt: s.updatedAt }));

		svc.sendUserPrompt("t1", "please do X");
		svc.ingestInboundEvent("t1", {
			type: "tool_call",
			payload: { name: "ask_followup_question", args: { question: "which?" } },
		});
		svc.sendUserPrompt("t1", "the first option");

		console.log("summaries:", JSON.stringify(summaries, null, 2));
		expect(summaries.map((s) => s.state)).toContain("awaiting_review");
		const lastRunning = [...summaries].reverse().find((s) => s.state === "running");
		const lastReview  = [...summaries].reverse().find((s) => s.state === "awaiting_review");
		expect(lastRunning?.updatedAt).toBeGreaterThan(lastReview?.updatedAt);
	});
});
