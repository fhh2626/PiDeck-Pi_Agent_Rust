/**
 * WebEventStream — pi RPC 事件 → AI SDK v5 UIMessageStream SSE 帧 翻译器。
 *
 * 背景：PiDeck Web 服务前端原来是 600ms 轮询 /api/state，回复期间没有任何流式反馈。
 * 本模块把主进程收到的 pi agent 事件（agent_start / message_update / tool_execution_* / agent_end）
 * 翻译成 AI SDK v5 的 UIMessageStream 线协议（data: {json}\n\n 帧 + [DONE] 终止），
 * 后端按该协议输出 SSE，前端可先用 vanilla fetch 消费实现打字机效果（A1），
 * 后续升级 React + useChat 时（A2）协议无需改动，直接复用同一端点。
 *
 * 协议参考：https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 * 需要设置响应头 x-vercel-ai-ui-message-stream: v1 才能被 useChat 识别。
 */

/** AI SDK UIMessageStream 单个 SSE 帧（data: 后的 JSON 对象）。 */
export type UiMessageStreamFrame = Record<string, unknown>;

/** 事件来源 agentId → 目标 sessionId 的路由函数，由装配方注入。 */
export type AgentToSessionRouter = (agentId: string) => string | undefined;

/** SSE 帧写出函数；返回 false 表示连接已失效（对方已断开）。 */
export type SseWriter = (frame: UiMessageStreamFrame) => boolean;

/** 主进程事件源携带的 stream generation；旧 generation 不得结束新连接。 */
export type PiEventSourceHandler = (
	agentId: string,
	event: PiEvent,
	streamGeneration?: number,
) => void;

/** 单个 pi 事件（与 AgentManager.handlePiEvent 收到的结构一致）。 */
export type PiEvent = {
	type?: string;
	// message_start / message_end / message_update 顶层字段
	message?: Record<string, unknown>;
	assistantMessageEvent?: Record<string, unknown>;
	// tool_execution_*
	toolName?: string;
	toolCallId?: string;
	tool_call_id?: string;
	id?: string;
	args?: unknown;
	input?: unknown;
	output?: unknown;
	result?: unknown;
	isError?: boolean;
	// agent_end
	stopReason?: string;
	error?: unknown;
};

/** 事件流翻译器：维护消息级游标（text/reasoning/tool 块是否已开启），逐事件产出帧。 */
export class PiEventToUiMessageStream {
	private textBlockId: string | null = null;
	private reasoningBlockId: string | null = null;
	private hasReasoningDelta = false;
	private currentMessageId: string | null = null;
	private lastPiMessageId: string | null = null;
	private readonly knownToolCallIds = new Set<string>();
	private finished = false;

	/**
	 * 翻译单个 pi 事件为 0..n 个 UIMessageStream 帧。
	 * 返回空数组表示该事件不需要输出（例如 user 消息、无需展示的辅助事件）。
	 */
	push(event: PiEvent): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		const type = event.type;

		// 消息开始：assistant 消息是流式回复的起点，AI SDK 用它开启一条 UI 消息。
		if (type === "message_start") {
			const role = event.message?.role;
			if (role === "assistant") {
				const incomingId = typeof event.message?.id === "string"
					? event.message.id
					: this.currentMessageId ?? `msg_${Date.now()}`;
				if (this.currentMessageId === null) {
					this.currentMessageId = incomingId;
					this.lastPiMessageId = incomingId;
					frames.push({ type: "start", messageId: this.currentMessageId });
				} else if (incomingId !== this.lastPiMessageId) {
					this.lastPiMessageId = incomingId;
					// 一个 agent run 可能包含多个 assistant 段（工具调用前后、自动重试）。
					// AI SDK 的一个 POST 响应应保持一条 UIMessage；新的 pi message
					// 只能作为同一条消息的新 step，否则 useChat 会渲染重复回复。
					frames.push({ type: "start-step" });
				}
			}
			return frames;
		}

		// 顶层 message_end 只结束当前 assistant 消息的块，不能结束整轮 run；
		// 后面仍可能紧跟工具调用、自动重试、压缩或 queued follow-up。
		if (type === "message_end") {
			return this.closeMessageBlocks();
		}

		// 消息更新：文本/思考增量都在 assistantMessageEvent 里。
		if (type === "message_update" && event.assistantMessageEvent) {
			return this.handleAssistantMessageEvent(event.assistantMessageEvent);
		}

