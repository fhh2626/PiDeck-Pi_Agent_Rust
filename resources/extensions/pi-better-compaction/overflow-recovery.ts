import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NativeCompactionClientResult, PortableCompactionSummaryResult } from "./compact-client";
import type { ResponsesInputItem } from "./serializer";

export type ContextOverflowInfo = {
	promptTokens?: number;
	contextLimit?: number;
};

export type PiSegmentResult =
	| { ok: true; summary: string }
	| { ok: false; reason: "aborted" | "context-overflow" | "failed"; errorMessage?: string; overflow?: ContextOverflowInfo };

export type OversizeRecoveryResult =
	| { ok: true; kind: "native"; compactedWindow: unknown[]; summaryText: string; persistenceSummaryText: string }
	| { ok: true; kind: "pi"; summaryText: string; persistenceSummaryText: string }
	| { ok: false; reason: "aborted" | "failed"; errorMessage?: string };

type RecoveryState = {
	nativePrefix: ResponsesInputItem[];
	portablePrefix: AgentMessage[];
	remainingGroups: AgentMessage[][];
};

export type RecoverySegmentKind = "history" | "turn-prefix" | "merged";

export type ExistingRecoveryCheckpoint = {
	nativePrefix: ResponsesInputItem[];
	portablePrefix: AgentMessage[];
	remainingMessages: AgentMessage[];
};

export type OversizeRecoveryOptions = {
	initialOverflow: ContextOverflowInfo;
	/** Messages covered by Pi's persisted compaction summary. */
	messages: AgentMessage[];
	/** Present when Pi is compacting only the prefix of a split turn. */
	turnPrefixMessages?: AgentMessage[];
	/** Messages Pi keeps verbatim after firstKeptEntryId. */
	remainingMessages?: AgentMessage[];
	/** Existing same-model opaque checkpoint plus its portable equivalent and live tail. */
	existingCheckpoint?: ExistingRecoveryCheckpoint;
	serializeMessages: (messages: AgentMessage[]) => ResponsesInputItem[];
	attemptNative: (input: ResponsesInputItem[]) => Promise<NativeCompactionClientResult>;
	makePortable: (window: readonly unknown[]) => Promise<PortableCompactionSummaryResult>;
	attemptPi: (messages: AgentMessage[], kind: RecoverySegmentKind) => Promise<PiSegmentResult>;
	estimateMessageTokens: (message: AgentMessage) => number;
	maxReductions?: number;
	safetyRatio?: number;
	onEvent?: (event: Record<string, unknown>) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
			if (!/(exceed_context_size|context[_ -]?length[_ -]?exceeded|context size has been exceeded)/i.test(text)) {
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
	const directMatch = /(exceed_context_size|context[_ -]?length[_ -]?exceeded|context size has been exceeded)/i.test(
		`${code} ${message}`,
	);
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

export function getNativeOverflow(result: Extract<NativeCompactionClientResult, { ok: false }>): ContextOverflowInfo | undefined {
	if (result.reason !== "non-2xx" || result.status !== 400) return undefined;
	return parseContextOverflow(result.responseJson, result.responseText, result.errorMessage);
}

export function createPortableSummaryMessage(summary: string): AgentMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore: 0,
		timestamp: Date.now(),
	} as AgentMessage;
}

