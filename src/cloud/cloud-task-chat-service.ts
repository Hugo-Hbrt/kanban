// Chat transcript service for cloud_agent tasks.
//
// Mirrors the slice of ClineTaskSessionService that the chat UI actually
// exercises (onMessage, listMessages, sendTaskSessionInput, clearTaskSession)
// but terminates into an ACP WebSocket handle owned by the cloud execution
// orchestrator instead of a locally spawned Cline process.
//
// State transitions (mirrors cline-event-adapter.ts for local Cline):
//   - User sends prompt → state flips to "running" (if currently awaiting_review,
//     this is the cloud equivalent of canReturnToRunning).
//   - Inbound tool_call with name `attempt_completion` → state flips to
//     "awaiting_review" with reviewReason: "attention" (task done, user reviews).
//   - Inbound tool_call with name `ask_followup_question` or `plan_mode_respond`
//     → state flips to "awaiting_review" with reviewReason: "hook" (needs user).
// Local Cline's event adapter does the same dance; this parity is what makes
// cloud cards auto-move to the Review column identically to local ones.
//
// Design invariants:
//   - This service does NOT own the WebSocket. The orchestrator does. We hold
//     a callback the orchestrator supplies (`sendToTask`) so the orchestrator
//     retains the "which tasks have live pods" knowledge.
//   - Inbound ACP messages are translated to ClineTaskMessage via
//     `ingestInboundEvent`. Translation is deliberately small-surface right now
//     — we handle agent_message_chunk, tool_call, turn_completed,
//     session_started; unknown types become status messages so they're still
//     visible in the UI while we flesh out the real cline-base protocol.
//   - Multi-turn is the whole point: we DO NOT treat turn_completed as a
//     session close. The pod stays alive; we just coalesce the active
//     assistant message.
//
// See: /tmp/kanban-e2e/PLAN-chat-parity.md

import type { ClineTaskMessage } from "../cline-sdk/cline-session-state";
import { isClineUserAttentionTool } from "../cline-sdk/cline-session-state";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";

import type { RuntimeMessage } from "./cloud-runtime-client";

export interface CloudTaskChatServiceSendResult {
	ok: boolean;
	error?: string;
}

export type CloudTaskChatServiceSender = (
	taskId: string,
	message: RuntimeMessage,
) => CloudTaskChatServiceSendResult;

export interface CloudTaskChatServiceOptions {
	sendToTask: CloudTaskChatServiceSender;
	now?: () => number;
	randomId?: () => string;
}

type MessageListener = (taskId: string, message: ClineTaskMessage) => void;
type SummaryListener = (summary: RuntimeTaskSessionSummary) => void;

interface TaskState {
	messages: ClineTaskMessage[];
	activeAssistantMessageId: string | null;
	activeAssistantBuffer: string;
	summary: RuntimeTaskSessionSummary;
}

function defaultRandomId(): string {
	return Math.random().toString(36).slice(2, 10);
}

