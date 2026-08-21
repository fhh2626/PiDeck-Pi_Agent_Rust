import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	isContextOverflow,
	type AssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";

export type ContextOverflowInfo = { promptTokens?: number; contextLimit?: number };
export type CompactionAttemptResult =
	| { ok: true; summary: string; usage?: Usage }
	| { ok: false; reason: "context-overflow"; overflow?: ContextOverflowInfo; errorMessage?: string }
	| { ok: false; reason: "aborted" | "failed"; errorMessage?: string };

export type OversizeRecoveryResult =
	| { ok: true; summaryText: string; usage?: Usage }
	| { ok: false; reason: "aborted" | "failed"; errorMessage?: string };

export type OversizeRecoveryOptions = {
	initialOverflow?: ContextOverflowInfo;
	messages: AgentMessage[];
	attemptCompaction: (messages: AgentMessage[]) => Promise<CompactionAttemptResult>;
	estimateMessageTokens: (message: AgentMessage) => number;
	maxReductions?: number;
	safetyRatio?: number;
	onEvent?: (event: Record<string, unknown>) => void;
};

function sumUsage(acc: Usage | undefined, add: Usage | undefined): Usage | undefined {
	if (!add) return acc;
	if (!acc) return add;
	return {
		input: acc.input + add.input,
		output: acc.output + add.output,
		cacheRead: acc.cacheRead + add.cacheRead,
		cacheWrite: acc.cacheWrite + add.cacheWrite,
		...(acc.cacheWrite1h !== undefined || add.cacheWrite1h !== undefined
			? { cacheWrite1h: (acc.cacheWrite1h ?? 0) + (add.cacheWrite1h ?? 0) }
			: {}),
		...(acc.reasoning !== undefined || add.reasoning !== undefined
			? { reasoning: (acc.reasoning ?? 0) + (add.reasoning ?? 0) }
			: {}),
		totalTokens: acc.totalTokens + add.totalTokens,
		cost: {
			input: acc.cost.input + add.cost.input,
			output: acc.cost.output + add.cost.output,
			cacheRead: acc.cost.cacheRead + add.cost.cacheRead,
			cacheWrite: acc.cost.cacheWrite + add.cost.cacheWrite,
			total: acc.cost.total + add.cost.total,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const EXTRA_OVERFLOW_PATTERN =
	/(exceed_context_size|context[_ -]?length[_ -]?exceeded|context size has been exceeded)/i;

const EXTRA_NON_OVERFLOW_PATTERN =
	/^(?:throttl\w*|service[ _-]?unavailable\w*)\b/i;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function normalizeCompactionError(text: string): string {
	let value = text.trim();

	for (let i = 0; i < 4; i++) {
		const next = value
			.replace(
				/^(?:Turn prefix summarization failed|Summarization failed|Error):\s*/i,
				"",
			)
			.trim();

		if (next === value) break;
		value = next;
	}

	return value;
}

function piRecognizesContextOverflow(text: string): boolean {
	const errorMessage = normalizeCompactionError(text);
	if (!errorMessage) return false;

	if (EXTRA_NON_OVERFLOW_PATTERN.test(errorMessage)) {
		return false;
	}

	const probe = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "pi-better-compaction",
		model: "overflow-probe",
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	} satisfies AssistantMessage;

	return isContextOverflow(probe);
}

function matchesContextOverflow(text: string): boolean {
	const normalized = normalizeCompactionError(text);
	if (!normalized) return false;

	if (EXTRA_NON_OVERFLOW_PATTERN.test(normalized)) {
		return false;
	}

	return (
		EXTRA_OVERFLOW_PATTERN.test(normalized) ||
		piRecognizesContextOverflow(normalized)
	);
}

function inspectOverflowValue(value: unknown, seen: Set<unknown>): ContextOverflowInfo | undefined {
	if (value === null || value === undefined || seen.has(value)) return undefined;
	if (typeof value === "string") {
		const text = value.trim();
		if (!text) return undefined;
		try {
			return inspectOverflowValue(JSON.parse(text), seen);
		} catch {
			const objectStart = text.indexOf("{");
			const objectEnd = text.lastIndexOf("}");
			if (objectStart >= 0 && objectEnd > objectStart) {
				try {
					const embedded = inspectOverflowValue(JSON.parse(text.slice(objectStart, objectEnd + 1)), seen);
					if (embedded) return embedded;
				} catch {
					// Fall through to known plain-text overflow patterns.
				}
			}
			if (!matchesContextOverflow(text)) {
				return undefined;
			}
			const counts = text.match(/request\s*\((\d+)\s*tokens\).*?context size\s*\((\d+)\s*tokens\)/i);
			return {
				...(counts?.[1] ? { promptTokens: Number(counts[1]) } : {}),
				...(counts?.[2] ? { contextLimit: Number(counts[2]) } : {}),
			};
		}
	}
	if (typeof value !== "object") return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = inspectOverflowValue(item, seen);
			if (nested) return nested;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	const code = [value.code, value.type, value.error_code].filter((entry) => typeof entry === "string").join(" ");
	const message = typeof value.message === "string" ? value.message : "";

	const isKnownNonOverflowCode = EXTRA_NON_OVERFLOW_PATTERN.test(code);
	const isKnownNonOverflowMessage = EXTRA_NON_OVERFLOW_PATTERN.test(normalizeCompactionError(message));
	if (isKnownNonOverflowCode || isKnownNonOverflowMessage) {
		return undefined;
	}

	const directMatch = matchesContextOverflow(`${code} ${message}`.trim());
	if (directMatch) {
		const promptTokens = positiveNumber(value.n_prompt_tokens ?? value.prompt_tokens);
		const contextLimit = positiveNumber(value.n_ctx ?? value.context_length ?? value.context_limit);
		const fromMessage = inspectOverflowValue(message, seen);
		return {
			...(promptTokens ?? fromMessage?.promptTokens ? { promptTokens: promptTokens ?? fromMessage?.promptTokens } : {}),
			...(contextLimit ?? fromMessage?.contextLimit ? { contextLimit: contextLimit ?? fromMessage?.contextLimit } : {}),
		};
	}
	for (const nestedValue of Object.values(value)) {
		const nested = inspectOverflowValue(nestedValue, seen);
		if (nested) return nested;
	}
	return undefined;
}

export function parseContextOverflow(...values: unknown[]): ContextOverflowInfo | undefined {
	for (const value of values) {
		const result = inspectOverflowValue(value, new Set());
		if (result) return result;
	}
	return undefined;
}

export function createPortableSummaryMessage(summary: string): AgentMessage {
	return { role: "compactionSummary", summary, tokensBefore: 0, timestamp: Date.now() } as AgentMessage;
}

/** Keep assistant tool calls together with their immediately following tool results. */
export function groupPortableMessages(messages: AgentMessage[]): AgentMessage[][] {
	const groups: AgentMessage[][] = [];
	let active: AgentMessage[] | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && active?.[0]?.role === "assistant") {
			active.push(message);
			continue;
		}
		active = [message];
		groups.push(active);
	}
	return groups;
}

