import {
	compact,
	type CompactionResult,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	parseContextOverflow,
	type PiSegmentResult,
	type RecoverySegmentKind,
} from "./overflow-recovery";
import { MIN_COMPACT_TIMEOUT_MS, type ExtensionConfig } from "./types";

export type ParsedModelSpec = {
	provider: string;
	modelId: string;
};

export type NativeFallbackFailureReason =
	| "no-model-configured"
	| "invalid-model-spec"
	| "model-not-found"
	| "same-as-current-model"
	| "auth-failed"
	| "aborted"
	| "timeout"
	| "empty-summary"
	| "compact-failed";

export type NativeFallbackResult =
	| {
			ok: true;
			result: CompactionResult;
			model: { provider: string; id: string };
	  }
	| {
			ok: false;
			reason: NativeFallbackFailureReason;
			modelSpec?: string;
			errorMessage?: string;
			timeoutMs?: number;
	  };

/** pi's exported native compact(); injectable for tests. */
export type NativeCompactFn = typeof compact;

type CompactionPreparation = Parameters<NativeCompactFn>[0];

type ResolvedAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
	| { ok: false; error: string };

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

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Run Pi's native summarizer with the current model for one bounded recovery segment. */
export async function runPiDefaultSegmentCompaction(args: {
	ctx: ExtensionContext;
	event: SessionBeforeCompactEvent;
	config: ExtensionConfig;
	messages: AgentMessage[];
	kind?: RecoverySegmentKind;
	compactFn?: NativeCompactFn;
}): Promise<PiSegmentResult> {
	const { ctx, event, config, messages, kind = "history" } = args;
	const model = ctx.model;
	if (!model) return { ok: false, reason: "failed", errorMessage: "current model is unavailable" };
	if (event.signal.aborted) return { ok: false, reason: "aborted" };

	let auth: ResolvedAuth;
	try {
		const authRace = await raceWithUserAbort(
			ctx.modelRegistry.getApiKeyAndHeaders(model) as Promise<ResolvedAuth>,
			event.signal,
		);
		if (authRace.aborted) return { ok: false, reason: "aborted" };
		auth = authRace.value;
	} catch (error) {
		return { ok: false, reason: "failed", errorMessage: toErrorMessage(error) };
	}
	if (!auth.ok) return { ok: false, reason: "failed", errorMessage: auth.error };

	const preparation: CompactionPreparation = {
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		messagesToSummarize: kind === "turn-prefix" ? [] : messages,
		turnPrefixMessages: kind === "turn-prefix" ? messages : [],
		isSplitTurn: kind === "turn-prefix",
		tokensBefore: messages.length,
		fileOps: { readFiles: [], modifiedFiles: [] },
		settings: event.preparation.settings,
	};
	const compactFn = args.compactFn ?? compact;
	const maxAttempts = Math.max(1, config.compactMaxAttempts);
	let lastError = "Pi segment compaction failed";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (event.signal.aborted) return { ok: false, reason: "aborted" };
		const controller = new AbortController();
		const onUserAbort = () => controller.abort();
		event.signal.addEventListener("abort", onUserAbort, { once: true });
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (config.compactTimeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, config.compactTimeoutMs);
		}
		let onAttemptAbort: (() => void) | undefined;
		const attemptAbort = new Promise<never>((_resolve, reject) => {
			onAttemptAbort = () => reject(new DOMException("Pi segment compaction attempt aborted", "AbortError"));
			controller.signal.addEventListener("abort", onAttemptAbort, { once: true });
		});

		try {
			const operation = compactFn(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				controller.signal,
				ctx.getThinkingLevel(),
				undefined,
				auth.env,
			);
			const result = await Promise.race([operation, attemptAbort]);
			if (!result.summary?.trim()) {
				lastError = "Pi returned an empty summary";
			} else {
				const summary = normalizeSegmentSummary(result.summary, kind);
				if (summary) return { ok: true, summary };
				lastError = "Pi returned an empty segment summary";
			}
		} catch (error) {
			if (event.signal.aborted) return { ok: false, reason: "aborted" };
			const errorMessage = timedOut
				? `Pi segment compaction timed out after ${config.compactTimeoutMs}ms`
				: toErrorMessage(error);
			const overflow = parseContextOverflow(errorMessage);
			if (overflow) return { ok: false, reason: "context-overflow", errorMessage, overflow };
			// Provider-side AbortError is a retryable attempt failure, not a user cancel.
			lastError = timedOut ? errorMessage : isAbortError(error) ? toErrorMessage(error) : errorMessage;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (onAttemptAbort) controller.signal.removeEventListener("abort", onAttemptAbort);
			event.signal.removeEventListener("abort", onUserAbort);
		}

		if (attempt < maxAttempts) {
			const delay = await waitForSegmentRetry(config.compactRetryDelayMs, event.signal);
			if (delay === "aborted") return { ok: false, reason: "aborted" };
		}
	}
	return { ok: false, reason: "failed", errorMessage: lastError };
}

