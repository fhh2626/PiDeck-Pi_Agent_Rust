/**
 * PiDeck-Q-context-controller
 *
 * 控制「历史工具输出要不要进模型上下文」（默认全部保留 + 保留最近 10 条）：
 *   /context-keep <0-99>       保留最近 N 条工具结果原文不裁剪（默认 10）
 *   /context-files on|off      早于最近 N 条的 read 工具文件正文（off 时省略正文）
 *   /context-commands on|off   早于最近 N 条的非 read 工具输出（bash/grep/edit/websearch 等）
 *   /context-tools on|off      控制台高级总闸：off 时丢掉早于最近 N 条的全部工具调用与结果
 *
 * 命令语义：on = 保留，off = 去掉。
 * 滑动窗口保护：无论开关状态如何，从末尾向前数的最近 N 条 toolResult（及对应 toolCall）始终按原文完整提交。
 * 只裁发给模型的历史，不关当前轮工具能力。
 *
 * 必须走 `context` 钩子改写 AgentMessage：
 * pi 内部是 user / assistant({thinking,text,toolCall}) / toolResult。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ContextControllerState {
	clearToolHistory: boolean;
	clearReadContent: boolean;
	clearCommandContent: boolean;
	keepRecentCount: number;
}

export const DEFAULT_STATE: ContextControllerState = {
	clearToolHistory: false,
	clearReadContent: false,
	clearCommandContent: false,
	keepRecentCount: 10,
};

export type ContextSwitchKey = keyof ContextControllerState;

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

type ToolCallInfo = {
	name: string;
	arguments: unknown;
};

export function clampKeepRecent(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 10;
	return Math.max(0, Math.min(99, Math.floor(raw)));
}

/**
 * 正规化上下文控制状态。缺失字段补默认值（全开 + 保留 10 条）。
 */
export function normalizeState(raw: unknown): ContextControllerState {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
	const typed = raw as Partial<ContextControllerState>;
	const clearToolHistory = typed.clearToolHistory === true;
	return {
		clearToolHistory,
		clearReadContent: clearToolHistory || typed.clearReadContent === true,
		clearCommandContent: clearToolHistory || typed.clearCommandContent === true,
		keepRecentCount: clampKeepRecent(typed.keepRecentCount),
	};
}

/**
 * 按「是否保留进上下文」改开关。
 * include=false 表示去掉。
 */
export function applyIncludeSwitch(
	state: ContextControllerState,
	key: ContextSwitchKey,
	include: boolean,
): ContextControllerState {
	if (key === "clearToolHistory") {
		return include
			? { ...state, clearToolHistory: false }
			: { ...state, clearToolHistory: true, clearReadContent: true, clearCommandContent: true };
	}
	if (include) {
		return { ...state, [key]: false, clearToolHistory: false };
	}
	return { ...state, [key]: true };
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

/** 解析数字参数（0-99）。无法解析时返回 null。 */
export function parseKeepRecentArg(args: unknown): number | null {
	const raw = String(args ?? "").trim();
	if (!/^\d+$/.test(raw)) return null;
	const num = Number(raw);
	if (!Number.isFinite(num)) return null;
	return Math.max(0, Math.min(99, Math.floor(num)));
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

function readStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function formatLineRange(record: Record<string, unknown>): string | undefined {
	const offset = record.offset;
	const limit = record.limit;
	if (typeof offset !== "number" || !Number.isFinite(offset)) return undefined;
	const start = Math.max(1, Math.floor(offset));
	if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
		return `lines ${start}-${start + Math.floor(limit) - 1}`;
	}
	return `from line ${start}`;
}

/** 从 toolCall 参数拼 read / bash / web 占位文案。 */
export function formatOmittedToolResult(toolName: string, args: unknown): string {
	const name = toolName.trim().toLowerCase() || "tool";
	const record = isRecord(args) ? args : {};

	if (name === "read") {
		const path = readStringField(record, ["path", "file_path", "filePath"]);
		const range = formatLineRange(record);
		if (path && range) return `[File content omitted: ${path} (${range})]`;
		if (path) return `[File content omitted: ${path}]`;
		return "[File content omitted]";
	}
	if (name === "bash") {
		const command = readStringField(record, ["command", "cmd"]);
		return command ? `[Command output omitted: ${command}]` : "[Command output omitted]";
	}
	if (name === "websearch" || name === "web_search") {
		const query = readStringField(record, ["query", "q", "search"]);
		return query ? `[Web search omitted: "${query}"]` : "[Web search omitted]";
	}
	if (name === "webfetch" || name === "web_fetch") {
		const url = readStringField(record, ["url", "href"]);
		return url ? `[Web fetch omitted: ${url}]` : "[Web fetch omitted]";
	}
	return `[Tool output omitted: ${name}]`;
}

function isReadTool(name: string): boolean {
	return name.trim().toLowerCase() === "read";
}

function collectToolCalls(messages: readonly unknown[]): Map<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	for (const raw of messages) {
		if (!isRecord(raw)) continue;
		const message = raw as AgentLikeMessage;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!block || block.type !== "toolCall") continue;
			const id = typeof block.id === "string" ? block.id : "";
			if (!id) continue;
			calls.set(id, {
				name: typeof block.name === "string" ? block.name : "",
				arguments: block.arguments,
			});
		}
	}
	return calls;
}

