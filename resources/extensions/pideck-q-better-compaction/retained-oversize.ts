import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Retained / current-message oversize recovery (problem 2).
 *
 * Normal compaction only summarizes the OLD history (messagesToSummarize). The
 * "retained" set — everything from firstKeptEntryId onward, most importantly the
 * newest message — is kept raw. If one of those retained messages is itself larger
 * than the context window, compressing older history cannot help: the big message
 * survives into the next request and overflows again.
 *
 * This pass inspects the retained set and, for the retained group(s) that are too
 * big to keep raw, produces a structure-aware, marked, reduced rendering and folds
 * it into the compaction summary. The firstKeptEntryId boundary is advanced past
 * those groups so the originals drop out of LLM context while their reduced form
 * (now part of the summary) takes their place.
 *
 * Everything is expressed through the two levers an extension already owns for a
 * compaction: the summary text and firstKeptEntryId. No session-entry mutation is
 * required; the result is applied atomically during session_before_compact.
 */

export const OVERSIZE_RETAINED_SECTION_HEADING = "Retained oversized messages (reduced)";

/**
 * firstKeptEntryId value used when EVERY retained group was folded into the
 * summary and nothing should be kept raw. It is a stable sentinel that no real
 * session entry matches, so pi's buildContextEntries() includes only the
 * compaction summary (an "empty raw set").
 */
export const ALL_RETAINED_FOLDED_SENTINEL = "pideck:retained-oversize:all-folded";

/** Summarize one piece of text down to roughly targetTokens. Return undefined to fall back to truncation. */
export type RetainedSummarize = (
	text: string,
	targetTokens: number,
	signal: AbortSignal,
) => Promise<string | undefined>;

/** A computed (not yet applied) retained-oversize reduction. */
export type OversizedRetainedComputation = {
	/** Marked text to append to the compaction summary. */
	summaryAddition: string;
	/** New boundary; undefined when the boundary did not move. */
	firstKeptEntryId?: string;
	reducedGroups: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
};

type BranchEntryLike = { id: string; type: string; message?: AgentMessage };

const MAX_MERGE_ROUNDS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUserMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "user" }> {
	return (message as { role?: string }).role === "user";
}

function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
	return (message as { role?: string }).role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "toolResult" }> {
	return (message as { role?: string }).role === "toolResult";
}

export function estimateMessageTokens(message: AgentMessage): number {
	try {
		return Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
	} catch {
		return 1;
	}
}

function estimateTextTokens(text: string): number {
	return Math.max(0, Math.ceil(text.length / 4));
}

function estimateListTokens(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** Render image content as a placeholder so base64 never enters a summarization prompt. */
function imagePlaceholder(block: { mimeType?: string }): string {
	return `[image omitted during oversize recovery: ${block.mimeType ?? "image"}]`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : String(content);
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "image") {
			parts.push(imagePlaceholder(block));
		} else if (isRecord(block) && typeof block.text === "string") {
			parts.push(block.text);
		} else if (isRecord(block) && typeof block.thinking === "string") {
			parts.push(block.thinking);
		} else if (isRecord(block) && block.type === "toolCall") {
			const args = JSON.stringify(block.arguments ?? {}, undefined, 2);
			parts.push(`[tool call ${String(block.name ?? "?")}] ${args ?? ""}`);
		} else if (block != null) {
			try {
				parts.push(JSON.stringify(block));
			} catch {
				parts.push(String(block));
			}
		}
	}
	return parts.join("\n");
}

/** Full text rendering of a message for summarization, preserving tool metadata in words. */
function messageToText(message: AgentMessage): string {
	if (isToolResultMessage(message)) {
		const header = `Tool result for \`${message.toolName}\` (${message.isError ? "error" : "ok"})`;
		return `${header}\n${contentToText(message.content)}`;
	}
	if (isAssistantMessage(message)) return contentToText(message.content);
	if (isUserMessage(message)) return contentToText(message.content);
	try {
		return JSON.stringify(message);
	} catch {
		return String(message);
	}
}

