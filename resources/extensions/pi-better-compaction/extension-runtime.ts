import {
	type BeforeProviderRequestEvent,
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	executeNativeCompaction,
	executePortableCompactionSummary,
	type NativeCompactionClientResult,
} from "./compact-client";
import { loadExtensionConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import {
	runNativeFallbackCompaction,
	runPiDefaultSegmentCompaction,
	type NativeFallbackResult,
} from "./native-fallback";
import {
	createPortableSummaryMessage,
	type ExistingRecoveryCheckpoint,
	getNativeOverflow,
	recoverOversizedCompaction,
} from "./overflow-recovery";
import {
	rewriteResponsesPayloadWithNativeReplay,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import {
	isResponsesCompatiblePayload,
	resolveNativeCompactionEnvironment,
	resolveNativeReplayEnvironment,
	type NativeCompactionRuntime,
} from "./runtime";
import { serializeMessagesToCompactRequest, type NativeCompactionRequestBody, type ResponsesInputItem } from "./serializer";
import {
	createNativeCompactionDetails,
	createNativeCompactionResult,
	EXTENSION_ID,
	isNativeCompactionDetails,
	MIN_COMPACT_TIMEOUT_MS,
	type ExtensionConfig,
	type NativeCompactionDetails,
	type NativeCompactionRequestMeta,
} from "./types";

type ResponsesCompactOutcome =
	| { outcome: "success"; compaction: CompactionResult }
	| { outcome: "aborted" }
	| { outcome: "failed" };

function buildCompactionRequestMeta(event: SessionBeforeCompactEvent): NativeCompactionRequestMeta {
	return {
		tokensBefore: event.preparation.tokensBefore,
		previousSummaryPresent: Boolean(event.preparation.previousSummary),
	};
}

function getCurrentModelDebugInfo(ctx: ExtensionContext) {
	return ctx.model
		? {
			provider: ctx.model.provider,
			id: ctx.model.id,
		}
		: undefined;
}

function getCompactionIdentityDebugInfo(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? {
			provider: entry.details.provider,
			api: entry.details.api,
			model: entry.details.model,
			baseUrl: entry.details.baseUrl,
		}
		: undefined;
}

function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
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

function isRetryableNativeCompactionFailure(
	result: Extract<NativeCompactionClientResult, { ok: false }>,
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

function cloneOpaqueWindow(window: readonly unknown[]): unknown[] {
	return window.map((item) => structuredClone(item));
}

function entryToPortableMessages(entry: Record<string, unknown>): AgentMessage[] {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		return [entry.message as AgentMessage];
	}
	const timestamp = new Date(typeof entry.timestamp === "string" ? entry.timestamp : Date.now()).getTime();
	if (entry.type === "custom_message") {
		return [{
			role: "custom",
			customType: typeof entry.customType === "string" ? entry.customType : "custom",
			content: (entry.content ?? []) as never,
			display: entry.display === true,
			details: entry.details,
			timestamp,
		} as AgentMessage];
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return [{
			role: "branchSummary",
			summary: entry.summary,
			fromId: typeof entry.fromId === "string" ? entry.fromId : "",
			timestamp,
		} as AgentMessage];
	}
	if (entry.type === "compaction" && typeof entry.summary === "string") {
		return [{
			...createPortableSummaryMessage(entry.summary),
			tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
			timestamp,
		} as AgentMessage];
	}
	return [];
}

function buildRecoverySegments(event: SessionBeforeCompactEvent, ctx: ExtensionContext): {
	history: AgentMessage[];
	turnPrefix?: AgentMessage[];
	remaining: AgentMessage[];
} {
	const history: AgentMessage[] = [];
	if (event.preparation.previousSummary) {
		history.push(createPortableSummaryMessage(event.preparation.previousSummary));
	}
	history.push(...(event.preparation.messagesToSummarize as AgentMessage[]));
	const turnPrefix = event.preparation.isSplitTurn
		? (event.preparation.turnPrefixMessages as AgentMessage[])
		: undefined;

	const contextMessages = ctx.sessionManager.buildSessionContext().messages as AgentMessage[];
	const summarizedCount = history.length + (turnPrefix?.length ?? 0);
	return {
		history,
		turnPrefix,
		remaining: contextMessages.slice(Math.min(summarizedCount, contextMessages.length)),
	};
}

function normalizeCompactionDetails(fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"]): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set<string>([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	if (!guidance) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`;
}

async function runResponsesNativeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	runtime: NativeCompactionRuntime,
): Promise<ResponsesCompactOutcome> {
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let requestSource:
		| "session-context"
		| "non-native-session-context"
		| "model-switch-session-context"
		| "latest-native-replay";
	let request: NativeCompactionRequestBody;
	let existingRecoveryCheckpoint: ExistingRecoveryCheckpoint | undefined;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		const liveTailMessages = liveTailEntries.flatMap((entry) => entryToPortableMessages(entry as Record<string, unknown>));
		const portableContext = ctx.sessionManager.buildSessionContext().messages as AgentMessage[];
		requestSource = "latest-native-replay";
		const input: ResponsesInputItem[] = [
			...(cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow) as ResponsesInputItem[]),
			...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
		];
		request = {
			model: runtime.currentModel.id,
			input,
			instructions,
		};
		existingRecoveryCheckpoint = {
			nativePrefix: cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow) as ResponsesInputItem[],
			portablePrefix: portableContext.slice(0, Math.max(0, portableContext.length - liveTailMessages.length)),
			remainingMessages: liveTailMessages,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		latestNativeCompaction.reason === "latest-native-compaction-mismatch" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction"
				? "session-context"
				: latestNativeCompaction.reason === "latest-native-compaction-mismatch"
					? "model-switch-session-context"
					: "non-native-session-context";
		request = serializeMessagesToCompactRequest({
			model: runtime.currentModel,
			messages: ctx.sessionManager.buildSessionContext().messages,
			instructions,
		});
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.responses-compact-skip",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	// Mirror the latest codex_rs CompactionInput fields captured from the most
	// recent live provider request for this model (tools, reasoning, etc.).
	const extras = getCompactionRequestExtras(runtime.model, getSessionId(ctx));
	if (extras) {
		request = { ...request, ...extras };
	}

	const maxAttempts = Math.max(1, config.compactMaxAttempts);
	// maxAttempts is always >= 1, so the loop body assigns this on every path.
	let compactResult!: NativeCompactionClientResult;
	let attemptsUsed = 0;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (event.signal.aborted) {
			return { outcome: "aborted" };
		}

		attemptsUsed = attempt;
		compactResult = await executeNativeCompaction({
			runtime,
			request,
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
				event: "session_before_compact.responses-compact-failure",
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

		if (attempt >= maxAttempts || !isRetryableNativeCompactionFailure(compactResult)) {
			break;
		}

		notify(
			ctx,
			`original-path compact failed (${formatNativeFailure(compactResult)}); retrying original path (${attempt + 1}/${maxAttempts})…`,
			"warning",
		);
		const delay = await waitRetryDelay(config.compactRetryDelayMs, event.signal);
		if (delay === "aborted") {
			return { outcome: "aborted" };
		}
	}

	if (compactResult.ok === false) {
		const overflow = getNativeOverflow(compactResult);
		if (overflow) {
			notify(
				ctx,
				`compact input exceeds the provider context${overflow.promptTokens && overflow.contextLimit ? ` (${overflow.promptTokens}/${overflow.contextLimit} tokens)` : ""}; reducing it in bounded segments…`,
				"warning",
			);
			const recoverySegments = buildRecoverySegments(event, ctx);
			const recovery = await recoverOversizedCompaction({
				initialOverflow: overflow,
				messages: recoverySegments.history,
				turnPrefixMessages: recoverySegments.turnPrefix,
				remainingMessages: recoverySegments.remaining,
				existingCheckpoint: existingRecoveryCheckpoint,
				serializeMessages: (messages) =>
					serializeMessagesToCompactRequest({
						model: runtime.currentModel,
						messages,
						instructions,
					}).input,
				attemptNative: async (input) => {
					const recoveryRequest: NativeCompactionRequestBody = { ...request, input };
					let result: NativeCompactionClientResult = {
						ok: false,
						reason: "network-error",
						errorMessage: "native recovery was not attempted",
					};
					for (let attempt = 1; attempt <= maxAttempts; attempt++) {
						result = await executeNativeCompaction({
							runtime,
							request: recoveryRequest,
							signal: event.signal,
							settings: config,
							context: ctx,
						});
						if (result.ok || result.reason === "aborted" || !isRetryableNativeCompactionFailure(result)) break;
						if (attempt < maxAttempts) {
							const delay = await waitRetryDelay(config.compactRetryDelayMs, event.signal);
							if (delay === "aborted") return { ok: false, reason: "aborted" };
						}
					}
					return result;
				},
				makePortable: (window) =>
					executePortableCompactionSummary({
						runtime,
						compactedWindow: window,
						signal: event.signal,
						settings: config,
						context: ctx,
					}),
				attemptPi: (messages, kind) =>
					runPiDefaultSegmentCompaction({ ctx, event, config, messages, kind }),
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
			if (recovery.kind === "pi") {
				writeDebugArtifact(
					"compaction-event",
					{ event: "session_before_compact.oversize-recovery-success", method: "pi-default" },
					config,
					ctx,
				);
				return {
					outcome: "success",
					compaction: {
						summary: recovery.persistenceSummaryText,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: normalizeCompactionDetails(event.preparation.fileOps),
					},
				};
			}
			compactResult = {
				ok: true,
				status: 200,
				compactedWindow: recovery.compactedWindow,
				summaryText: recovery.persistenceSummaryText,
				response: { output: recovery.compactedWindow },
			};
			attemptsUsed = maxAttempts;
			writeDebugArtifact(
				"compaction-event",
				{ event: "session_before_compact.oversize-recovery-success", method: "openai-native" },
				config,
				ctx,
			);
		} else {
			notify(
				ctx,
				`original path failed after ${attemptsUsed} attempt${attemptsUsed === 1 ? "" : "s"} (${formatNativeFailure(compactResult)}); switching to Pi default compaction`,
				"warning",
			);
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.responses-compact-exhausted",
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

	let summaryText = compactResult.summaryText;
	if (!summaryText) {
		const portableSummary = await executePortableCompactionSummary({
			runtime,
			compactedWindow: compactResult.compactedWindow,
			signal: event.signal,
			settings: config,
			context: ctx,
		});
		if (!portableSummary.ok) {
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.portable-summary-failure",
					reason: portableSummary.reason,
					status: portableSummary.status,
					errorMessage: portableSummary.errorMessage,
					timeoutMs: portableSummary.timeoutMs,
				},
				config,
				ctx,
			);
			if (portableSummary.reason === "aborted" || event.signal.aborted) {
				return { outcome: "aborted" };
			}
			notify(
				ctx,
				`native compact succeeded but its portable summary failed (${formatNativeFailure(portableSummary)}); switching to Pi default compaction`,
				"warning",
			);
			return { outcome: "failed" };
		}
		summaryText = portableSummary.summaryText;
	}

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow: compactResult.compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: buildCompactionRequestMeta(event),
		});
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
			},
			config,
			ctx,
		);
		notify(
			ctx,
			"native compact returned an unusable result; switching to Pi default compaction",
			"warning",
		);
		return { outcome: "failed" };
	}

	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
		summary: summaryText,
	});
	if (attemptsUsed > 1) {
		notify(ctx, "retry succeeded; compaction is complete", "info");
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.responses-compact-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource,
			requestInputItems: request.input.length,
			requestExtras: extras ? Object.keys(extras) : [],
			compactResponseId: compactResult.compactResponseId,
			compactedItems: compactResult.compactedWindow.length,
			summaryExtracted: Boolean(summaryText),
			summarySource: compactResult.summaryText ? "compact-response" : "post-compact-current-model",
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

	// Branch 1: Responses-family APIs use the native /responses/compact endpoint.
	const resolutionRace = await raceWithUserAbort(
		resolveNativeCompactionEnvironment(ctx, {
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
		const responsesOutcome = await runResponsesNativeCompact(event, ctx, config, resolution.runtime);
		if (responsesOutcome.outcome === "success") {
			return { compaction: responsesOutcome.compaction };
		}
		if (responsesOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		// failed: the original-path request is exhausted (or the session was skipped) →
		// hand off to pi's default compaction. By design we do NOT switch to the
		// configured compactionModel here: if the native endpoint fails, a different
		// model usually fails for the same reason, and pi's default keeps the
		// streaming progress UI.
		return undefined;
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.responses-compact-unavailable",
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
				`native compact unavailable (${resolution.reason}); using pi's default compaction`,
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

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
) {
	if (!config.enabled) {
		return undefined;
	}

	// Capture compact-relevant request fields (tools, reasoning, ...) for the next
	// /responses/compact call, regardless of whether this request gets rewritten.
	if (isResponsesCompatiblePayload(event.payload)) {
		rememberRequestContext(event.payload, getSessionId(ctx));
	}

	const resolution = resolveNativeReplayEnvironment(
		ctx,
		{
			enabled: config.enabled,
			responsesCompactApis: config.responsesCompactApis,
		},
		event.payload,
	);
	if (resolution.ok === false) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.skip",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
				currentModel: getCurrentModelDebugInfo(ctx),
				payload: event.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const runtime = resolution.runtime;
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.no-native-compaction",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				branchEntries: branchEntries.length,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
				payload: runtime.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const latestNativeCompactionEntry = latestNativeCompaction.entry;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: runtime.currentModel,
		payload: runtime.payload,
		branchEntries,
		compactionEntry: latestNativeCompactionEntry,
	});
	if (!rewrite.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.rewrite-failed",
				reason: rewrite.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactionEntryId: latestNativeCompactionEntry.id,
				parity: rewrite.parity,
				payload: runtime.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	writeDebugArtifact(
		"provider-request",
		{
			event: "before_provider_request.native-rewrite",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactionEntryId: latestNativeCompactionEntry.id,
			boundaryIndex: rewrite.segments.boundaryIndex,
			firstKeptEntryIndex: rewrite.segments.firstKeptEntryIndex,
			originalInputItems: runtime.payload.input.length,
			rewrittenInputItems: rewrite.rewrittenPayload.input.length,
			freshPreambleItems: rewrite.segments.freshPreamble.length,
			trailingPreambleItems: rewrite.segments.trailingPreamble.length,
			compactionSummaryItems: rewrite.segments.compactionSummary.length,
			preCompactionKeptItems: rewrite.segments.preCompactionKeptWindow.input.length,
			compactedItems: rewrite.segments.compactedWindow.length,
			postCompactionTailItems: rewrite.segments.postCompactionTail.input.length,
			payload: rewrite.rewrittenPayload,
			originalPayload: runtime.payload,
		},
		config,
		ctx,
	);

	return rewrite.rewrittenPayload;
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
	pi.on("before_provider_request", (event, ctx) => handleBeforeProviderRequest(event, ctx, config));
}
