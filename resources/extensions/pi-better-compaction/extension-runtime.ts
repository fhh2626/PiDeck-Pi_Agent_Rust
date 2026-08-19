import {
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	CODEX_PORTABLE_SUMMARY_PROMPT,
	executeResponsesSummary,
	type ResponsesSummaryResult,
} from "./compact-client";
import { loadExtensionConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import {
	runNativeFallbackCompaction,
	runPiDefaultSegmentCompaction,
	type NativeFallbackResult,
} from "./native-fallback";
import {
	getResponsesOverflow,
	recoverOversizedCompaction,
} from "./overflow-recovery";
import {
	resolveResponsesSummaryEnvironment,
	type ResponsesSummaryRuntime,
} from "./runtime";
import { serializeMessagesToResponsesInput } from "./serializer";
import {
	EXTENSION_ID,
	MIN_COMPACT_TIMEOUT_MS,
	type ExtensionConfig,
} from "./types";

type ResponsesCompactOutcome =
	| { outcome: "success"; compaction: CompactionResult }
	| { outcome: "aborted" }
	| { outcome: "failed" };

function getCurrentModelDebugInfo(ctx: ExtensionContext) {
	return ctx.model
		? {
			provider: ctx.model.provider,
			id: ctx.model.id,
		}
		: undefined;
}

function notifyWarning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${EXTENSION_ID}: ${message}`, "warning");
	}
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "warning"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${EXTENSION_ID}: ${message}`, level);
	}
}

function formatNativeFailure(result: {
	reason: string;
	status?: number;
	errorMessage?: string;
	timeoutMs?: number;
}): string {
	if (result.reason === "timeout") {
		return `timed out after ${Math.round((result.timeoutMs ?? MIN_COMPACT_TIMEOUT_MS) / 1000)}s`;
	}
	if (result.reason === "non-2xx") {
		return `HTTP ${result.status ?? "error"}`;
	}
	if (result.reason === "network-error") {
		return result.errorMessage ?? "network error";
	}
	if (result.errorMessage) {
		return `${result.reason}: ${result.errorMessage}`;
	}
	return result.reason;
}

function isRetryableResponsesSummaryFailure(
	result: Extract<ResponsesSummaryResult, { ok: false }>,
): boolean {
	if (result.reason === "network-error" || result.reason === "timeout") {
		return true;
	}
	if (result.reason !== "non-2xx" || result.status === undefined) {
		return false;
	}
	return result.status === 408 || result.status === 429 || (result.status >= 500 && result.status <= 599);
}