/** Deterministic head/tail truncation used when summarization is unavailable or fails. */
export function truncateHeadTail(text: string, targetChars: number): string {
	const limit = Math.max(1, targetChars);
	if (text.length <= limit) return text;
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n…[oversize recovery omitted ${text.length - limit} characters]…\n${text.slice(text.length - half)}`;
}

function truncateToolArguments(args: Record<string, any>, targetChars: number): Record<string, any> | string {
	let json: string;
	try {
		json = JSON.stringify(args);
	} catch {
		return JSON.stringify(args);
	}
	if (json.length <= targetChars) return args;
	const truncated = truncateHeadTail(json, targetChars);
	try {
		return JSON.parse(truncated) as Record<string, any>;
	} catch {
		return truncated;
	}
}

/**
 * Reduce one piece of text to roughly targetTokens by chunking and merging
 * summaries (hierarchical). Falls back to head/tail truncation when the
 * summarizer is unavailable or keeps failing.
 */
async function summarizeChunks(
	text: string,
	targetTokens: number,
	signal: AbortSignal,
	summarize: RetainedSummarize | undefined,
	maxChunkChars: number,
): Promise<string> {
	if (!summarize) return truncateHeadTail(text, targetTokens * 4);
	let current = text;
	for (let round = 0; round < MAX_MERGE_ROUNDS; round++) {
		if (signal.aborted) throw new DOMException("Oversize recovery aborted", "AbortError");
		if (estimateTextTokens(current) <= targetTokens) return current;
		const chunkChars = Math.max(2_000, maxChunkChars);
		const chunkCount = Math.ceil(current.length / chunkChars);
		if (chunkCount < 2) {
			const once = await summarize(current, targetTokens, signal);
			return once ?? truncateHeadTail(current, targetTokens * 4);
		}
		const pieces: string[] = [];
		for (let i = 0; i < chunkCount; i++) {
			const chunk = current.slice(i * chunkChars, (i + 1) * chunkChars);
			if (!chunk) continue;
			const piece = await summarize(
				`[Oversized retained-message chunk ${i + 1}/${chunkCount} — produce a concise, faithful summary of this fragment]\n${chunk}`,
				targetTokens,
				signal,
			);
			pieces.push(piece ?? truncateHeadTail(chunk, Math.max(1_000, Math.round((targetTokens * 4) / chunkCount))));
		}
		const merged = pieces.map((p, i) => `### Part ${i + 1}\n${p}`).join("\n\n");
		if (estimateTextTokens(merged) <= targetTokens) return merged;
		current = merged;
	}
	return truncateHeadTail(current, targetTokens * 4);
}

type KeptGroup = { entries: BranchEntryLike[]; tokens: number };

/** Group retained entries so an assistant message stays with its following tool results. */
function groupKeptEntries(kept: BranchEntryLike[]): KeptGroup[] {
	const groups: KeptGroup[] = [];
	const startsWithAssistant = (group: KeptGroup): boolean => {
		const first = group.entries[0];
		return !!first && first.type === "message" && (first.message as { role?: string } | undefined)?.role === "assistant";
	};
	for (const entry of kept) {
		const isToolResult = entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "toolResult";
		const active = groups[groups.length - 1];
		if (isToolResult && active && startsWithAssistant(active)) {
			active.entries.push(entry);
		} else {
			groups.push({ entries: [entry], tokens: 0 });
		}
	}
	for (const group of groups) {
		group.tokens = group.entries
			.filter((entry) => entry.type === "message" && entry.message)
			.reduce((sum, entry) => sum + estimateMessageTokens(entry.message!), 0);
	}
	return groups;
}

/** Produce a marked, structure-aware text section for one retained message. */
async function reduceMessageToSection(
	message: AgentMessage,
	targetTokens: number,
	signal: AbortSignal,
	summarize: RetainedSummarize | undefined,
	maxChunkChars: number,
): Promise<string | undefined> {
	if (isToolResultMessage(message)) {
		const text = contentToText(message.content);
		const textBudget = Math.max(16, targetTokens - 48);
		const body =
			estimateTextTokens(text) <= textBudget
				? text
				: await summarizeChunks(text, textBudget, signal, summarize, maxChunkChars);
		const label = `[Retained tool result — reduced] tool=\`${message.toolName}\` · ${message.isError ? "error" : "ok"} · toolCallId=${message.toolCallId}`;
		return `${label}\n${body}`;
	}

	if (isUserMessage(message)) {
		const text = contentToText(message.content);
		// A short message swept into the folded prefix may still contain a
		// critical constraint. Keep it verbatim instead of silently dropping it.
		const textBudget = Math.max(16, targetTokens);
		const body =
			estimateTextTokens(text) <= textBudget
				? text
				: await summarizeChunks(text, textBudget, signal, summarize, maxChunkChars);
		return `[Retained user message — reduced]\n${body}`;
	}

	if (isAssistantMessage(message)) {
		const toolCalls = message.content.filter((block) => block.type === "toolCall");

		// Preserve a real tool call by only shrinking an oversized argument.
		if (toolCalls.length > 0) {
			const argCharCounts = toolCalls.map((call) => {
				try {
					return JSON.stringify(call.arguments ?? {}).length;
				} catch {
					return 0;
				}
			});
			const biggest = argCharCounts.indexOf(Math.max(...argCharCounts));
			if (argCharCounts[biggest]! > 400) {
				const reducedArgs = truncateToolArguments(toolCalls[biggest]!.arguments, Math.max(200, targetTokens * 4));
				const names = toolCalls.map((c) => c.name).join(", ");
				const note = `[Retained assistant message — reduced] tool calls preserved: ${names} (largest argument truncated)`;
				const body = truncateHeadTail(contentToText(message.content), Math.max(400, targetTokens * 4));
				return `${note}\n${body}\n\nLargest tool argument (truncated):\n${JSON.stringify(reducedArgs, undefined, 2)}`;
			}
		}

		const text = messageToText(message);
		const body = await summarizeChunks(text, Math.max(16, targetTokens), signal, summarize, maxChunkChars);
		const extra = toolCalls.length > 0 ? ` (it made tool calls: ${toolCalls.map((c) => c.name).join(", ")}; the full calls are summarized here)` : "";
		return `[Retained assistant message — reduced]${extra}\n${body}`;
	}

	return undefined;
}

