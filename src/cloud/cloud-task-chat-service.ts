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

	// Returns a snapshot of the task's current session summary, or `null` if
	// this service has never seen the task. Used by the orchestrator to decide
	// whether a `turn_completed` event should finalize the task as succeeded
	// (one-shot flow) or keep the pod alive (multi-turn flow where the user
	// is about to send a follow-up after review).
	getSessionSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const state = this.tasks.get(taskId);
		return state ? { ...state.summary } : null;
	}

	clearTask(taskId: string): void {
		this.tasks.delete(taskId);
	}

	// Append a synthetic "status" role message to a task's transcript and
	// broadcast to subscribers. Used by the orchestrator to surface lifecycle
	// events (provisioning/starting/ready/failed) in the chat panel — cloud
	// tasks have a non-trivial cold-start that local tasks don't, so the user
	// needs visibility that something is happening before the agent responds.
	//
	// Dedupes by text: if the last status message on this task is identical,
	// we skip. Cheap guard against chatter from the state machine emitting the
	// same transition multiple times on retries.
	appendStatus(taskId: string, text: string): void {
		const state = this.ensureTask(taskId);
		const last = state.messages[state.messages.length - 1];
		if (last && last.role === "status" && last.content === text) return;
		this.appendMessage(taskId, this.createMessage(taskId, "status", text));
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
				// `payload.name` is now the canonical tool-display identifier
				// (ACP `kind` preferred, then `title`, then "tool"); see
				// AcpClient.emitToolCall. `title` and `kind` also come through
				// as explicit fields for richer UI if they differ from `name`.
				const name = typeof payload.name === "string" ? payload.name : "tool";
				const title = typeof payload.title === "string" ? payload.title : null;
				const kind = typeof payload.kind === "string" ? payload.kind : null;
				const status = typeof payload.status === "string" ? payload.status : null;
				const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
				const output = typeof payload.output === "string" ? payload.output : null;
				const args = payload.args ?? {};
				// Emit content in the `Tool: X\nInput: Y\nOutput: Z` shape that
				// the web-ui's `parseToolMessageContent` parser expects — it's
				// the same format the local cline agent uses for its chat-log
				// tool messages, so the kanban chat renderer can ingest both
				// local and cloud transcripts through the same codepath. The
				// previous single-line `🛠 name(args)` format caused the
				// parser to hit its "Tool:"-prefix fallback and render the
				// tool as "unknown".
				const lines: string[] = [`Tool: ${name}`];
				const argsText =
					typeof args === "string" ? args : safeStringifyJson(args);
				if (argsText && argsText !== "{}" && argsText !== "null") {
					lines.push("Input:");
					lines.push(argsText);
				}
				if (output) {
					lines.push("Output:");
					lines.push(output);
				}
				const content = lines.join("\n");
				this.finalizeAssistantMessage(taskId);
				// Meta fields are intentionally narrow (see
				// ClineTaskMessage.meta in cline-sdk/cline-session-state.ts):
				// toolName + toolCallId only. The richer ACP fields
				// (title/kind/status) are carried *in* the content string
				// via the Tool:/Input:/Output: prefixes that the web-ui
				// parseToolMessageContent parser already understands — that
				// keeps the message shape identical to what the local cline
				// agent emits, and sidesteps a web-ui-side rendering change
				// just to display the cloud-agent's tool output.
				// `kind`/`status` are intentionally unused here for now;
				// referenced via `void` so the lexical bindings survive
				// to document what's available from the payload.
				void kind;
				void status;
				void title;
				const toolMessage = this.createMessageWithMeta(taskId, "tool", content, {
					toolName: name,
					...(toolCallId ? { toolCallId } : {}),
				});
				// WI-21: dedupe re-emits of the same tool_call.
				//
				// WI-15 (fix "unknown unknown" rendering) made the ACP client
				// re-emit a tool_call on terminal status so the UI can update
				// from "pending" to "completed" with the final output text.
				// Without dedupe that produces two separate tool-use entries
				// in the chat for a single underlying tool invocation — the
				// original pending snapshot, then the completed one below
				// it. Both claim the same toolCallId, so the UI can't even
				// infer they're siblings.
				//
				// The fix mirrors how `appendAssistantChunk` handles streaming
				// text updates: find an existing message with the same
				// meta.toolCallId, replace its content+meta in place, and
				// emit as an update (not an append). The message.id is
				// preserved so subscribers can update rather than append.
				//
				// If no toolCallId is present on the incoming event we can't
				// safely dedupe (no correlation key) and fall through to
				// append — same as the pre-fix behavior for that edge case.
				let replaced = false;
				if (toolCallId) {
					const state = this.ensureTask(taskId);
					const idx = state.messages.findIndex(
						(m) => m.role === "tool" && m.meta?.toolCallId === toolCallId,
					);
					if (idx !== -1) {
						const updated: ClineTaskMessage = {
							...state.messages[idx],
							content,
							meta: toolMessage.meta,
						};
						state.messages[idx] = updated;
						this.emitMessage(taskId, updated);
						replaced = true;
					}
				}
				if (!replaced) {
					this.appendMessage(taskId, toolMessage);
				}

				// Attention-tool hooks fire on every tool_call (including
				// re-emits). This is intentional and idempotent: the summary
				// patch writes the same state+reviewReason each time and
				// just bumps lastHookAt. Firing on the completed re-emit is
				// especially important when the pending emit landed before
				// the user-attention tool had its final output — the
				// terminal emit is the authoritative "this tool finished"
				// moment.
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
				// Why this flips to `awaiting_review` instead of staying in
				// `running`:
				//
				// Over ACP, the cline agent does NOT emit an
				// `attempt_completion` tool_call when it finishes a turn —
				// it just returns a final plain-text assistant message and
				// signals `stopReason: "end_turn"` (or one of max_tokens /
				// refusal / max_turn_requests, all of which mean "I've
				// stopped turning; nothing more is coming until the user
				// does something"). The header comment above listed
				// `attempt_completion` as the canonical task-end signal,
				// but that's only true for the local cline agent; the
				// cloud path has no such tool_call.
				//
				// WI-12 stopped auto-*completing* on end_turn (correct:
				// completing closes the WS and breaks multi-turn chat),
				// but it left the card pinned in `running` forever
				// because nothing else was flipping it. That caused the
				// "stuck IN PROGRESS" symptom the user hit.
				//
				// Flipping to `awaiting_review` is the right intermediate:
				//   - card moves out of In Progress → Review column
				//   - pod stays alive (awaiting_review doesn't close the WS)
				//   - if the user sends a follow-up, sendUserPrompt already
				//     flips back to `running` (canReturnToRunning parity)
				//   - if the user explicitly confirms/archives, the card
				//     goes to Done via the existing review workflow
				//
				// `reviewReason: "attention"` matches the local-cline
				// equivalent of attempt_completion (user must decide:
				// confirm/continue/retry). The board-movement rules in
				// the web-ui don't distinguish between attention from
				// attempt_completion vs attention from turn_completed.
				const currentState = this.getSessionSummary(taskId)?.state;
				if (currentState === "running") {
					this.emitSummaryPatch(taskId, {
						state: "awaiting_review",
						reviewReason: "attention",
						lastHookAt: this.nowFn(),
					});
				}
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
				// `execution_status` is reserved for task-lifecycle signals
				// (provisioning / ready / succeeded / failed / canceled / etc.),
				// each of which must carry a non-empty string `status`. If we
				// see one without it, something upstream is malformed —
				// surfacing a literal "Cloud execution status: unknown" to the
				// user is worse than useless (it confuses non-engineers and
				// hides the bug from engineers). Log-and-drop instead so the
				// break is visible in logs but not the transcript.
				const rawStatus = payload.status;
				if (typeof rawStatus !== "string" || rawStatus.length === 0) {
					console.warn(
						"[cloud-chat] execution_status event missing string `status`, dropping",
						{ taskId, payload },
					);
					return;
				}
				const statusMessage = this.createMessage(
					taskId,
					"status",
					`Cloud execution status: ${rawStatus}`,
				);
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
	// Dedupe: cline streams both incremental partials AND a final consolidated
	// "full turn" chunk. If we naively `+=` we double the assistant reply.
	//   (a) chunk identical to buffer → pure dup, skip
	//   (b) chunk starts with buffer  → cumulative replacement (final arrives
	//       as the entire accumulated text), replace buffer with chunk
	//   (c) buffer ends with chunk    → tail dup from a retransmit, skip
	//   (d) otherwise                 → true incremental, append
	private appendAssistantChunk(taskId: string, chunk: string): void {
		const state = this.ensureTask(taskId);
		if (chunk.length === 0) {
			return;
		}
		if (state.activeAssistantBuffer.length === 0) {
			state.activeAssistantBuffer = chunk;
		} else if (chunk === state.activeAssistantBuffer) {
			return;
		} else if (chunk.startsWith(state.activeAssistantBuffer)) {
			state.activeAssistantBuffer = chunk;
		} else if (state.activeAssistantBuffer.endsWith(chunk)) {
			return;
		} else {
			state.activeAssistantBuffer += chunk;
		}
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

// JSON.stringify that never throws and always returns a printable fallback.
// Used for tool_call `Input:` serialization where we'd rather display
// "[unserializable]" than crash the whole ingest loop on a circular ref or
// a BigInt buried in rawInput.
function safeStringifyJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}
