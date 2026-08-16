/**
 * PiDeck-Q-context-controller
 *
 * 两条命令控制「这些内容要不要进模型上下文」（默认 on = 全部保留）：
 *   /context-tool-content on|off  工具输出
 *   /context-tools on|off         工具调用历史（含输出）
 *
 * 命令语义：on = 保留，off = 去掉。
 * 蕴含：history off ⇒ content 也 off；content on ⇒ history 也 on。
 * 只裁发给模型的历史，不关当前轮工具能力。
 *
 * 必须走 `context` 钩子改写 AgentMessage：
 * pi 内部是 user / assistant({thinking,text,toolCall}) / toolResult。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ContextControllerState {
	clearToolContent: boolean;
	clearToolHistory: boolean;
}

export const DEFAULT_STATE: ContextControllerState = {
	clearToolContent: false,
	clearToolHistory: false,
};

const OMITTED_TOOL_RESULT = "[Tool output omitted]";

export const ENTRY_TYPE = "pi-deck-context-controller";
export const WIDGET_KEY = "pi-deck-context-controller";

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
};

type AgentLikeMessage = {
	role?: string;
	content?: string | ContentBlock[];
	customType?: string;
	toolCallId?: string;
	toolName?: string;
	stopReason?: string;
};

type CustomStateEntry = {
	type?: string;
	customType?: string;
	data?: Partial<ContextControllerState>;
};

/**
 * 正规化两开关，并消化旧版字段。
 * includeTools=false / clearAll=true → 清全部 tools。
 */
export function normalizeState(raw: unknown): ContextControllerState {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
	const typed = raw as Partial<ContextControllerState> & {
		includeTools?: boolean;
		clearAll?: boolean;
	};

	const clearToolHistory =
		typed.clearToolHistory === true || typed.clearAll === true || typed.includeTools === false;
	const clearToolContent = clearToolHistory || typed.clearToolContent === true;
	return { clearToolContent, clearToolHistory };
}

/**
 * 按「是否保留进上下文」改开关。
 * include=false 表示去掉；history 去掉则 content 也去掉；content 恢复则 history 也恢复。
 */
export function applyIncludeSwitch(
	state: ContextControllerState,
	key: keyof ContextControllerState,
	include: boolean,
): ContextControllerState {
	if (key === "clearToolHistory") {
		return include
			? { ...state, clearToolHistory: false }
			: { clearToolContent: true, clearToolHistory: true };
	}
	return include
		? { clearToolContent: false, clearToolHistory: false }
		: { ...state, clearToolContent: true };
}

export function restoreStateFromEntries(
	entries: readonly CustomStateEntry[],
	fallback: ContextControllerState = DEFAULT_STATE,
): ContextControllerState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === ENTRY_TYPE) {
			return normalizeState(entry.data);
		}
	}
	return { ...fallback };
}

/** 只认显式 on/off，不翻转。无法解析时返回 null。 */
export function parseOnOffArg(args: unknown): boolean | null {
	const normalized = String(args ?? "").trim().toLowerCase();
	if (normalized === "on") return true;
	if (normalized === "off") return false;
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function estimateTextTokens(text: string): number {
	if (!text) return 0;
	const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
	return Math.ceil(chineseChars * 1.5 + (text.length - chineseChars) / 3.5);
}

export function estimateMessageTokens(message: AgentLikeMessage): number {
	return estimateTextTokens(JSON.stringify(message ?? {}));
}

function hasVisibleAssistantText(content: string | ContentBlock[] | undefined): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		if (block.type === "text") return String(block.text ?? "").trim().length > 0;
		return false;
	});
}

function stubToolResult(message: AgentLikeMessage): AgentLikeMessage {
	return {
		...message,
		content: [{ type: "text", text: OMITTED_TOOL_RESULT }],
	};
}

function isPassthrough(state: ContextControllerState): boolean {
	return !state.clearToolContent && !state.clearToolHistory;
}

/**
 * 按两开关过滤发给模型的 AgentMessage。
 * - clearToolContent：toolResult 换成占位，保留 toolCall（满足成对协议）
 * - clearToolHistory：丢掉 toolResult + toolCall；只剩思考/无正文的 assistant 整条丢掉
 */
export function filterContextMessages(
	messages: readonly unknown[],
	state: ContextControllerState,
): unknown[] {
	if (isPassthrough(state)) return [...messages];

	const next: unknown[] = [];
	for (const raw of messages) {
		if (!isRecord(raw)) {
			next.push(raw);
			continue;
		}
		const message = raw as AgentLikeMessage;
		if (message.customType === ENTRY_TYPE) continue;

		if (state.clearToolHistory && message.role === "toolResult") continue;

		let rewritten: AgentLikeMessage = { ...message };

		if (state.clearToolHistory && rewritten.role === "assistant" && Array.isArray(rewritten.content)) {
			rewritten = {
				...rewritten,
				content: rewritten.content.filter((block) => !block || block.type !== "toolCall"),
			};
			if (!hasVisibleAssistantText(rewritten.content)) continue;
		} else if (state.clearToolContent && rewritten.role === "toolResult") {
			rewritten = stubToolResult(rewritten);
		}

		next.push(rewritten);
	}
	return next;
}

export function summarizeFilter(
	messages: readonly unknown[],
	state: ContextControllerState,
): { rawTokens: number; filteredTokens: number; savedTokens: number; percentSaved: number } {
	const rawTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message as AgentLikeMessage), 0);
	const filtered = filterContextMessages(messages, state);
	const filteredTokens = filtered.reduce((sum, message) => sum + estimateMessageTokens(message as AgentLikeMessage), 0);
	const savedTokens = Math.max(0, rawTokens - filteredTokens);
	const percentSaved = rawTokens > 0 ? Math.round((savedTokens / rawTokens) * 100) : 0;
	return { rawTokens, filteredTokens, savedTokens, percentSaved };
}