// "attempt_completion" isn't a user-attention tool in Cline's classification —
// it's the agent declaring "I'm done, here's the result." We still want cloud
// cards to auto-move to Review when it fires (same UX as local), so we
// recognize it explicitly alongside isClineUserAttentionTool.
const CLOUD_COMPLETION_TOOL_NAMES = new Set(["attempt_completion"]);
function isCloudCompletionTool(toolName: string | null): boolean {
	if (!toolName) return false;
	return CLOUD_COMPLETION_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

export class CloudTaskChatService {
	private readonly tasks = new Map<string, TaskState>();
	private readonly listeners = new Set<MessageListener>();
	private readonly summaryListeners = new Set<SummaryListener>();
	private readonly sendToTask: CloudTaskChatServiceSender;
	private readonly nowFn: () => number;
	private readonly randomIdFn: () => string;

	constructor(options: CloudTaskChatServiceOptions) {
		this.sendToTask = options.sendToTask;
		this.nowFn = options.now ?? (() => Date.now());
		this.randomIdFn = options.randomId ?? defaultRandomId;
	}

	onMessage(listener: MessageListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// Subscribe to per-task session summary changes. Mirrors
	// ClineTaskSessionService.onSummary so the runtime state hub can fan these
	// out through the same task_sessions_updated WebSocket path the local
	// Cline service uses. That means the UI's board-movement logic (which
	// watches for state: "awaiting_review" transitions) fires for cloud tasks
	// identically to how it fires for local ones — no UI branching needed.
	onSummary(listener: SummaryListener): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	listMessages(taskId: string): ClineTaskMessage[] {
		return this.ensureTask(taskId).messages.slice();
	}

	clearTask(taskId: string): void {
		this.tasks.delete(taskId);
	}

	// Called by runtime-api when the user submits a prompt for a cloud_agent task.
	// Records the user message locally, then forwards it to the pod as a
	// user_prompt RuntimeMessage. Returns the created ClineTaskMessage regardless
	// of whether the send succeeded — the user should always see their own prompt
	// even if the pod is temporarily unreachable; the pod failure surfaces as
	// a status message.
	//
	// If the task was in awaiting_review (e.g. agent just called
	// attempt_completion or ask_followup_question) and the user replies with a
	// new prompt, flip state back to "running" with reviewReason: null. Mirrors
	// local's canReturnToRunning behavior.
	sendUserPrompt(taskId: string, text: string): { message: ClineTaskMessage; sendOk: boolean; sendError?: string } {
		const userMessage = this.createMessage(taskId, "user", text);
		this.appendMessage(taskId, userMessage);

		const state = this.ensureTask(taskId);
		if (state.summary.state === "awaiting_review") {
			this.emitSummaryPatch(taskId, { state: "running", reviewReason: null });
		} else if (state.summary.state !== "running") {
			this.emitSummaryPatch(taskId, { state: "running" });
		}

		const result = this.sendToTask(taskId, {
			type: "user_prompt",
			payload: { text },
		});

		if (!result.ok) {
			const statusMessage = this.createMessage(
				taskId,
				"status",
				`Failed to deliver prompt to cloud instance: ${result.error ?? "not connected"}`,
			);
			this.appendMessage(taskId, statusMessage);
		}

		return {
			message: userMessage,
			sendOk: result.ok,
			sendError: result.error,
		};
	}

	// Called by the orchestrator for every inbound WebSocket message on a
	// task's ACP connection. Translates to ClineTaskMessage and emits.
	// Tool calls also drive session summary state transitions that match
	// local Cline's cline-event-adapter behavior — see the header block.
	ingestInboundEvent(taskId: string, event: RuntimeMessage): void {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		switch (event.type) {
			case "session_started": {
				const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "(unknown)";
				const statusMessage = this.createMessage(taskId, "status", `Cloud session established (${sessionId}).`);
				this.appendMessage(taskId, statusMessage);
				return;
			}
			case "agent_message_chunk": {
				const chunkText = typeof payload.text === "string" ? payload.text : "";
				if (chunkText.length === 0) return;
				this.appendAssistantChunk(taskId, chunkText);
				return;
			}
			case "tool_call": {
				const name = typeof payload.name === "string" ? payload.name : "tool";
				const args = payload.args ?? {};
				const content = `🛠 ${name}(${JSON.stringify(args)})`;
				this.finalizeAssistantMessage(taskId);
				const toolMessage = this.createMessageWithMeta(taskId, "tool", content, { toolName: name });
				this.appendMessage(taskId, toolMessage);

				if (isCloudCompletionTool(name)) {
					this.emitSummaryPatch(taskId, {
						state: "awaiting_review",
						reviewReason: "attention",
						lastHookAt: this.nowFn(),
					});
				} else if (isClineUserAttentionTool(name)) {
					this.emitSummaryPatch(taskId, {
						state: "awaiting_review",
						reviewReason: "hook",
						lastHookAt: this.nowFn(),
					});
				}
				return;
			}
			case "turn_completed": {
				this.finalizeAssistantMessage(taskId);
				return;
			}
			case "turn_canceled": {
				this.finalizeAssistantMessage(taskId);
				const cancelMessage = this.createMessage(taskId, "status", "Turn canceled.");
				this.appendMessage(taskId, cancelMessage);
				this.emitSummaryPatch(taskId, {
					state: "awaiting_review",
					reviewReason: "interrupted",
				});
				return;
			}
			case "execution_status": {
				const status = typeof payload.status === "string" ? payload.status : "unknown";
				const statusMessage = this.createMessage(taskId, "status", `Cloud execution status: ${status}`);
				this.appendMessage(taskId, statusMessage);
				return;
			}
			default: {
				const statusMessage = this.createMessage(
					taskId,
					"status",
					`Unhandled cloud event: ${event.type} ${JSON.stringify(payload).slice(0, 120)}`,
				);
				this.appendMessage(taskId, statusMessage);
				return;
			}
		}
	}

	// --- internal helpers --------------------------------------------------

	private createInitialSummary(taskId: string): RuntimeTaskSessionSummary {
		const now = this.nowFn();
		return {
			taskId,
			state: "running",
			mode: null,
			agentId: null,
			workspacePath: null,
			pid: null,
			startedAt: now,
			updatedAt: now,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
		};
	}

	private ensureTask(taskId: string): TaskState {
		let state = this.tasks.get(taskId);
		if (!state) {
			state = {
				messages: [],
				activeAssistantMessageId: null,
				activeAssistantBuffer: "",
				summary: this.createInitialSummary(taskId),
			};
			this.tasks.set(taskId, state);
		}
		return state;
	}

	// Merge a partial patch into the task's current summary and fan out to
	// all summary subscribers. `taskId`, `startedAt`, and non-patched fields
	// are preserved; `updatedAt` is refreshed. No-op if the patch is
	// structurally a no-op (same state & reviewReason) — avoids thrashing
	// the UI with redundant updates.
	private emitSummaryPatch(taskId: string, patch: Partial<RuntimeTaskSessionSummary>): void {
		const state = this.ensureTask(taskId);
		const next: RuntimeTaskSessionSummary = {
			...state.summary,
			...patch,
			taskId,
			updatedAt: this.nowFn(),
		};
		const stateUnchanged =
			next.state === state.summary.state && next.reviewReason === state.summary.reviewReason;
		if (stateUnchanged) return;
		state.summary = next;
		for (const listener of this.summaryListeners) {
			try {
				listener(next);
			} catch {
				// Never let a listener break fan-out.
			}
		}
	}

	private createMessage(taskId: string, role: ClineTaskMessage["role"], content: string): ClineTaskMessage {
		return {
			id: `${taskId}-${this.nowFn()}-${this.randomIdFn()}`,
			role,
			content,
			createdAt: this.nowFn(),
		};
	}

	private createMessageWithMeta(
		taskId: string,
		role: ClineTaskMessage["role"],
		content: string,
		meta: NonNullable<ClineTaskMessage["meta"]>,
	): ClineTaskMessage {
		return {
			...this.createMessage(taskId, role, content),
			meta,
		};
	}

	private appendMessage(taskId: string, message: ClineTaskMessage): void {
		const state = this.ensureTask(taskId);
		state.messages.push(message);
		for (const listener of this.listeners) {
			try {
				listener(taskId, message);
			} catch {
				// Never let a listener break fan-out.
			}
		}
	}

	// Streaming assistant chunk handling: we coalesce chunks into a single
	// assistant message per turn, emitting an updated message on every chunk
	// so the UI can re-render in place. The message object is re-created on
	// each chunk (not mutated) so subscribers see immutable snapshots.
	private appendAssistantChunk(taskId: string, chunk: string): void {
		const state = this.ensureTask(taskId);
		state.activeAssistantBuffer += chunk;
		if (state.activeAssistantMessageId === null) {
			const assistant = this.createMessage(taskId, "assistant", state.activeAssistantBuffer);
			state.activeAssistantMessageId = assistant.id;
			state.messages.push(assistant);
			this.emitMessage(taskId, assistant);
			return;
		}
		const idx = state.messages.findIndex((m) => m.id === state.activeAssistantMessageId);
		if (idx === -1) {
			state.activeAssistantMessageId = null;
			return this.appendAssistantChunk(taskId, chunk);
		}
		const updated: ClineTaskMessage = {
			...state.messages[idx],
			content: state.activeAssistantBuffer,
		};
		state.messages[idx] = updated;
		this.emitMessage(taskId, updated);
	}

	private finalizeAssistantMessage(taskId: string): void {
		const state = this.ensureTask(taskId);
		state.activeAssistantMessageId = null;
		state.activeAssistantBuffer = "";
	}

	private emitMessage(taskId: string, message: ClineTaskMessage): void {
		for (const listener of this.listeners) {
			try {
				listener(taskId, message);
			} catch {
				/* never propagate listener failures */
			}
		}
	}
}

export function createCloudTaskChatService(options: CloudTaskChatServiceOptions): CloudTaskChatService {
	return new CloudTaskChatService(options);
}
