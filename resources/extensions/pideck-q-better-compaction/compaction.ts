import {
	compact,
	type CompactionResult,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import {
	parseContextOverflow,
	recoverOversizedCompaction,
	createPortableSummaryMessage,
	type CompactionAttemptResult,
	type ContextOverflowInfo,
} from "./overflow-recovery";
import {
	computeOversizedRetainedForCompaction,
	estimateMessageTokens,
	type RetainedSummarize,
} from "./retained-oversize";
import { CODEX_PORTABLE_SUMMARY_PROMPT } from "./prompts";
import type { ExtensionConfig } from "./types";

// ---------------------------------------------------------------------------
// Model selection
//
// compactionModel is an OPTIONAL OVERRIDE, not a fallback selector:
// unset / null / unresolvable -> the current chat model (ctx.model).
// ---------------------------------------------------------------------------

export type ParsedModelSpec = {
	provider: string;
	modelId: string;
};

/** Parse "provider/model-id" (model ids may themselves contain slashes). */
export function parseModelSpec(spec: string): ParsedModelSpec | undefined {
	const trimmed = spec.trim();
	const separatorIndex = trimmed.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
		return undefined;
	}

	const provider = trimmed.slice(0, separatorIndex).trim();
	const modelId = trimmed.slice(separatorIndex + 1).trim();
	if (!provider || !modelId) {
		return undefined;
	}

	return { provider, modelId };
}

export type ModelResolution = {
	/** The model that will perform the compaction (ctx.model when nothing is configured). */
	model: Model<Api> | undefined;
	/** The configured spec that produced the selected model, if any. */
	modelSpec?: string;
	/** True when the selected model is not the current chat model. */
	differsFromCurrent: boolean;
	/** Human-readable warning when the configured spec had to be ignored. */
	warning?: string;
};

function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/**
 * Resolve the compaction model: the configured compactionModel when it is set
 * and resolvable, otherwise the current chat model. There is no longer a
 * "same-as-current-model" failure state — selecting the current model is legal.
 */
export function resolveCompactionModel(
	ctx: ExtensionContext,
	config: ExtensionConfig,
): ModelResolution {
	const spec = config.compactionModel?.trim();

	if (!spec) {
		return { model: ctx.model, differsFromCurrent: false };
	}

	const parsed = parseModelSpec(spec);
	if (!parsed) {
		return {
			model: ctx.model,
			modelSpec: spec,
			differsFromCurrent: false,
			warning: `compactionModel "${spec}" is not "provider/model-id"; using the current model`,
		};
	}

	const found = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!found) {
		return {
			model: ctx.model,
			modelSpec: spec,
			differsFromCurrent: false,
			warning: `compactionModel "${spec}" not found in the model registry; using the current model`,
		};
	}

	return { model: found, modelSpec: spec, differsFromCurrent: !sameModel(found, ctx.model) };
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** pi's exported native compact(); injectable for tests. */
export type NativeCompactFn = typeof compact;

type CompactionPreparation = Parameters<NativeCompactFn>[0];

type ResolvedAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
	| { ok: false; error: string };

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Accumulate LLM usage across the summarization calls that produced a recovery
 * segment, so the compaction entry's `usage` still reflects real token/cost spend
 * (pi folds this into session totals). Returns undefined when nothing was added.
 */
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

/** Transient failures worth retrying on the same model. */
export const RETRYABLE_COMPACT_REASONS: readonly string[] = ["timeout", "empty-summary", "compact-failed"];

type AttemptOutcome =
	| { kind: "success"; result: CompactionResult }
	| { kind: "aborted" }
	| {
			kind: "failed";
			reason: "timeout" | "empty-summary" | "context-overflow" | "compact-failed";
			errorMessage?: string;
			timeoutMs?: number;
			overflow?: ContextOverflowInfo;
	  };

