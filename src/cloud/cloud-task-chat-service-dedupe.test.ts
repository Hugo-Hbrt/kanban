import { describe, expect, it } from "vitest";
import { createCloudTaskChatService } from "./cloud-task-chat-service";

function mkService() {
	return createCloudTaskChatService({
		sendToTask: () => ({ ok: true }),
	});
}

function assistantContent(svc: ReturnType<typeof mkService>, taskId: string): string {
	const last = svc.listMessages(taskId).filter((m) => m.role === "assistant").pop();
	return last?.content ?? "";
}

describe("cloud-task-chat-service agent_message_chunk dedupe", () => {
	const TASK = "task-dedupe";

	it("handles true incremental streaming (no overlap)", () => {
		const svc = mkService();
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "Hello " } });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "world." } });
		expect(assistantContent(svc, TASK)).toBe("Hello world.");
	});

	it("dedupes the exact-duplicate finalization chunk (cline pattern)", () => {
		const svc = mkService();
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "I'll create the " } });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "empty text file." } });
		svc.ingestInboundEvent(TASK, {
			type: "agent_message_chunk",
			payload: { text: "I'll create the empty text file." },
		});
		expect(assistantContent(svc, TASK)).toBe("I'll create the empty text file.");
	});

	it("treats cumulative replacement chunks as updates, not appends", () => {
		const svc = mkService();
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "Hello " } });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "Hello world" } });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "Hello world!" } });
		expect(assistantContent(svc, TASK)).toBe("Hello world!");
	});

	it("dedupes a tail retransmit (same chunk seen twice at the end)", () => {
		const svc = mkService();
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "Done." } });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "Done." } });
		expect(assistantContent(svc, TASK)).toBe("Done.");
	});

	it("reproduces the HELLO.md duplicate the user hit — does NOT double-emit the reply", () => {
		const svc = mkService();
		const full =
			"I'm in the main worktree at /workspace on the main branch (commit 10af2439b). There is only one worktree configured. The HELLO.md file was created there.";
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: full } });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: full } });
		expect(assistantContent(svc, TASK)).toBe(full);
	});

	it("ignores empty chunks", () => {
		const svc = mkService();
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "" } });
		expect(svc.listMessages(TASK).filter((m) => m.role === "assistant")).toHaveLength(0);
	});

	it("resets dedupe state after finalization (turn_completed starts a new assistant message)", () => {
		const svc = mkService();
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "first reply" } });
		svc.ingestInboundEvent(TASK, { type: "turn_completed", payload: {} });
		svc.ingestInboundEvent(TASK, { type: "agent_message_chunk", payload: { text: "second reply" } });
		const assistants = svc.listMessages(TASK).filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0]?.content).toBe("first reply");
		expect(assistants[1]?.content).toBe("second reply");
	});
});