function resolveToolInfo(message: AgentLikeMessage, calls: Map<string, ToolCallInfo>): ToolCallInfo {
	const fromCall = message.toolCallId ? calls.get(message.toolCallId) : undefined;
	const name = (typeof message.toolName === "string" && message.toolName
		? message.toolName
		: fromCall?.name) ?? "";
	return { name, arguments: fromCall?.arguments };
}

function stubToolResult(message: AgentLikeMessage, text: string): AgentLikeMessage {
	return {
		...message,
		content: [{ type: "text", text }],
	};
}

export function isPassthrough(state: ContextControllerState): boolean {
	return !state.clearToolHistory && !state.clearReadContent && !state.clearCommandContent;
}

/**
 * 找出按从后向前顺序最近 keepRecentCount 条 toolResult 对应的消息引用及 toolCallId 集合。
 */
function collectProtectedToolItems(
	messages: readonly unknown[],
	keepRecentCount: number,
): { protectedResults: Set<unknown>; protectedCallIds: Set<string> } {
	const protectedResults = new Set<unknown>();
	const protectedCallIds = new Set<string>();
	if (keepRecentCount <= 0) return { protectedResults, protectedCallIds };

	let count = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const raw = messages[i];
		if (!isRecord(raw)) continue;
		const message = raw as AgentLikeMessage;
		if (message.role === "toolResult") {
			protectedResults.add(raw);
			if (typeof message.toolCallId === "string" && message.toolCallId) {
				protectedCallIds.add(message.toolCallId);
			}
			count += 1;
			if (count >= keepRecentCount) break;
		}
	}
	return { protectedResults, protectedCallIds };
}

/**
 * 按三开关与滑动窗口过滤发给模型的 AgentMessage。
 * - 最近 keepRecentCount 条 toolResult 原样保留（含对应 toolCall）
 * - 保护窗口外的旧工具调用按开关裁剪：
 *   - clearToolHistory：丢掉 toolResult + toolCall；无正文的 assistant 丢掉
 *   - clearReadContent：stub read 的 toolResult
 *   - clearCommandContent：stub 非 read 的 toolResult
 */
