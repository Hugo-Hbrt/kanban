import { describe, expect, it, vi } from "vitest";

import { CloudTaskChatService } from "./cloud-task-chat-service";

function makeService(sendResults: Array<{ ok: boolean; error?: string }> = [{ ok: true }]) {
	let now = 1000;
	let idCounter = 0;
	const sendCalls: Array<{ taskId: string; type: string; payload: unknown }> = [];
	const service = new CloudTaskChatService({
		sendToTask: (taskId, message) => {
			sendCalls.push({ taskId, type: message.type, payload: message.payload });
			return sendResults.shift() ?? { ok: true };
		},
		now: () => now++,
		randomId: () => `id${++idCounter}`,
	});
	return { service, sendCalls };
}

describe("CloudTaskChatService", () => {
	it("streams agent_message_chunk events into a single coalesced assistant message", () => {
		const { service } = makeService();
		const received: Array<{ id: string; content: string }> = [];
		service.onMessage((_taskId, msg) => {
			if (msg.role === "assistant") received.push({ id: msg.id, content: msg.content });
		});

		service.ingestInboundEvent("task-1", { type: "session_started", payload: { sessionId: "sess-x" } });
		service.ingestInboundEvent("task-1", { type: "agent_message_chunk", payload: { text: "Hello" } });
		service.ingestInboundEvent("task-1", { type: "agent_message_chunk", payload: { text: " world" } });
		service.ingestInboundEvent("task-1", { type: "agent_message_chunk", payload: { text: "!" } });
		service.ingestInboundEvent("task-1", { type: "turn_completed", payload: {} });

		expect(received.length).toBe(3);
		expect(received[0].content).toBe("Hello");
		expect(received[1].content).toBe("Hello world");
		expect(received[2].content).toBe("Hello world!");
		expect(received[0].id).toBe(received[1].id);
		expect(received[1].id).toBe(received[2].id);

		const assistants = service.listMessages("task-1").filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toBe("Hello world!");
	});

	it("starts a fresh assistant message after turn_completed", () => {
		const { service } = makeService();
		service.ingestInboundEvent("task-1", { type: "agent_message_chunk", payload: { text: "turn one" } });
		service.ingestInboundEvent("task-1", { type: "turn_completed", payload: {} });
		service.ingestInboundEvent("task-1", { type: "agent_message_chunk", payload: { text: "turn two" } });
		service.ingestInboundEvent("task-1", { type: "turn_completed", payload: {} });

		const assistants = service.listMessages("task-1").filter((m) => m.role === "assistant");
		expect(assistants.map((m) => m.content)).toEqual(["turn one", "turn two"]);
		expect(assistants[0].id).not.toBe(assistants[1].id);
	});

	it("records user prompt message before forwarding and reports send failure as a status message", () => {
		const { service, sendCalls } = makeService([{ ok: false, error: "not connected" }]);

		const result = service.sendUserPrompt("task-1", "fix the bug");

		expect(result.sendOk).toBe(false);
		expect(result.sendError).toBe("not connected");
		expect(sendCalls).toEqual([
			{ taskId: "task-1", type: "user_prompt", payload: { text: "fix the bug" } },
		]);

		const messages = service.listMessages("task-1");
		expect(messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
			{ role: "user", content: "fix the bug" },
			{ role: "status", content: "Failed to deliver prompt to cloud instance: not connected" },
		]);
	});

	it("emits tool_call events as a tool-role message with toolName meta", () => {
		const { service } = makeService();
		const received: Array<{ role: string; content: string; toolName?: string | null }> = [];
		service.onMessage((_taskId, msg) => {
			received.push({ role: msg.role, content: msg.content, toolName: msg.meta?.toolName ?? null });
		});

		service.ingestInboundEvent("task-1", {
			type: "tool_call",
			payload: { name: "read_file", args: { path: "README.md" } },
		});

		const tool = received.find((m) => m.role === "tool");
		expect(tool).toBeTruthy();
		expect(tool?.toolName).toBe("read_file");
		expect(tool?.content).toContain("read_file");
		expect(tool?.content).toContain("README.md");
	});

	it("isolates messages per task", () => {
		const { service } = makeService();
		service.ingestInboundEvent("task-a", { type: "agent_message_chunk", payload: { text: "A1" } });
		service.ingestInboundEvent("task-b", { type: "agent_message_chunk", payload: { text: "B1" } });
		service.ingestInboundEvent("task-a", { type: "agent_message_chunk", payload: { text: "A2" } });

		const aText = service
			.listMessages("task-a")
			.filter((m) => m.role === "assistant")
			.map((m) => m.content)
			.join("|");
		const bText = service
			.listMessages("task-b")
			.filter((m) => m.role === "assistant")
			.map((m) => m.content)
			.join("|");
		expect(aText).toBe("A1A2");
		expect(bText).toBe("B1");
	});

	it("clearTask forgets a task's transcript without affecting others", () => {
		const { service } = makeService();
		service.ingestInboundEvent("task-a", { type: "agent_message_chunk", payload: { text: "A" } });
		service.ingestInboundEvent("task-b", { type: "agent_message_chunk", payload: { text: "B" } });
		service.clearTask("task-a");
		expect(service.listMessages("task-a")).toEqual([]);
		expect(service.listMessages("task-b")).toHaveLength(1);
	});

	it("listener exceptions never break the fan-out", () => {
		const { service } = makeService();
		const seen: string[] = [];
		service.onMessage(() => {
			throw new Error("rogue listener");
		});
		service.onMessage((_taskId, msg) => {
			seen.push(msg.content);
		});
		expect(() => {
			service.ingestInboundEvent("task-1", { type: "agent_message_chunk", payload: { text: "ok" } });
		}).not.toThrow();
		expect(seen).toEqual(["ok"]);
	});

	it("unknown event types surface as status messages (loud by default)", () => {
		const { service } = makeService();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		service.ingestInboundEvent("task-1", {
			type: "futuristic_unknown_event",
			payload: { q: 42 },
		});
		warnSpy.mockRestore();

		const messages = service.listMessages("task-1");
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("status");
		expect(messages[0].content).toContain("futuristic_unknown_event");
	});
});