function createPortableChunks(group: AgentMessage[], overflow: ContextOverflowInfo): AgentMessage[][] | undefined {
	let text: string;
	try {
		text = JSON.stringify(group);
	} catch {
		return undefined;
	}
	if (!text) return undefined;
	const reportedChars = overflow.contextLimit ? Math.max(4_096, Math.floor(overflow.contextLimit * 4 * 0.45)) : 64_000;
	const chunkChars = Math.max(1, Math.min(reportedChars, Math.ceil(text.length / 2)));
	const count = Math.max(2, Math.ceil(text.length / chunkChars));
	const chunks: AgentMessage[][] = [];
	for (let index = 0; index < count; index++) {
		const content = text.slice(index * chunkChars, (index + 1) * chunkChars);
		if (!content) continue;
		chunks.push([{
			role: "custom",
			customType: "oversize-recovery-chunk",
			content: `[Oversized message group chunk ${index + 1}/${count}]\n${content}`,
			display: false,
			timestamp: Date.now(),
		} as AgentMessage]);
	}
	return chunks.length >= 2 ? chunks : undefined;
}

function flattenGroups(groups: AgentMessage[][]): AgentMessage[] {
	return groups.flatMap((group) => group);
}

function splitForOverflow(
	groups: AgentMessage[][],
	overflow: ContextOverflowInfo,
	options: OversizeRecoveryOptions,
): { prefix: AgentMessage[][]; remainder: AgentMessage[][] } | undefined {
	if (groups.length < 2) return undefined;
	const ratio = Math.min(0.85, Math.max(0.4, options.safetyRatio ?? 0.7));
	const weights = groups.map((group) =>
		Math.max(1, group.reduce((sum, message) => sum + Math.max(1, options.estimateMessageTokens(message)), 0)),
	);
	const estimatedTotal = weights.reduce((sum, weight) => sum + weight, 0);
	const reportedTotal = overflow.promptTokens ?? estimatedTotal;
	const reportedLimit = overflow.contextLimit ?? Math.max(2, Math.floor(reportedTotal * 0.8));
	const target = Math.max(1, Math.floor((reportedLimit * ratio / Math.max(1, reportedTotal)) * estimatedTotal));
	let chosen = 0;
	let accumulated = 0;
	while (chosen < groups.length - 1) {
		const next = weights[chosen]!;
		if (chosen > 0 && accumulated + next > target) break;
		accumulated += next;
		chosen += 1;
	}
	chosen = Math.min(groups.length - 1, Math.max(1, chosen));
	return { prefix: groups.slice(0, chosen), remainder: groups.slice(chosen) };
}