async function raceWithUserAbort<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
	if (signal.aborted) return { aborted: true };

	let onAbort: (() => void) | undefined;
	const aborted = new Promise<{ aborted: true }>((resolve) => {
		onAbort = () => resolve({ aborted: true });
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			operation.then((value) => ({ aborted: false as const, value })),
			aborted,
		]);
	} finally {
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

/** Run one compaction call (full preparation or bounded segment) with auth + timeout + user abort. */
async function runCompactOnce(
	args: {
		ctx: ExtensionContext;
		event: SessionBeforeCompactEvent;
		config: ExtensionConfig;
		preparation: CompactionPreparation;
		model: Model<Api>;
		compactFn: NativeCompactFn;
		thinkingLevel: Parameters<NativeCompactFn>[6];
		label: string;
	},
): Promise<AttemptOutcome> {
	const { ctx, event, config, preparation, model, compactFn, thinkingLevel, label } = args;

	let auth: ResolvedAuth;
	try {
		const authRace = await raceWithUserAbort(
			ctx.modelRegistry.getApiKeyAndHeaders(model) as Promise<ResolvedAuth>,
			event.signal,
		);
		if (authRace.aborted) return { kind: "aborted" };
		auth = authRace.value;
	} catch (error) {
		return { kind: "failed", reason: "compact-failed", errorMessage: toErrorMessage(error) };
	}
	if (!auth.ok) return { kind: "failed", reason: "compact-failed", errorMessage: auth.error };

	const timeoutMs = config.compactTimeoutMs ?? 0;
	const controller = new AbortController();
	const onUserAbort = () => controller.abort();
	event.signal.addEventListener("abort", onUserAbort, { once: true });
	let onAttemptAbort: (() => void) | undefined;
	const attemptAbort = new Promise<never>((_resolve, reject) => {
		onAttemptAbort = () => reject(new DOMException(`${label} attempt aborted`, "AbortError"));
		controller.signal.addEventListener("abort", onAttemptAbort, { once: true });
	});
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	if (timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
	}

	try {
		const operation = compactFn(
			preparation,
			model,
			auth.apiKey,
			auth.headers,
			event.customInstructions,
			controller.signal,
			thinkingLevel,
			undefined,
			auth.env,
		);
		const result = await Promise.race([operation, attemptAbort]);
		if (!result.summary?.trim()) {
			return { kind: "failed", reason: "empty-summary", errorMessage: "Pi returned an empty summary" };
		}
		return { kind: "success", result };
	} catch (error) {
		if (event.signal.aborted) return { kind: "aborted" };
		const errorMessage = timedOut ? `${label} timed out after ${timeoutMs}ms` : toErrorMessage(error);
		if (timedOut) return { kind: "failed", reason: "timeout", errorMessage, timeoutMs };
		const overflow = parseContextOverflow(error, errorMessage);
		if (overflow) return { kind: "failed", reason: "context-overflow", errorMessage, overflow };
		// Provider-side AbortError is a retryable attempt failure, not a user cancel.
		return {
			kind: "failed",
			reason: "compact-failed",
			errorMessage: isAbortError(error) ? toErrorMessage(error) : errorMessage,
		};
	} finally {
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
		if (onAttemptAbort) controller.signal.removeEventListener("abort", onAttemptAbort);
		event.signal.removeEventListener("abort", onUserAbort);
	}
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<"ready" | "aborted"> {
	if (signal.aborted) return "aborted";
	if (ms <= 0) return "ready";
	await new Promise<void>((resolve) => {
		const timer = setTimeout(settle, ms);
		function settle() {
			clearTimeout(timer);
			signal.removeEventListener("abort", settle);
			resolve();
		}
		signal.addEventListener("abort", settle, { once: true });
	});
	return signal.aborted ? "aborted" : "ready";
}

/** Build a bounded-segment preparation for overflow recovery / retained reduction. */
function buildSegmentPreparation(
	event: SessionBeforeCompactEvent,
	messages: AgentMessage[],
): CompactionPreparation {
	return {
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: messages.length,
		// A bounded segment summarizes a slice; it does not itself track file ops,
		// so an empty FileOperations is correct (the caller owns the real ones).
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: event.preparation.settings,
	};
}

/** Run Pi's native summarizer for one bounded recovery segment. */
export async function runPiDefaultSegmentCompaction(args: {
	ctx: ExtensionContext;
	event: SessionBeforeCompactEvent;
	config: ExtensionConfig;
	messages: AgentMessage[];
	compactFn?: NativeCompactFn;
	model?: Model<Api>;
}): Promise<CompactionAttemptResult> {
	const { ctx, event, config, messages } = args;
	const model = args.model ?? ctx.model;
	if (!model) return { ok: false, reason: "failed", errorMessage: "current model is unavailable" };
	if (event.signal.aborted) return { ok: false, reason: "aborted" };

	const preparation = buildSegmentPreparation(event, messages);
	const compactFn = args.compactFn ?? compact;

	const maxAttempts = Math.max(1, config.compactMaxAttempts);
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const outcome = await runCompactOnce({
			ctx,
			event,
			config,
			preparation,
			model,
			compactFn,
			thinkingLevel: config.compactionThinkingLevel,
			label: "Pi segment compaction",
		});

		if (outcome.kind === "success") {
			return { ok: true, summary: outcome.result.summary, usage: outcome.result.usage };
		}
		if (outcome.kind === "aborted") return { ok: false, reason: "aborted" };
		if (outcome.kind === "failed" && outcome.reason === "context-overflow") {
			return {
				ok: false,
				reason: "context-overflow",
				errorMessage: outcome.errorMessage,
				overflow: outcome.overflow,
			};
		}
		if (outcome.kind === "failed" && attempt < maxAttempts) {
			const delay = await waitForRetry(config.compactRetryDelayMs, event.signal);
			if (delay === "aborted") return { ok: false, reason: "aborted" };
		} else if (outcome.kind === "failed" && attempt >= maxAttempts) {
			return { ok: false, reason: "failed", errorMessage: outcome.errorMessage ?? "Pi segment compaction failed" };
		}
	}
	return { ok: false, reason: "failed", errorMessage: "Pi segment compaction failed" };
}

/** Recovery input = previous summary (as a portable message) + messagesToSummarize + turnPrefixMessages. */
export function buildRecoveryInputMessages(
	preparation: SessionBeforeCompactEvent["preparation"],
): AgentMessage[] {
	const messagesToSummarize = (preparation.messagesToSummarize ?? []) as AgentMessage[];
	const turnPrefixMessages = (preparation.turnPrefixMessages ?? []) as AgentMessage[];
	const messages = [...messagesToSummarize, ...turnPrefixMessages];
	if (!preparation.previousSummary) return messages;
	return [createPortableSummaryMessage(preparation.previousSummary), ...messages];
}

/** Wrap a produced summary in a CompactionResult anchored on the original preparation. */
export function buildPiCompaction(summary: string, event: SessionBeforeCompactEvent): CompactionResult {
	return {
		summary,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: normalizeCompactionDetails(event.preparation.fileOps),
	};
}

function normalizeCompactionDetails(fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"]): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const value = (fileOps ?? {}) as unknown as {
		read?: Iterable<string>;
		written?: Iterable<string>;
		edited?: Iterable<string>;
		readFiles?: Iterable<string>;
		modifiedFiles?: Iterable<string>;
	};
	const modified = new Set<string>([
		...(value.written ?? []),
		...(value.edited ?? []),
		...(value.modifiedFiles ?? []),
	]);
	return {
		readFiles: [...(value.read ?? value.readFiles ?? [])].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

/** A RetainedSummarize backed by pi's native compact() on the compaction model (provider-agnostic). */
export function createSegmentSummarizer(
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
	config: ExtensionConfig,
	model: Model<Api>,
	compactFn?: NativeCompactFn,
	onUsage?: (usage: Usage) => void,
): RetainedSummarize {
	return async (text, targetTokens, signal) => {
		if (signal.aborted) return undefined;
		try {
			const result = await runPiDefaultSegmentCompaction({
				ctx,
				event,
				config,
				messages: [
					{
						role: "custom",
						customType: "oversize-recovery-chunk",
						content: `${CODEX_PORTABLE_SUMMARY_PROMPT}\n\nReduce the following to a concise, faithful summary (target ~${targetTokens} tokens):\n\n${text}`,
						display: false,
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				],
				compactFn,
				model,
			});
			if (result.ok) {
				if (result.usage) {
					onUsage?.(result.usage);
				}
				const summary = result.summary.trim();
				return summary || undefined;
			}
			return undefined;
		} catch {
			return undefined;
		}
	};
}

/**
 * Run the retained-oversize pass over a completed compaction. Whether the
 * retained set FITS is judged by the current chat model (ctx.model) — that is
 * the model that continues the conversation — but the oversized messages are
 * SUMMARIZED by the compaction model. A reduction failure never undoes a
 * successful compaction.
 */
async function applyRetainedOversizePass(
	compaction: CompactionResult,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	summarizeModel: Model<Api>,
	compactFn?: NativeCompactFn,
): Promise<{ compaction: CompactionResult; reduced: boolean }> {
	// Prefer the branchEntries that came with the event; fall back to the session
	// manager's branch for tests/mocks that only provide one or the other.
	const branchEntries = (
		event.branchEntries ??
		(ctx.sessionManager?.getBranch?.() ?? [])
	) as Array<{
		id: string;
		type: string;
		message?: AgentMessage;
	}>;
	const currentModel = ctx.model;
	let retainedUsage: Usage | undefined;
	const withRetainedUsage = (): CompactionResult => {
		const usage = sumUsage(compaction.usage, retainedUsage);
		return usage ? { ...compaction, usage } : compaction;
	};
	const summarize = createSegmentSummarizer(
		ctx,
		event,
		config,
		summarizeModel,
		compactFn,
		(usage) => {
			retainedUsage = sumUsage(retainedUsage, usage);
		},
	);
	// A reduction failure (including the AbortError that summarizeChunks throws on
	// abort) must never undo an already-successful compaction: fall back to the
	// original compaction instead of propagating the throw out of the handler.
	let computed;
	try {
		computed = await computeOversizedRetainedForCompaction(
			branchEntries,
			compaction.firstKeptEntryId,
			compaction.summary,
			currentModel?.contextWindow ?? 0,
			currentModel?.maxTokens ?? 0,
			event.signal,
			summarize,
		);
	} catch {
		return { compaction: withRetainedUsage(), reduced: false };
	}
	if (!computed) return { compaction: withRetainedUsage(), reduced: false };

	const next: CompactionResult = {
		...withRetainedUsage(),
		summary: compaction.summary + computed.summaryAddition,
		...(computed.firstKeptEntryId ? { firstKeptEntryId: computed.firstKeptEntryId } : {}),
	};
	return { compaction: next, reduced: true };
}

// ---------------------------------------------------------------------------
// The single compaction path for every model
// ---------------------------------------------------------------------------

export type CompactWithRecoveryResult =
	| { kind: "compaction"; compaction: CompactionResult }
	| { kind: "cancel" }
	| { kind: "pi-default" };

export type CompactWithRecoveryDeps = {
	compactFn?: NativeCompactFn;
	onEvent: (data: Record<string, unknown>) => void;
};

/**
 * Normal compaction + overflow recovery, unified for every model:
 *
 * 1. One pass over the FULL original preparation with Pi's native compact().
 *    Transient failures (timeout / empty summary / provider error) are retried
 *    on the same model per compactMaxAttempts + compactRetryDelayMs.
 * 2. Context overflow is deterministic, so it goes straight into
 *    recoverOversizedCompaction(): the input is split into bounded segments,
 *    each summarized by compact(), and the segment summaries are merged
 *    recursively until one final summary fits.
 * 3. On a full failure where the compaction model differs from the current
 *    chat model, one last pass uses the current model (its own context may fit
 *    even though the compaction model's did not).
 *
 * Returns:
 * - { kind: "compaction", compaction } — commit this compaction.
 * - { kind: "cancel" } — the user aborted; pi should stop.
 * - { kind: "pi-default" } — hand off so pi runs its own native compaction
 *   (no model available, or the same model failed with the same input).
 */
export async function compactWithRecovery(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	model: Model<Api> | undefined,
	deps: CompactWithRecoveryDeps,
): Promise<CompactWithRecoveryResult> {
	const compactImpl = deps.compactFn ?? compact;
	const { onEvent } = deps;

	if (event.signal.aborted) return { kind: "cancel" };
	if (!model) {
		onEvent({ outcome: "pi-default", reason: "no-model" });
		return { kind: "pi-default" };
	}

	const maxAttempts = Math.max(1, config.compactMaxAttempts);
	let lastFailure: Extract<AttemptOutcome, { kind: "failed" }> | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const outcome = await runCompactOnce({
			ctx,
			event,
			config,
			preparation: event.preparation,
			model,
			compactFn: compactImpl,
			thinkingLevel: config.compactionThinkingLevel,
			label: "Compaction",
		});

		if (outcome.kind === "success") {
			// Keep pi's full CompactionResult (firstKeptEntryId/details) untouched.
			const retained = await applyRetainedOversizePass(
				outcome.result,
				event,
				ctx,
				config,
				model,
				compactImpl,
			);
			onEvent({
				outcome: "success",
				method: "native",
				model: { provider: model.provider, id: model.id },
				attempt,
				attempts: maxAttempts,
				retainedOversized: retained.reduced,
			});
			return { kind: "compaction", compaction: retained.compaction };
		}

		if (outcome.kind === "aborted") {
			onEvent({ outcome: "aborted", attempt, attempts: maxAttempts });
			return { kind: "cancel" };
		}

		lastFailure = outcome;

		// Context overflow is deterministic: the same input overflows again, so
		// reduce it hierarchically instead of retrying blindly.
		if (outcome.reason === "context-overflow") break;

		if (attempt < maxAttempts && RETRYABLE_COMPACT_REASONS.includes(outcome.reason)) {
			const delay = await waitForRetry(config.compactRetryDelayMs, event.signal);
			if (delay === "aborted") return { kind: "cancel" };
			continue;
		}
		break;
	}

	const finishWithRecovery = async (recoveryModel: Model<Api>, method: string): Promise<CompactWithRecoveryResult> => {
		const recovery = await recoverOversizedCompaction({
			initialOverflow: lastFailure?.overflow,
			messages: buildRecoveryInputMessages(event.preparation),
			attemptCompaction: (messages) =>
				runPiDefaultSegmentCompaction({ ctx, event, config, messages, model: recoveryModel, compactFn: compactImpl }),
			estimateMessageTokens,
			onEvent: (data) => onEvent({ outcome: "oversize-recovery", ...data }),
		});

		if (recovery.ok) {
			const base = {
				...buildPiCompaction(recovery.summaryText, event),
				...(recovery.usage ? { usage: recovery.usage } : {}),
			};
			const retained = await applyRetainedOversizePass(base, event, ctx, config, recoveryModel, compactImpl);
			onEvent({
				outcome: "recovered",
				method,
				model: { provider: recoveryModel.provider, id: recoveryModel.id },
				retainedOversized: retained.reduced,
			});
			return { kind: "compaction", compaction: retained.compaction };
		}
		if (recovery.reason === "aborted" || event.signal.aborted) return { kind: "cancel" };
		return { kind: "pi-default" };
	};

	if (lastFailure?.reason === "context-overflow") {
		return finishWithRecovery(model, "native-recovery");
	}

	// A failed full pass. When the selected model is not the current chat model,
	// one last pass with the current model can still win; a current-model overflow
	// then reduces via bounded segments.
	if (lastFailure && !sameModel(model, ctx.model) && ctx.model) {
		const currentOutcome = await runCompactOnce({
			ctx,
			event,
			config,
			preparation: event.preparation,
			model: ctx.model,
			compactFn: compactImpl,
			thinkingLevel: config.compactionThinkingLevel,
			label: "Current-model compaction",
		});

		if (currentOutcome.kind === "success") {
			const retained = await applyRetainedOversizePass(
				currentOutcome.result,
				event,
				ctx,
				config,
				ctx.model,
				compactImpl,
			);
			onEvent({
				outcome: "success",
				method: "current-model",
				model: { provider: ctx.model.provider, id: ctx.model.id },
				retainedOversized: retained.reduced,
			});
			return { kind: "compaction", compaction: retained.compaction };
		}
		if (currentOutcome.kind === "aborted") return { kind: "cancel" };
		if (currentOutcome.kind === "failed" && currentOutcome.reason === "context-overflow") {
			lastFailure = currentOutcome;
			return finishWithRecovery(ctx.model, "current-model-recovery");
		}
	}

	onEvent({
		outcome: "pi-default",
		reason: lastFailure?.reason ?? "unknown",
		errorMessage: lastFailure?.errorMessage,
		timeoutMs: lastFailure?.timeoutMs,
		model: { provider: model.provider, id: model.id },
	});
	return { kind: "pi-default" };
}