		// 工具执行（pi 在 RPC 模式下还会发顶层 tool_execution_start/end）。
		if (type === "tool_execution_start") {
			return this.startTool(event);
		}
		if (type === "tool_execution_end") {
			return this.endTool(event);
		}

		// agent_end 只表示一次底层 run 结束。Pi 仍可能自动重试、压缩或继续队列，
		// 所以这里只关闭当前消息块，必须等 agent_settled 才关闭 SSE。
		if (type === "agent_end") {
			return this.closeMessageBlocks();
		}

		// agent_settled 是 Pi 最终稳定点；部分版本不会把 agent_end 作为外部流的最后事件。
		if (type === "agent_settled") {
			return this.finishMessage(event);
		}

		// 其余事件（agent_start / tool_execution_start 之前的辅助事件等）不直接产生 UI 帧。
		return frames;
	}

	/** 主动结束当前流（连接断开 / 超时兜底时调用）。 */
	finish(): UiMessageStreamFrame[] {
		return this.finishMessage({});
	}

	/** 是否已发出 finish 帧。 */
	isFinished(): boolean {
		return this.finished;
	}

	private handleAssistantMessageEvent(
		ev: Record<string, unknown>,
	): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		const eventType = ev.type;

		// 文本：AI SDK 需要 start/delta/end 三件套；首次 delta 前自动补 text-start。
		if (eventType === "text_start" || eventType === "text_delta" || eventType === "text_end") {
			const delta = String(ev.delta ?? ev.text ?? "");
			if (!this.textBlockId) {
				this.textBlockId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				frames.push({ type: "text-start", id: this.textBlockId });
			}
			if (eventType === "text_delta" && delta) {
				frames.push({ type: "text-delta", id: this.textBlockId, delta });
			}
			if (eventType === "text_end" && this.textBlockId) {
				frames.push({ type: "text-end", id: this.textBlockId });
				this.textBlockId = null;
			}
			return frames;
		}

		// 思考：同样 start/delta/end；thinking_end 可能带完整 content（已含全部增量）。
		if (eventType === "thinking_delta" || eventType === "thinking_end") {
			const delta = String(ev.delta ?? ev.thinking ?? "");
			const finalContent = eventType === "thinking_end"
				? String(ev.content ?? "")
				: "";
			if (!this.reasoningBlockId) {
				this.reasoningBlockId = `reasoning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				frames.push({ type: "reasoning-start", id: this.reasoningBlockId });
			}
			if (eventType === "thinking_delta" && delta) {
				this.hasReasoningDelta = true;
				frames.push({ type: "reasoning-delta", id: this.reasoningBlockId, delta });
			}
			if (eventType === "thinking_end") {
				// 兜底：仅当未收到任何流式 delta 且 content 提供了完整思考内容时补一段 delta，
				// 避免前端空白；已流式过的文本不得再次追加，否则会导致思考内容重复并破坏消息对齐。
				if (finalContent && !this.hasReasoningDelta && !delta) {
					frames.push({ type: "reasoning-delta", id: this.reasoningBlockId, delta: finalContent });
				}
				frames.push({ type: "reasoning-end", id: this.reasoningBlockId });
				this.reasoningBlockId = null;
				this.hasReasoningDelta = false;
			}
			return frames;
		}

		// 工具调用（message_update 路径：toolcall_start / toolcall_end）。
		if (eventType === "toolcall_start") {
			const toolCall = this.readToolCall(ev);
			return toolCall
				? this.ensureToolInput(toolCall.id, toolCall.name, toolCall.input)
				: frames;
		}
		if (eventType === "toolcall_end") {
			const toolCall = this.readToolCall(ev);
			if (!toolCall) return frames;
			frames.push(...this.ensureToolInput(toolCall.id, toolCall.name, toolCall.input));
			frames.push({
				type: "tool-output-available",
				toolCallId: toolCall.id,
				output: toolCall.output,
			});
			return frames;
		}

		// message_update 的 done 事件：当前 assistant 消息完成（对应 thinking 结束），
		// 不是整个 agent run 的终点。
		if (eventType === "done") {
			return this.closeMessageBlocks();
		}

		return frames;
	}

	private startTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolCallId = this.readToolCallId(event) ?? `tool_${toolName}_${Date.now()}`;
		return this.ensureToolInput(toolCallId, toolName, event.args ?? event.input ?? {});
	}

	private endTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolCallId = this.readToolCallId(event);
		if (!toolCallId) return [];
		const frames = this.ensureToolInput(
			toolCallId,
			typeof event.toolName === "string" ? event.toolName : "tool",
			event.args ?? event.input ?? {},
		);
		frames.push({
			type: "tool-output-available",
			toolCallId,
			output: event.isError ? { error: true } : event.result ?? event.output ?? {},
		});
		return frames;
	}

	private readToolCallId(event: PiEvent): string | undefined {
		const value = event.toolCallId ?? event.tool_call_id ?? event.id;
		return typeof value === "string" && value.trim() ? value : undefined;
	}

	private readToolCall(event: Record<string, unknown>): {
		id: string;
		name: string;
		input: unknown;
		output: unknown;
	} | undefined {
		const nested = event.toolCall;
		const toolCall = nested && typeof nested === "object" && !Array.isArray(nested)
			? nested as Record<string, unknown>
			: event;
		const id = toolCall.id ?? toolCall.toolCallId ?? toolCall.tool_call_id;
		if (typeof id !== "string" || !id.trim()) return undefined;
		const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
		return {
			id,
			name,
			input: toolCall.input ?? toolCall.arguments ?? {},
			output: toolCall.output ?? toolCall.result ?? {},
		};
	}

	private ensureToolInput(toolCallId: string, toolName: string, input: unknown): UiMessageStreamFrame[] {
		if (this.knownToolCallIds.has(toolCallId)) return [];
		this.knownToolCallIds.add(toolCallId);
		return [
			{ type: "tool-input-start", toolCallId, toolName },
			{ type: "tool-input-available", toolCallId, toolName, input: input ?? {} },
		];
	}

	private finishMessage(event: PiEvent): UiMessageStreamFrame[] {
		if (this.finished) return [];
		this.finished = true;
		const frames = this.closeMessageBlocks();
		if (event.error !== undefined) {
			const errorText = typeof event.error === "string"
				? event.error
				: "Agent 运行失败";
			frames.push({ type: "error", errorText });
		}
		frames.push({ type: "finish" });
		return frames;
	}

	/** 结束当前消息的开放块，但保留整条 SSE 连接等待下一轮事件。 */
	private closeMessageBlocks(): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		// 关闭尚未闭合的 text/reasoning 块，保证后续工具/重试消息能重新开块。
		if (this.textBlockId) {
			frames.push({ type: "text-end", id: this.textBlockId });
			this.textBlockId = null;
		}
		if (this.reasoningBlockId) {
			frames.push({ type: "reasoning-end", id: this.reasoningBlockId });
			this.reasoningBlockId = null;
			this.hasReasoningDelta = false;
		}
		return frames;
	}
}

/** SSE 协议固定头，useChat 依赖它识别 UIMessageStream。 */
export const UI_MESSAGE_STREAM_HEADER = "x-vercel-ai-ui-message-stream";

/** 把单条 SSE 帧序列化为 wire 格式（data: {json}\n\n）。 */
export function serializeSseFrame(frame: UiMessageStreamFrame): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

/** [DONE] 终止标记。 */
export const SSE_DONE = "data: [DONE]\n\n";

/**
 * 每个 session 一条活跃流的连接状态。
 * 持有翻译器 + 写出函数，连接关闭后标记 dead 并停止写出。
 */
export type SessionStreamEntry = {
	sessionId: string;
	adapter: PiEventToUiMessageStream;
	/** 当前 SSE 连接所属的 agent run；首次 agent_start 到达时可懒绑定。 */
	streamGeneration?: number;
	/** 写出原始 wire 文本（含 data: 前缀）；返回是否成功。 */
	writeRaw: (wire: string) => boolean;
	closed: boolean;
	onClose: () => void;
	onFinish?: () => void;
};

/**
 * WebEventStreamRouter — 管理「sessionId → SSE 连接」并接收全量 pi 事件按 agentId 路由。
 * 用法：
 *   1. subscribe 时创建 entry，写响应头并注册到 sessionStreams
 *   2. 全局只订阅一次 pi 事件源，事件到达后按 agentId→sessionId 路由到对应 entry
 *   3. 连接断开（response close）时 remove，最后一个连接断开时取消全局订阅
 */
export class WebEventStreamRouter {
	private readonly sessionStreams = new Map<string, Set<SessionStreamEntry>>();
	private unsubscribePi: (() => void) | null = null;

	constructor(private readonly resolveSession: AgentToSessionRouter) {}

	/** 检查指定 session 是否有处于活跃连接状态的流。 */
	has(sessionId: string): boolean {
		const set = this.sessionStreams.get(sessionId);
		return Boolean(set && set.size > 0);
	}

	/** 注册一个 session 的 SSE 连接。返回关闭函数。 */
	add(
		sessionId: string,
		writeRaw: (wire: string) => boolean,
		onClose: () => void,
		onFinish?: () => void,
		streamGeneration?: number,
	): () => void {
		const entry: SessionStreamEntry = {
			sessionId,
			adapter: new PiEventToUiMessageStream(),
			streamGeneration,
			writeRaw,
			closed: false,
			onClose,
			onFinish,
		};
		let set = this.sessionStreams.get(sessionId);
		if (!set) {
			set = new Set();
			this.sessionStreams.set(sessionId, set);
		}
		// 一个 session 同时只允许一条 Web 流。多个标签页/重复 prompt 共享同一
		// pi 事件源时，广播会把 A 的 token 混到 B；终止旧连接比静默混流安全。
		// 被替换的旧流属于被中断，绝不能写出伪造的 finish 或 [DONE]。
		for (const previous of [...set]) this.abortEntry(previous, set);
		set.add(entry);

		const close = () => {
			if (entry.closed) return;
			entry.closed = true;
			set?.delete(entry);
			if (set && set.size === 0) this.sessionStreams.delete(sessionId);
			onClose();
		};
		return close;
	}

	/** 供后端绑定：从 pi 事件源订阅全量事件（应只订阅一次）。 */
	bindPiSource(subscribe: ((handler: PiEventSourceHandler) => () => void) | undefined): void {
		this.unsubscribePi?.();
		if (!subscribe) {
			// 装配方未提供订阅器（例如测试/受限环境）：不订阅也不抛错，路由器保持空闲。
			this.unsubscribePi = null;
			return;
		}
		this.unsubscribePi = subscribe((agentId, event, streamGeneration) =>
			this.onPiEvent(agentId, event, streamGeneration));
	}

	/** 解绑 pi 事件源（服务停止时调用）。 */
	unbindPiSource(): void {
		this.unsubscribePi?.();
		this.unsubscribePi = null;
	}

	private onPiEvent(agentId: string, event: PiEvent, streamGeneration?: number): void {
		const sessionId = this.resolveSession(agentId);
		if (!sessionId) return;
		const set = this.sessionStreams.get(sessionId);
		if (!set || set.size === 0) return;

		for (const entry of set) {
			if (entry.closed) continue;
			if (streamGeneration !== undefined) {
				if (entry.streamGeneration === undefined) {
					// 新连接通常先看到 agent_start；旧版/legacy 端点若错过 start，
					// 则用第一条非 settled 事件绑定，不能让旧 settled 抢先结束新流。
					if (event.type === "agent_settled") continue;
					entry.streamGeneration = streamGeneration;
				}
				if (entry.streamGeneration !== streamGeneration) continue;
			}
			const frames = entry.adapter.push(event);
			for (const frame of frames) {
				if (!entry.writeRaw(serializeSseFrame(frame))) {
					// 写出失败（对方断开）：立即标记关闭并触发 onClose 清理，避免持续写已失效的 socket 或挂起 prompt 锁。
					entry.closed = true;
					set.delete(entry);
					entry.onClose();
					break;
				}
				// AI SDK 协议：finish 帧后必须跟 [DONE] 终止标记，前端据此关闭连接。
				if (frame.type === "finish") {
					if (!entry.writeRaw(SSE_DONE)) {
						entry.closed = true;
						set.delete(entry);
						entry.onClose();
						break;
					}
					// [DONE] 是协议终止标记，但 Node response 仍需显式 end，
					// 否则 useChat 可能继续等待 HTTP body 关闭，界面会一直显示运行中。
					entry.closed = true;
					set.delete(entry);
					entry.onFinish?.();
					break;
				}
			}
		}
		if (set.size === 0) this.sessionStreams.delete(sessionId);
	}

	private abortEntry(entry: SessionStreamEntry, set: Set<SessionStreamEntry>): void {
		if (entry.closed) return;
		entry.closed = true;
		set.delete(entry);
		entry.onClose();
	}
}

/** 生成 SSE 响应头。 */
export function writeSseHeaders(
	setHeader: (name: string, value: string) => void,
	writeHead: (status: number, headers: Record<string, string>) => void,
): void {
	writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		[UI_MESSAGE_STREAM_HEADER]: "v1",
	});
	// writeHead 已带 header；setHeader 仅作类型占位兼容，实际不会重复调用。
	void setHeader;
}