export function filterContextMessages(
	messages: readonly unknown[],
	state: ContextControllerState,
): unknown[] {
	if (isPassthrough(state)) return [...messages];

	const keepRecentCount = clampKeepRecent(state.keepRecentCount);
	const { protectedResults, protectedCallIds } = collectProtectedToolItems(
		messages,
		keepRecentCount,
	);
	const calls = collectToolCalls(messages);
	const next: unknown[] = [];

	for (const raw of messages) {
		if (!isRecord(raw)) {
			next.push(raw);
			continue;
		}
		const message = raw as AgentLikeMessage;
		if (message.customType === ENTRY_TYPE) continue;

		// 命中保护窗口的 toolResult 直接原样保留
		if (message.role === "toolResult" && protectedResults.has(raw)) {
			next.push(message);
			continue;
		}

		if (state.clearToolHistory && message.role === "toolResult") continue;

		let rewritten: AgentLikeMessage = { ...message };

		if (state.clearToolHistory && rewritten.role === "assistant" && Array.isArray(rewritten.content)) {
			rewritten = {
				...rewritten,
				content: rewritten.content.filter((block) => {
					if (!block || block.type !== "toolCall") return true;
					// 保护窗口内的 toolCall 必须留下，否则对应 toolResult 会变成孤儿
					return typeof block.id === "string" && protectedCallIds.has(block.id);
				}),
			};
			const hasProtectedToolCall = rewritten.content.some((block) => block?.type === "toolCall");
			// 无正文且没有受保护 toolCall 的助手消息才丢掉；纯 toolCall 但在窗口内的要保留
			if (!hasVisibleAssistantText(rewritten.content) && !hasProtectedToolCall) continue;
		} else if (rewritten.role === "toolResult" && !state.clearToolHistory) {
			const info = resolveToolInfo(rewritten, calls);
			const shouldStub = isReadTool(info.name) ? state.clearReadContent : state.clearCommandContent;
			if (shouldStub) {
				rewritten = stubToolResult(rewritten, formatOmittedToolResult(info.name, info.arguments));
			}
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
	toolHistory: "on" | "off";
	fileContent: "on" | "off";
	commandOutput: "on" | "off";
	keepRecent: number;
};

/** 当前对话状态，供命令和其它扩展查询。 */
export function getContextControllerStatus(state: ContextControllerState): ContextControllerStatus {
	return {
		toolHistory: state.clearToolHistory ? "off" : "on",
		fileContent: state.clearReadContent ? "off" : "on",
		commandOutput: state.clearCommandContent ? "off" : "on",
		keepRecent: state.keepRecentCount,
	};
}

export function formatStatusText(status: ContextControllerStatus): string {
	return `keep-recent ${status.keepRecent} | tool-history ${status.toolHistory} | file-content ${status.fileContent} | command-output ${status.commandOutput}`;
}

export function buildWidgetLines(
	state: ContextControllerState,
	stats?: WidgetUsageStats,
): string[] {
	const lines = [
		stats ? formatUsageLine(stats) : "~0 tok",
		`Keep recent ${state.keepRecentCount}`,
		`File content ${formatFlag(!state.clearReadContent)}`,
		`Command output ${formatFlag(!state.clearCommandContent)}`,
	];
	if (stats && stats.savedTokens > 0) {
		lines.push(`Saved ~${formatCompactTokens(stats.savedTokens)} (${stats.percentSaved}%)`);
	}
	return lines;
}

export default function piDeckContextControllerExtension(pi: ExtensionAPI): void {
	let currentState: ContextControllerState = { ...DEFAULT_STATE };

	function persistSessionState(): void {
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
		key: ContextSwitchKey,
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

	pi.registerCommand("context-keep", {
		description: "Number of recent tool results to preserve verbatim in context (0-99). Default 10. Usage: /context-keep <n>",
		handler: async (args, ctx) => {
			const count = parseKeepRecentArg(args);
			if (count == null) {
				ctx.ui.notify("Usage: /context-keep <0-99>", "warning");
				return;
			}
			applyState({ ...currentState, keepRecentCount: count }, ctx);
		},
	});

	pi.registerCommand("context-tools", {
		description: "Keep or drop historical tool calls outside the keep-recent window. on = keep, off = drop. Requires on|off.",
		handler: async (args, ctx) => {
			applyExplicitSwitch("clearToolHistory", args, ctx, "/context-tools on|off");
		},
	});

	pi.registerCommand("context-files", {
		description: "Keep or drop historical read-tool file contents outside the keep-recent window. on = keep, off = omit. Requires on|off.",
		handler: async (args, ctx) => {
			applyExplicitSwitch("clearReadContent", args, ctx, "/context-files on|off");
		},
	});

	pi.registerCommand("context-commands", {
		description: "Keep or drop historical non-read tool outputs outside the keep-recent window. on = keep, off = omit. Requires on|off.",
		handler: async (args, ctx) => {
			applyExplicitSwitch("clearCommandContent", args, ctx, "/context-commands on|off");
		},
	});

	pi.registerCommand("context-status", {
		description: "Show context controller configuration and keep-recent window for this chat",
		handler: async (_args, ctx) => {
			refreshWidget(ctx);
			ctx.ui.notify(`Context controller: ${formatStatusText(getContextControllerStatus(currentState))}`, "info");
		},
	});

	pi.registerCommand("context-reset", {
		description: "Restore default: keep file contents, command outputs and keep-recent 10",
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