function normalizeSegmentSummary(summary: string, kind: RecoverySegmentKind): string {
	const trimmed = summary.trim();
	if (kind !== "turn-prefix") return trimmed;
	const marker = "**Turn Context (split turn):**";
	const markerIndex = trimmed.indexOf(marker);
	return markerIndex >= 0 ? trimmed.slice(markerIndex + marker.length).trim() : trimmed;
}

async function waitForSegmentRetry(ms: number, signal: AbortSignal): Promise<"ready" | "aborted"> {
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

/**
 * Run pi's native compaction method with the user-configured compaction model.
 *
 * Only handles the "configured model differs from the current one" case: when no model
 * is configured (or it equals the current model), the caller should return undefined from
 * session_before_compact so pi runs the same native path itself, keeping its internal
 * streamFn/thinkingLevel wiring.
 */
export async function runNativeFallbackCompaction(args: {
	ctx: ExtensionContext;
	event: SessionBeforeCompactEvent;
	config: ExtensionConfig;
	compactFn?: NativeCompactFn;
}): Promise<NativeFallbackResult> {
	const { ctx, event, config } = args;
	const compactFn = args.compactFn ?? compact;

	const spec = config.compactionModel?.trim();
	if (!spec) {
		return { ok: false, reason: "no-model-configured" };
	}

	const parsed = parseModelSpec(spec);
	if (!parsed) {
		return { ok: false, reason: "invalid-model-spec", modelSpec: spec };
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		return { ok: false, reason: "model-not-found", modelSpec: spec };
	}

	if (ctx.model && ctx.model.provider === model.provider && ctx.model.id === model.id) {
		return { ok: false, reason: "same-as-current-model", modelSpec: spec };
	}

	let auth: ResolvedAuth;
	try {
		const authRace = await raceWithUserAbort(
			ctx.modelRegistry.getApiKeyAndHeaders(model) as Promise<ResolvedAuth>,
			event.signal,
		);
		if (authRace.aborted) {
			return { ok: false, reason: "aborted", modelSpec: spec };
		}
		auth = authRace.value;
	} catch (error) {
		return { ok: false, reason: "auth-failed", modelSpec: spec, errorMessage: toErrorMessage(error) };
	}
	if (!auth.ok) {
		return { ok: false, reason: "auth-failed", modelSpec: spec, errorMessage: auth.error };
	}

	const timeoutMs = config.compactTimeoutMs ?? MIN_COMPACT_TIMEOUT_MS;
	const controller = new AbortController();
	const onUserAbort = () => controller.abort();
	event.signal?.addEventListener("abort", onUserAbort);
	let onAttemptAbort: (() => void) | undefined;
	const attemptAbort = new Promise<never>((_resolve, reject) => {
		onAttemptAbort = () => reject(new DOMException("Compaction attempt aborted", "AbortError"));
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
		const compactOperation = compactFn(
			event.preparation,
			model,
			auth.apiKey,
			auth.headers,
			event.customInstructions,
			controller.signal,
			config.compactionThinkingLevel,
			undefined,
			auth.env,
		);
		// compact() should honor its signal, but the race also guarantees this
		// extension attempt settles if a provider implementation ignores it.
		const result = await Promise.race([compactOperation, attemptAbort]);

		if (event.signal?.aborted) {
			return { ok: false, reason: "aborted", modelSpec: spec };
		}
		if (timedOut) {
			return { ok: false, reason: "timeout", modelSpec: spec, timeoutMs };
		}
		if (!result.summary || result.summary.trim().length === 0) {
			return { ok: false, reason: "empty-summary", modelSpec: spec };
		}

		return {
			ok: true,
			result,
			model: { provider: model.provider, id: model.id },
		};
	} catch (error) {
		// Priority mirrors executeNativeCompaction: a genuine user abort wins, then a
		// timer-driven timeout (compact() rejects with an AbortError once we abort its
		// signal), then a plain abort error, then any other failure. Keeping the timeout
		// distinct from an abort lets the caller retry a timeout but stop on a user stop.
		if (event.signal?.aborted) {
			return { ok: false, reason: "aborted", modelSpec: spec };
		}
		if (timedOut) {
			return { ok: false, reason: "timeout", modelSpec: spec, timeoutMs };
		}
		if (isAbortError(error)) {
			return {
				ok: false,
				reason: "compact-failed",
				modelSpec: spec,
				errorMessage: toErrorMessage(error),
			};
		}
		return { ok: false, reason: "compact-failed", modelSpec: spec, errorMessage: toErrorMessage(error) };
	} finally {
		if (timeoutTimer !== undefined) {
			clearTimeout(timeoutTimer);
		}
		if (onAttemptAbort) {
			controller.signal.removeEventListener("abort", onAttemptAbort);
		}
		event.signal?.removeEventListener("abort", onUserAbort);
	}
}