/** Wait up to ms before retrying; resolves early with "aborted" if the user stops. */
async function waitRetryDelay(ms: number, signal: AbortSignal): Promise<"aborted" | "ready"> {
	if (signal.aborted) return "aborted";
	if (ms <= 0) return "ready";
	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const settle = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = (): void => {
			settle();
		};
		timer = setTimeout(settle, ms);
		signal.addEventListener("abort", onAbort, { once: true });
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

function buildCompactionInstructions(customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	if (!guidance) {
		return CODEX_PORTABLE_SUMMARY_PROMPT;
	}

	return `${CODEX_PORTABLE_SUMMARY_PROMPT}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`;
}

async function runResponsesSummary(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	runtime: ResponsesSummaryRuntime,
): Promise<ResponsesCompactOutcome> {
	const prompt = buildCompactionInstructions(event.customInstructions);
	const contextMessages = ctx.sessionManager.buildSessionContext().messages as AgentMessage[];
	const input = serializeMessagesToResponsesInput(runtime.currentModel, contextMessages);

	const maxAttempts = Math.max(1, config.compactMaxAttempts);
	// maxAttempts is always >= 1, so the loop body assigns this on every path.
	let compactResult!: ResponsesSummaryResult;
	let attemptsUsed = 0;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (event.signal.aborted) {
			return { outcome: "aborted" };
		}

		attemptsUsed = attempt;
		compactResult = await executeResponsesSummary({
			runtime,
			input,
			prompt,
			signal: event.signal,
			settings: config,
			context: ctx,
		});

		if (compactResult.ok) {
			break;
		}

		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.responses-summary-failure",
				attempt,
				attempts: maxAttempts,
				reason: compactResult.reason,
				status: compactResult.status,
				errorMessage: compactResult.errorMessage,
				timeoutMs: compactResult.timeoutMs,
			},
			config,
			ctx,
		);

		if (compactResult.reason === "aborted" || event.signal.aborted) {
			return { outcome: "aborted" };
		}

		if (attempt >= maxAttempts || !isRetryableResponsesSummaryFailure(compactResult)) {
			break;
		}

		notify(
			ctx,
			`Responses summary failed (${formatNativeFailure(compactResult)}); retrying (${attempt + 1}/${maxAttempts})…`,
			"warning",
		);
		const delay = await waitRetryDelay(config.compactRetryDelayMs, event.signal);
		if (delay === "aborted") {
			return { outcome: "aborted" };
		}
	}

	if (compactResult.ok === false) {
		const overflow = getResponsesOverflow(compactResult);
		if (overflow) {
			notify(
				ctx,
				`summary input exceeds the provider context${overflow.promptTokens && overflow.contextLimit ? ` (${overflow.promptTokens}/${overflow.contextLimit} tokens)` : ""}; reducing it in bounded segments…`,
				"warning",
			);
			const recovery = await recoverOversizedCompaction({
				initialOverflow: overflow,
				messages: contextMessages,
				serializeMessages: (messages) => serializeMessagesToResponsesInput(runtime.currentModel, messages),
				attemptSummary: async (segmentInput) => {
					let result: ResponsesSummaryResult = {
						ok: false,
						reason: "network-error",
						errorMessage: "summary recovery was not attempted",
					};
					for (let attempt = 1; attempt <= maxAttempts; attempt++) {
						result = await executeResponsesSummary({
							runtime,
							input: segmentInput,
							prompt,
							signal: event.signal,
							settings: config,
							context: ctx,
						});
						if (result.ok || result.reason === "aborted" || !isRetryableResponsesSummaryFailure(result)) break;
						if (attempt < maxAttempts) {
							const delay = await waitRetryDelay(config.compactRetryDelayMs, event.signal);
							if (delay === "aborted") return { ok: false, reason: "aborted" };
						}
					}
					return result;
				},
				attemptPi: (messages) =>
					runPiDefaultSegmentCompaction({ ctx, event, config, messages }),
				estimateMessageTokens: (message) => {
					try {
						return Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
					} catch {
						return 1;
					}
				},
				onEvent: (data) => writeDebugArtifact("compaction-event", data, config, ctx),
			});
			if (!recovery.ok) {
				if (recovery.reason === "aborted" || event.signal.aborted) return { outcome: "aborted" };
				writeDebugArtifact(
					"compaction-event",
					{ event: "session_before_compact.oversize-recovery-failure", errorMessage: recovery.errorMessage },
					config,
					ctx,
				);
				return { outcome: "failed" };
			}
			writeDebugArtifact(
				"compaction-event",
				{ event: "session_before_compact.oversize-recovery-success", method: "direct-responses-summary" },
				config,
				ctx,
			);
			return {
				outcome: "success",
				compaction: {
					summary: recovery.summaryText,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: normalizeCompactionDetails(event.preparation.fileOps),
				},
			};
		} else {
			notify(
				ctx,
				`original path failed after ${attemptsUsed} attempt${attemptsUsed === 1 ? "" : "s"} (${formatNativeFailure(compactResult)}); switching to Pi default compaction`,
				"warning",
			);
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.responses-summary-exhausted",
					attemptsUsed,
					attempts: maxAttempts,
					reason: compactResult.reason,
					status: compactResult.status,
					errorMessage: compactResult.errorMessage,
					timeoutMs: compactResult.timeoutMs,
				},
				config,
				ctx,
			);
			return { outcome: "failed" };
		}
	}

	const compaction: CompactionResult = {
		summary: compactResult.summaryText,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: normalizeCompactionDetails(event.preparation.fileOps),
	};
	if (attemptsUsed > 1) {
		notify(ctx, "retry succeeded; compaction is complete", "info");
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.responses-summary-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource: "session-context",
			requestInputItems: input.length,
			summarySource: "direct-responses-summary",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			attempt: attemptsUsed,
			attempts: maxAttempts,
		},
		config,
		ctx,
	);

	return { outcome: "success", compaction };
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
) {
	if (!config.enabled) {
		return undefined;
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact",
			customInstructions: event.customInstructions,
			preparation: {
				tokensBefore: event.preparation.tokensBefore,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
				messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
				turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
			},
		},
		config,
		ctx,
	);

	if (event.signal.aborted) {
		return { cancel: true };
	}

	// Branch 1: Responses-family APIs summarize Pi's portable session context directly.
	const resolutionRace = await raceWithUserAbort(
		resolveResponsesSummaryEnvironment(ctx, {
			enabled: config.enabled,
			responsesCompactApis: config.responsesCompactApis,
		}),
		event.signal,
	);
	if (resolutionRace.aborted) {
		return { cancel: true };
	}
	const resolution = resolutionRace.value;
	if (resolution.ok) {
		const responsesOutcome = await runResponsesSummary(event, ctx, config, resolution.runtime);
		if (responsesOutcome.outcome === "success") {
			return { compaction: responsesOutcome.compaction };
		}
		if (responsesOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		// failed: the original-path request is exhausted (or the session was skipped) →
		// hand off to pi's default compaction. By design we do NOT switch to the
		// configured compactionModel here: if the direct summary fails, a different
		// model usually fails for the same reason, and pi's default keeps the
		// streaming progress UI.
		return undefined;
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.responses-summary-unavailable",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
			},
			config,
			ctx,
		);
		// Responses-family models that cannot even form a compact request must not
		// fall through into compactionModel (that would silently change methods
		// before the original path was ever attempted).
		if (
			resolution.reason === "missing-api-key" ||
			resolution.reason === "missing-base-url" ||
			resolution.reason === "missing-model"
		) {
			notify(
				ctx,
				`Responses summary unavailable (${resolution.reason}); using pi's default compaction`,
				"warning",
			);
			return undefined;
		}
	}

	// Branch 2: run pi's native compaction method with the configured model. Transient
	// runtime failures are retried on the same model; config failures (no model, bad
	// spec, auth, ...) are not — retrying them would just repeat the same mistake.
	const maxAttempts = Math.max(1, config.compactMaxAttempts);
	const retryableFallbackReasons = new Set<string>(["empty-summary", "compact-failed", "timeout"]);
	// maxAttempts is always >= 1, so the loop body assigns this on every path.
	let fallback!: NativeFallbackResult;
	let attemptsUsed = 0;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (event.signal.aborted) {
			return { cancel: true };
		}

		attemptsUsed = attempt;
		fallback = await runNativeFallbackCompaction({ ctx, event, config });

		if (fallback.ok) {
			notify(
				ctx,
				attempt > 1
					? `compacted with ${fallback.model.provider}/${fallback.model.id} on retry (native method)`
					: `compacted with ${fallback.model.provider}/${fallback.model.id} (native method)`,
				"info",
			);
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.fallback-success",
					model: fallback.model,
					attempt,
					attempts: maxAttempts,
				},
				config,
				ctx,
			);
			return { compaction: fallback.result };
		}

		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.fallback-failure",
				attempt,
				attempts: maxAttempts,
				reason: fallback.reason,
				modelSpec: fallback.modelSpec,
				errorMessage: fallback.errorMessage,
				timeoutMs: fallback.timeoutMs,
			},
			config,
			ctx,
		);

		if (fallback.reason === "aborted" || event.signal.aborted) {
			return { cancel: true };
		}

		if (attempt < maxAttempts && retryableFallbackReasons.has(fallback.reason)) {
			notify(
				ctx,
				`compaction model failed (${formatNativeFailure(fallback)}); retrying (${attempt + 1}/${maxAttempts})…`,
				"warning",
			);
			const delay = await waitRetryDelay(config.compactRetryDelayMs, event.signal);
			if (delay === "aborted") {
				return { cancel: true };
			}
			continue;
		}

		break;
	}

	// The loop only exits without a return when the last result is a failure.
	const failure = fallback as Extract<NativeFallbackResult, { ok: false }>;
	const retryableExhausted = retryableFallbackReasons.has(failure.reason);
	writeDebugArtifact(
		"compaction-event",
		{
			event: retryableExhausted
				? "session_before_compact.fallback-exhausted"
				: "session_before_compact.fallback-skip",
			reason: failure.reason,
			modelSpec: failure.modelSpec,
			errorMessage: failure.errorMessage,
			timeoutMs: failure.timeoutMs,
			attemptsUsed,
			attempts: maxAttempts,
		},
		config,
		ctx,
	);

	// Intentional pi-default paths: no configured model, or it matches the current one.
	if (failure.reason !== "no-model-configured" && failure.reason !== "same-as-current-model") {
		const detail = retryableExhausted
			? `compaction model failed after ${attemptsUsed} attempts; using pi's default compaction`
			: `compaction model "${failure.modelSpec}" unusable (${failure.reason}${failure.errorMessage ? `: ${failure.errorMessage}` : ""}); using pi's default compaction`;
		notifyWarning(ctx, detail);
	}

	// Branch 3: pi's default native compaction with the current model.
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Pi reloads the extension to apply config changes. Keep parsed config in this
	// extension instance so provider requests never perform synchronous file I/O.
	const { config, source, warnings } = loadExtensionConfig();

	pi.on("session_start", (_event, ctx) => {
		if (!config.enabled) return;

		if (warnings.length > 0 && ctx.hasUI && config.debug) {
			ctx.ui.notify(`${EXTENSION_ID}: ${warnings[0]}`, "warning");
		}

		const artifactPath = writeDebugArtifact(
			"lifecycle",
			{
				event: "session_start",
				config,
				configSource: source,
				warnings,
			},
			config,
			ctx,
		);

		if (ctx.hasUI && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(
				artifactPath
					? `${EXTENSION_ID} loaded • debug artifacts → ${artifactPath}`
					: `${EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	pi.on("session_before_compact", (event, ctx) => handleSessionBeforeCompact(event, ctx, config));
}