/**
 * Compute the retained-oversize reduction for the retained entries.
 *
 * Pure with respect to the session: given the entries from firstKeptEntryId
 * onward and the summary that will accompany them, it decides which retained
 * groups to fold into the summary and how far to move the boundary.
 */
async function computeOversizedRetained(
	branchEntries: BranchEntryLike[],
	firstKept: string,
	contextLimit: number,
	outputTokens: number,
	summary: string,
	signal: AbortSignal,
	summarize?: RetainedSummarize,
): Promise<OversizedRetainedComputation | undefined> {
	const start = branchEntries.findIndex((entry) => entry.id === firstKept);
	if (start < 0) return undefined;
	const kept = branchEntries.slice(start);
	if (contextLimit <= 0) return undefined;

	const keptMessages = kept
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => entry.message as AgentMessage);
	if (keptMessages.length === 0) return undefined;
	const before = estimateListTokens(keptMessages);

	const safety = Math.max(4_096, Math.floor(contextLimit * 0.05));
	const baseBudget = Math.max(0, contextLimit - outputTokens - safety);
	const retainedBudget = Math.max(Math.floor(contextLimit * 0.05), baseBudget - estimateTextTokens(summary));
	if (before <= retainedBudget) return undefined;

	const groups = groupKeptEntries(kept);
	if (groups.length === 0) return undefined;

	// The compaction boundary (firstKeptEntryId) is a single point, so the reduced
	// set must be a contiguous PREFIX of the retained groups (older) and the raw
	// set a contiguous SUFFIX (newer). Fold groups oldest-first until the newer
	// suffix fits the budget: this keeps the newest / current messages raw as much
	// as possible and folds the minimum needed. A group's post-fold size is its
	// reduced text, so folding only shrinks the running total when the reduction
	// actually saves space.
	let keptTokens = groups.reduce((sum, group) => sum + group.tokens, 0);
	const maxChunkChars = Math.max(2_000, Math.floor(contextLimit * 0.25) * 4);
	const perMessageTarget = Math.max(32, Math.floor(retainedBudget / Math.max(1, groups.length)) / 2);

	const orderedSections: string[] = [];
	let cut = 0;
	while (cut < groups.length && keptTokens > retainedBudget) {
		const group = groups[cut]!;
		const sections: string[] = [];
		for (const entry of group.entries) {
			if (entry.type !== "message" || !entry.message) continue;
			const section = await reduceMessageToSection(entry.message, perMessageTarget, signal, summarize, maxChunkChars);
			if (section) sections.push(section);
		}
		const sectionText = sections.join("\n\n");
		keptTokens = keptTokens - group.tokens + estimateTextTokens(sectionText);
		if (sectionText) orderedSections.push(sectionText);
		cut += 1;
	}
	if (cut === 0) return undefined;

	// Folded groups are the oldest "cut" (a prefix); the kept raw groups are the
	// newer suffix starting at groups[cut].
	let additionText = orderedSections.join("\n\n");
	if (estimateTextTokens(additionText) > retainedBudget) {
		additionText = await summarizeChunks(additionText, Math.max(64, Math.floor(retainedBudget / 2)), signal, summarize, maxChunkChars);
	}
	const addition = estimateTextTokens(additionText);
	const reducedGroups = cut;

	// Boundary for the new firstKeptEntryId:
	//  - If some retained groups survive (cut < groups.length), keep them raw and
	//    set the boundary to the first entry of the first unfolded group.
	//  - If EVERY group folded (the "current message is oversized" case), make the
	//    raw set EMPTY: the whole retained history now lives as reduced text in the
	//    summary, so nothing is kept raw. A sentinel firstKeptEntryId that no real
	//    entry matches achieves exactly this in pi's buildContextEntries().
	let newFirst: string;
	if (cut < groups.length) {
		newFirst = groups[cut]!.entries[0]!.id;
	} else {
		newFirst = ALL_RETAINED_FOLDED_SENTINEL;
	}

	const summaryAddition = `\n\n## ${OVERSIZE_RETAINED_SECTION_HEADING}\n\n${additionText}\n\n(These ${reducedGroups} retained message group${reducedGroups === 1 ? "" : "s"} were too large to keep raw, so they were condensed here and removed from the retained history.)`;

	return {
		summaryAddition,
		firstKeptEntryId: newFirst !== firstKept ? newFirst : undefined,
		reducedGroups,
		estimatedTokensBefore: before,
		estimatedTokensAfter: keptTokens,
	};
}

/**
 * Compute a retained-oversize reduction for a completed compaction result.
 */
export async function computeOversizedRetainedForCompaction(
	branchEntries: BranchEntryLike[],
	firstKept: string,
	summary: string,
	contextLimit: number,
	outputTokens: number,
	signal: AbortSignal,
	summarize?: RetainedSummarize,
): Promise<OversizedRetainedComputation | undefined> {
	return computeOversizedRetained(branchEntries, firstKept, contextLimit, outputTokens, summary, signal, summarize);
}
