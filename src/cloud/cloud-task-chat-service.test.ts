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

	describe("execution_status handling", () => {
		it("renders well-formed execution_status as a status chat message", () => {
			const { service } = makeService();
			service.ingestInboundEvent("task-1", {
				type: "execution_status",
				payload: { status: "provisioning" },
			});
			const messages = service.listMessages("task-1");
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe("status");
			expect(messages[0].content).toBe("Cloud execution status: provisioning");
		});

		// Regression: before the fix, execution_status events that arrived
		// without a string `status` field silently rendered
		// "Cloud execution status: unknown" to the user. That's confusing to
		// non-engineers (looks like the system is broken) and invisible to
		// engineers (it looks like a first-class status value in the log).
		// Now we log-and-drop.
		it("drops execution_status events with missing/non-string `status` and logs a warning", () => {
			const { service } = makeService();
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			service.ingestInboundEvent("task-1", {
				type: "execution_status",
				payload: {},
			});
			service.ingestInboundEvent("task-1", {
				type: "execution_status",
				payload: { status: 42 },
			});
			service.ingestInboundEvent("task-1", {
				type: "execution_status",
				payload: { status: "" },
			});

			expect(service.listMessages("task-1")).toEqual([]);
			expect(warnSpy).toHaveBeenCalledTimes(3);
			expect(warnSpy).toHaveBeenCalledWith(
				"[cloud-chat] execution_status event missing string `status`, dropping",
				expect.objectContaining({ taskId: "task-1" }),
			);
			warnSpy.mockRestore();
		});
	});

	describe("session summary state transitions (mirrors local Cline awaiting_review flow)", () => {
		it("flips to awaiting_review with reviewReason: attention when agent calls attempt_completion", () => {
			const { service } = makeService();
			const summaries: Array<{ state: string; reviewReason: string | null }> = [];
			service.onSummary((s) => summaries.push({ state: s.state, reviewReason: s.reviewReason }));

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "attempt_completion", args: { result: "done" } },
			});

			expect(summaries).toEqual([{ state: "awaiting_review", reviewReason: "attention" }]);
		});

		it("flips to awaiting_review with reviewReason: hook when agent calls ask_followup_question", () => {
			const { service } = makeService();
			const summaries: Array<{ state: string; reviewReason: string | null }> = [];
			service.onSummary((s) => summaries.push({ state: s.state, reviewReason: s.reviewReason }));

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "ask_followup_question", args: { question: "which approach?" } },
			});

			expect(summaries).toEqual([{ state: "awaiting_review", reviewReason: "hook" }]);
		});

		it("flips to awaiting_review with reviewReason: hook when agent calls plan_mode_respond", () => {
			const { service } = makeService();
			const summaries: Array<{ state: string; reviewReason: string | null }> = [];
			service.onSummary((s) => summaries.push({ state: s.state, reviewReason: s.reviewReason }));

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "plan_mode_respond", args: { response: "here's the plan" } },
			});

			expect(summaries).toEqual([{ state: "awaiting_review", reviewReason: "hook" }]);
		});

		it("does NOT emit a summary patch for ordinary tool calls (e.g. read_file)", () => {
			const { service } = makeService();
			const summaries: Array<{ state: string }> = [];
			service.onSummary((s) => summaries.push({ state: s.state }));

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "read_file", args: { path: "README.md" } },
			});

			expect(summaries).toEqual([]);
		});

		it("user prompt flips awaiting_review back to running (mirrors canReturnToRunning)", () => {
			const { service } = makeService();
			const summaries: Array<{ state: string; reviewReason: string | null }> = [];
			service.onSummary((s) => summaries.push({ state: s.state, reviewReason: s.reviewReason }));

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "attempt_completion", args: { result: "done" } },
			});
			service.sendUserPrompt("task-1", "actually, also do X");

			expect(summaries).toEqual([
				{ state: "awaiting_review", reviewReason: "attention" },
				{ state: "running", reviewReason: null },
			]);
		});

		it("turn_canceled flips to awaiting_review with reviewReason: interrupted", () => {
			const { service } = makeService();
			const summaries: Array<{ state: string; reviewReason: string | null }> = [];
			service.onSummary((s) => summaries.push({ state: s.state, reviewReason: s.reviewReason }));

			service.ingestInboundEvent("task-1", { type: "turn_canceled", payload: {} });

			expect(summaries).toEqual([{ state: "awaiting_review", reviewReason: "interrupted" }]);
		});

		it("appendStatus broadcasts a status-role message and dedupes consecutive identical ones", () => {
			const { service } = makeService();
			const seen: Array<{ role: string; content: string }> = [];
			service.onMessage((_taskId, msg) => seen.push({ role: msg.role, content: msg.content }));

			service.appendStatus("task-1", "⏳ Provisioning cloud sandbox…");
			service.appendStatus("task-1", "⏳ Provisioning cloud sandbox…");
			service.appendStatus("task-1", "✅ Cloud sandbox ready, starting session…");

			expect(seen).toEqual([
				{ role: "status", content: "⏳ Provisioning cloud sandbox…" },
				{ role: "status", content: "✅ Cloud sandbox ready, starting session…" },
			]);
		});

		it("getSessionSummary reflects awaiting_review after attempt_completion (used by orchestrator to keep pods alive)", () => {
			const { service } = makeService();

			expect(service.getSessionSummary("task-1")).toBeNull();

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "attempt_completion", args: { result: "done" } },
			});

			const summary = service.getSessionSummary("task-1");
			expect(summary).not.toBeNull();
			expect(summary?.state).toBe("awaiting_review");
			expect(summary?.reviewReason).toBe("attention");

			// After a user follow-up, the orchestrator must see "running"
			// again so subsequent turn_completed events are free to
			// finalize the task.
			service.sendUserPrompt("task-1", "actually, also do X");
			expect(service.getSessionSummary("task-1")?.state).toBe("running");
		});

		it("getSessionSummary returns an isolated snapshot (mutations don't leak into internal state)", () => {
			const { service } = makeService();
			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "attempt_completion", args: {} },
			});
			const snap = service.getSessionSummary("task-1");
			expect(snap).not.toBeNull();
			// Mutate the snapshot
			(snap as { state: string }).state = "running";
			// Internal state is unaffected
			expect(service.getSessionSummary("task-1")?.state).toBe("awaiting_review");
		});

		it("redundant summary patches do not fan out duplicate events", () => {
			const { service } = makeService();
			const count = { n: 0 };
			service.onSummary(() => {
				count.n += 1;
			});

			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "attempt_completion", args: {} },
			});
			service.ingestInboundEvent("task-1", {
				type: "tool_call",
				payload: { name: "attempt_completion", args: {} },
			});

			expect(count.n).toBe(1);
		});
	});
});