export async function recoverOversizedCompaction(options: OversizeRecoveryOptions): Promise<OversizeRecoveryResult> {
	const maxReductions = Math.max(1, options.maxReductions ?? 64);
	let reductions = 0;
	let usage: Usage | undefined;

	const reduce = async (groups: AgentMessage[][], knownOverflow?: ContextOverflowInfo): Promise<OversizeRecoveryResult> => {
		const messages = flattenGroups(groups);
		let overflow = knownOverflow;

		if (!overflow) {
			const attempt = await options.attemptCompaction(messages);
			options.onEvent?.({
				event: "oversize-recovery.compaction-attempt",
				ok: attempt.ok,
				...(attempt.ok ? {} : { reason: attempt.reason, errorMessage: attempt.errorMessage }),
			});
			if (attempt.ok) {
				usage = sumUsage(usage, attempt.usage);
				return {
					ok: true,
					summaryText: attempt.summary,
					...(usage ? { usage } : {}),
				};
			}
			if (attempt.reason === "aborted") return { ok: false, reason: "aborted" };
			if (attempt.reason !== "context-overflow") {
				return { ok: false, reason: "failed", errorMessage: attempt.errorMessage };
			}
			overflow = attempt.overflow ?? {};
		}

		let splittableGroups = groups;
		let split = splitForOverflow(splittableGroups, overflow, options);
		if (!split && splittableGroups.length === 1) {
			const chunks = createPortableChunks(splittableGroups[0]!, overflow);
			if (chunks) {
				splittableGroups = chunks;
				split = splitForOverflow(splittableGroups, overflow, options);
				options.onEvent?.({ event: "oversize-recovery.portable-chunks", chunks: chunks.length });
			}
		}
		if (!split) return { ok: false, reason: "failed", errorMessage: "oversize recovery reached an unsplittable message group" };
		if (reductions >= maxReductions) {
			return { ok: false, reason: "failed", errorMessage: `oversize recovery exceeded ${maxReductions} reductions` };
		}
		reductions += 1;
		options.onEvent?.({
			event: "oversize-recovery.split",
			reduction: reductions,
			promptTokens: overflow.promptTokens,
			contextLimit: overflow.contextLimit,
			prefixGroups: split.prefix.length,
			remainingGroups: split.remainder.length,
		});
		const prefixResult = await reduce(split.prefix);
		if (!prefixResult.ok) return prefixResult;
		const mergedMessages = [createPortableSummaryMessage(prefixResult.summaryText), ...flattenGroups(split.remainder)];
		return reduce(groupPortableMessages(mergedMessages));
	};

	return reduce(groupPortableMessages(options.messages), options.initialOverflow);
}