function createPortableChunks(group: AgentMessage[], overflow: ContextOverflowInfo): AgentMessage[][] | undefined {
	let text: string;
	try {
		text = JSON.stringify(group);
	} catch {
		return undefined;
	}
	if (!text) return undefined;

	// The chunks intentionally become portable user-like messages. Once a single
	// provider item is larger than the context window, preserving its tool-call
	// wire shape is impossible; retaining all of its content is safer than dropping it.
	const reportedChars = overflow.contextLimit ? Math.max(4_096, Math.floor(overflow.contextLimit * 4 * 0.45)) : 64_000;
	const chunkChars = Math.max(1, Math.min(reportedChars, Math.ceil(text.length / 2)));
	const count = Math.max(2, Math.ceil(text.length / chunkChars));
	const chunks: AgentMessage[][] = [];
	for (let index = 0; index < count; index++) {
		const content = text.slice(index * chunkChars, (index + 1) * chunkChars);
		if (!content) continue;
		chunks.push([
			{
				role: "custom",
				customType: "oversize-recovery-chunk",
				content: `[Oversized message group chunk ${index + 1}/${count}]\n${content}`,
				display: false,
				timestamp: Date.now(),
			} as AgentMessage,
		]);
	}
	return chunks.length >= 2 ? chunks : undefined;
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

function jsonTokenWeight(value: unknown): number {
	try {
		return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
	} catch {
		return 1;
	}
}

function splitForOverflow(
	state: RecoveryState,
	overflow: ContextOverflowInfo,
	options: OversizeRecoveryOptions,
): { prefix: RecoveryState; remainder: AgentMessage[][] } | undefined {
	if (state.remainingGroups.length < 2) return undefined;
	const ratio = Math.min(0.85, Math.max(0.4, options.safetyRatio ?? 0.7));
	const nativePrefixWeight = state.nativePrefix.reduce((sum, item) => sum + jsonTokenWeight(item), 0);
	const groupWeights = state.remainingGroups.map((group) =>
		Math.max(1, group.reduce((sum, message) => sum + Math.max(1, options.estimateMessageTokens(message)), 0)),
	);
	const estimatedTotal = nativePrefixWeight + groupWeights.reduce((sum, weight) => sum + weight, 0);
	const reportedTotal = overflow.promptTokens ?? estimatedTotal;
	const reportedLimit = overflow.contextLimit ?? Math.max(2, Math.floor(reportedTotal * 0.8));
	const targetReported = Math.max(1, Math.floor(reportedLimit * ratio));
	const targetEstimated = Math.max(1, Math.floor((targetReported / Math.max(1, reportedTotal)) * estimatedTotal));

	let chosen = 0;
	let accumulated = nativePrefixWeight;
	while (chosen < state.remainingGroups.length - 1) {
		const next = groupWeights[chosen]!;
		if (chosen > 0 && accumulated + next > targetEstimated) break;
		accumulated += next;
		chosen += 1;
	}
	chosen = Math.min(state.remainingGroups.length - 1, Math.max(1, chosen));
	return {
		prefix: {
			nativePrefix: state.nativePrefix,
			portablePrefix: state.portablePrefix,
			remainingGroups: state.remainingGroups.slice(0, chosen),
		},
		remainder: state.remainingGroups.slice(chosen),
	};
}

function flattenGroups(groups: AgentMessage[][]): AgentMessage[] {
	return groups.flatMap((group) => group);
}

export async function recoverOversizedCompaction(options: OversizeRecoveryOptions): Promise<OversizeRecoveryResult> {
	const maxReductions = Math.max(1, options.maxReductions ?? 64);
	let reductions = 0;

	const reduce = async (
		state: RecoveryState,
		knownOverflow?: ContextOverflowInfo,
		kind: RecoverySegmentKind = "history",
	): Promise<OversizeRecoveryResult> => {
		const portableMessages = [...state.portablePrefix, ...flattenGroups(state.remainingGroups)];
		const input = [...state.nativePrefix, ...options.serializeMessages(flattenGroups(state.remainingGroups))];
		let overflow = knownOverflow;
		let nativeResult: NativeCompactionClientResult | undefined;
		if (!overflow) {
			nativeResult = await options.attemptNative(input);
			options.onEvent?.({
				event: "oversize-recovery.native-attempt",
				ok: nativeResult.ok,
				...(nativeResult.ok
					? { compactedItems: nativeResult.compactedWindow.length }
					: { reason: nativeResult.reason, status: nativeResult.status }),
			});
			if (nativeResult.ok) {
				let summaryText = nativeResult.summaryText;
				if (!summaryText) {
					const portable = await options.makePortable(nativeResult.compactedWindow);
					options.onEvent?.({
						event: "oversize-recovery.portable-summary",
						ok: portable.ok,
						...(portable.ok ? {} : { reason: portable.reason, status: portable.status }),
					});
					if (portable.ok) summaryText = portable.summaryText;
					else if (portable.reason === "aborted") return { ok: false, reason: "aborted" };
				}
				if (summaryText) {
					return {
						ok: true,
						kind: "native",
						compactedWindow: nativeResult.compactedWindow,
						summaryText,
						persistenceSummaryText: summaryText,
					};
				}
			} else {
				if (nativeResult.reason === "aborted") return { ok: false, reason: "aborted" };
				overflow = getNativeOverflow(nativeResult);
			}
		}

		let piAttempted = false;
		if (!overflow) {
			piAttempted = true;
			const piResult = await options.attemptPi(portableMessages, kind);
			options.onEvent?.({
				event: "oversize-recovery.pi-fallback",
				ok: piResult.ok,
				...(piResult.ok ? {} : { reason: piResult.reason }),
			});
			if (piResult.ok) {
				return { ok: true, kind: "pi", summaryText: piResult.summary, persistenceSummaryText: piResult.summary };
			}
			if (piResult.reason === "aborted") return { ok: false, reason: "aborted" };
			if (piResult.reason !== "context-overflow") {
				return { ok: false, reason: "failed", errorMessage: piResult.errorMessage };
			}
			overflow = piResult.overflow ?? {};
		}

		let splittableState = state;
		let split = splitForOverflow(splittableState, overflow, options);
		if (!split && !piAttempted) {
			const piResult = await options.attemptPi(portableMessages, kind);
			options.onEvent?.({
				event: "oversize-recovery.pi-fallback",
				ok: piResult.ok,
				...(piResult.ok ? {} : { reason: piResult.reason }),
			});
			if (piResult.ok) return { ok: true, kind: "pi", summaryText: piResult.summary, persistenceSummaryText: piResult.summary };
			if (piResult.reason === "aborted") return { ok: false, reason: "aborted" };
			if (piResult.reason !== "context-overflow") {
				return { ok: false, reason: "failed", errorMessage: piResult.errorMessage };
			}
			overflow = piResult.overflow ?? overflow;
		}
		if (!split && splittableState.remainingGroups.length === 1) {
			const chunks = createPortableChunks(splittableState.remainingGroups[0]!, overflow);
			if (chunks) {
				splittableState = { ...splittableState, remainingGroups: chunks };
				split = splitForOverflow(splittableState, overflow, options);
				options.onEvent?.({ event: "oversize-recovery.portable-chunks", chunks: chunks.length });
			}
		}
		if (!split) {
			return { ok: false, reason: "failed", errorMessage: "oversize recovery reached an unsplittable message group" };
		}
		if (reductions >= maxReductions) {
			return { ok: false, reason: "failed", errorMessage: `oversize recovery exceeded ${maxReductions} reductions` };
		}
		reductions += 1;
		options.onEvent?.({
			event: "oversize-recovery.split",
			reduction: reductions,
			promptTokens: overflow.promptTokens,
			contextLimit: overflow.contextLimit,
			prefixGroups: split.prefix.remainingGroups.length,
			remainingGroups: split.remainder.length,
		});
		const prefixResult = await reduce(split.prefix, undefined, kind);
		if (!prefixResult.ok) return prefixResult;
		const summaryMessage = createPortableSummaryMessage(prefixResult.summaryText);
		const merged: RecoveryState = {
			nativePrefix:
				prefixResult.kind === "native"
					? (prefixResult.compactedWindow as ResponsesInputItem[])
					: options.serializeMessages([summaryMessage]),
			portablePrefix: [summaryMessage],
			remainingGroups: split.remainder,
		};
		return reduce(merged, undefined, kind);
	};

	const toInitialState = (messages: AgentMessage[]): RecoveryState => ({
		nativePrefix: [],
		portablePrefix: [],
		remainingGroups: groupPortableMessages(messages),
	});
	const initialState = toInitialState(options.messages);
	if (options.remainingMessages === undefined) {
		const result = await reduce(initialState, options.initialOverflow);
		return result.ok ? { ...result, persistenceSummaryText: result.summaryText } : result;
	}

	// Pi persists a summary only for the discarded prefix. Reduce that prefix
	// first, then use its dual native/portable checkpoint while compacting the
	// kept suffix. Never persist the final whole-context checkpoint summary.
	let historySummary = "No prior history.";
	let historyResult: OversizeRecoveryResult | undefined;
	if (options.messages.length > 0) {
		historyResult = await reduce(initialState, undefined, "history");
		if (!historyResult.ok) return historyResult;
		historySummary = historyResult.summaryText;
	}

	let persistenceSummary = historySummary;
	if (options.turnPrefixMessages !== undefined) {
		const turnResult = await reduce(toInitialState(options.turnPrefixMessages), undefined, "turn-prefix");
		if (!turnResult.ok) return turnResult;
		persistenceSummary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnResult.summaryText}`;
	}

	const checkpoint = options.existingCheckpoint;
	let mergedState: RecoveryState;
	let mergedKnownOverflow: ContextOverflowInfo | undefined;
	if (checkpoint) {
		mergedState = {
			nativePrefix: checkpoint.nativePrefix,
			portablePrefix: checkpoint.portablePrefix,
			remainingGroups: groupPortableMessages(checkpoint.remainingMessages),
		};
		mergedKnownOverflow = options.initialOverflow;
	} else {
		const prefixSummary = createPortableSummaryMessage(persistenceSummary);
		mergedState = {
			nativePrefix:
				historyResult?.ok && options.turnPrefixMessages === undefined && historyResult.kind === "native"
					? (historyResult.compactedWindow as ResponsesInputItem[])
					: options.serializeMessages([prefixSummary]),
			portablePrefix: [prefixSummary],
			remainingGroups: groupPortableMessages(options.remainingMessages),
		};
	}

	if (mergedState.remainingGroups.length === 0 && !checkpoint && historyResult?.ok && options.turnPrefixMessages === undefined) {
		return { ...historyResult, persistenceSummaryText: persistenceSummary };
	}
	const mergedResult = await reduce(mergedState, mergedKnownOverflow, "merged");
	if (!mergedResult.ok) {
		if (mergedResult.reason === "aborted") return mergedResult;
		return {
			ok: true,
			kind: "pi",
			summaryText: persistenceSummary,
			persistenceSummaryText: persistenceSummary,
		};
	}
	return { ...mergedResult, persistenceSummaryText: persistenceSummary };
}