/** 芯片摘要用：1200 → 1.2k，128000 → 128k，1_200_000 → 1.2M */
export function formatCompactTokens(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (value >= 1000) {
		const thousands = value / 1000;
		return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return String(value);
}

export function resolveContextWindow(model: { contextWindow?: number } | undefined): number | undefined {
	const windowSize = model?.contextWindow;
	return typeof windowSize === "number" && Number.isFinite(windowSize) && windowSize > 0
		? windowSize
		: undefined;
}

export type WidgetUsageStats = {
	filteredTokens: number;
	savedTokens: number;
	percentSaved: number;
	contextWindow?: number;
};

function collectSessionMessages(ctx: ExtensionContext): unknown[] {
	try {
		return ctx.sessionManager.getEntries()
			.map((entry) => {
				const typed = entry as { type?: string; message?: unknown; role?: string };
				if (typed?.message) return typed.message;
				if (typed?.role === "user" || typed?.role === "assistant" || typed?.role === "toolResult") {
					return typed;
				}
				return undefined;
			})
			.filter((message): message is unknown => message != null);
	} catch {
		return [];
	}
}

function formatFlag(enabled: boolean): string {
	return enabled ? "ON" : "OFF";
}

export function formatUsageLine(stats: WidgetUsageStats): string {
	const used = formatCompactTokens(stats.filteredTokens);
	if (stats.contextWindow) {
		const percent = Math.min(999, (stats.filteredTokens / stats.contextWindow) * 100);
		return `~${used}/${formatCompactTokens(stats.contextWindow)} ${percent.toFixed(1)}%`;
	}
	return `~${used} tok`;
}

export type ContextControllerStatus = {
	toolContent: "on" | "off";
	toolHistory: "on" | "off";
};

/** 当前对话两档的可读状态，供命令和其它扩展查询。 */
export function getContextControllerStatus(state: ContextControllerState): ContextControllerStatus {
	return {
		toolContent: state.clearToolContent ? "off" : "on",
		toolHistory: state.clearToolHistory ? "off" : "on",
	};
}

export function formatStatusText(status: ContextControllerStatus): string {
	return `tool-content ${status.toolContent} | tool-history ${status.toolHistory}`;
}

export function buildWidgetLines(
	state: ContextControllerState,
	stats?: WidgetUsageStats,
): string[] {
	const lines = [
		stats ? formatUsageLine(stats) : "~0 tok",
		`Tool content ${formatFlag(!state.clearToolContent)}`,
		`Tool history ${formatFlag(!state.clearToolHistory)}`,
	];
	if (stats && stats.savedTokens > 0) {
		lines.push(`Saved ~${formatCompactTokens(stats.savedTokens)} (${stats.percentSaved}%)`);
	}
	return lines;
}

export default function piDeckContextControllerExtension(pi: ExtensionAPI): void {
	// 进程启动先用出厂默认；真正状态以当前会话 entry 为准，避免旧全局 config 串到没快照的聊天。
	let currentState: ContextControllerState = { ...DEFAULT_STATE };

	function persistSessionState(): void {
		// 只写当前会话/分支。不写全局 config：关开关不应污染其它聊天或新会话。
		pi.appendEntry(ENTRY_TYPE, currentState);
	}

	function applyState(next: ContextControllerState, ctx: ExtensionContext): void {
		currentState = normalizeState(next);
		persistSessionState();
		refreshWidget(ctx);
	}

	function refreshWidget(ctx: ExtensionContext): void {
		const stats = summarizeFilter(collectSessionMessages(ctx), currentState);
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(currentState, {
			...stats,
			contextWindow: resolveContextWindow(ctx.model),
		}));
	}

	function reconstructState(ctx: ExtensionContext): void {
		currentState = restoreStateFromEntries(
			ctx.sessionManager.getEntries() as CustomStateEntry[],
			DEFAULT_STATE,
		);
	}

	function applyExplicitSwitch(
		key: keyof ContextControllerState,
		args: unknown,
		ctx: ExtensionContext,
		usage: string,
	): void {
		const include = parseOnOffArg(args);
		if (include == null) {
			ctx.ui.notify(`Usage: ${usage}`, "warning");
			return;
		}
		applyState(applyIncludeSwitch(currentState, key, include), ctx);
	}

	pi.registerCommand("context-tool-content", {
		description: "Keep or drop historical tool outputs in model context. on = keep, off = omit. Requires on|off.",
		handler: async (args, ctx) => {
			applyExplicitSwitch(
				"clearToolContent",
				args,
				ctx,
				"/context-tool-content on|off",
			);
		},
	});

	pi.registerCommand("context-tools", {
		description: "Keep or drop historical tool calls in model context. on = keep, off = drop (also drops outputs). Requires on|off.",
		handler: async (args, ctx) => {
			applyExplicitSwitch(
				"clearToolHistory",
				args,
				ctx,
				"/context-tools on|off",
			);
		},
	});

	pi.registerCommand("context-status", {
		description: "Show whether tool content and tool history are currently in this chat's model context",
		handler: async (_args, ctx) => {
			refreshWidget(ctx);
			ctx.ui.notify(`Context controller: ${formatStatusText(getContextControllerStatus(currentState))}`, "info");
		},
	});

	pi.registerCommand("context-reset", {
		description: "Restore default: keep tool content and tool history in context",
		handler: async (_args, ctx) => {
			applyState(DEFAULT_STATE, ctx);
		},
	});

	pi.on("context", async (event) => {
		if (isPassthrough(currentState)) return;
		return { messages: filterContextMessages(event.messages, currentState) };
	});

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		refreshWidget(ctx);
	});
}
