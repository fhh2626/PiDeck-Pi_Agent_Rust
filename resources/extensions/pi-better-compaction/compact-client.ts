import { writeDebugArtifact } from "./debug";
import { buildResponsesUrl, type NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import {
	MIN_COMPACT_TIMEOUT_MS,
	type ArtifactContext,
	type ExtensionConfig,
} from "./types";

const JSON_CONTENT_TYPE = "application/json";

type CompactResponseEnvelope = {
	id?: string;
	created_at?: number | string;
	output: unknown[];
	[key: string]: unknown;
};

export type NativeCompactionClientFailureReason =
	| "aborted"
	| "timeout"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "malformed-response"
	| "empty-output"
	| "incomplete-response"
	| "empty-summary";

export type NativeCompactionClientSuccess = {
	ok: true;
	status: number;
	compactedWindow: unknown[];
	compactResponseId?: string;
	createdAt?: string;
	/** Portable summary text extracted from the compact output, for CompactionEntry.summary. */
	summaryText?: string;
	response: CompactResponseEnvelope;
};

export type NativeCompactionClientFailure = {
	ok: false;
	reason: NativeCompactionClientFailureReason;
	status?: number;
	errorMessage?: string;
	timeoutMs?: number;
	responseText?: string;
	responseJson?: unknown;
};

export type NativeCompactionClientResult = NativeCompactionClientSuccess | NativeCompactionClientFailure;

export type PortableCompactionSummarySuccess = {
	ok: true;
	status: number;
	summaryText: string;
	response: unknown;
};

export type PortableCompactionSummaryResult = PortableCompactionSummarySuccess | NativeCompactionClientFailure;

export type ExecuteNativeCompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	settings?: ExtensionConfig;
	context?: ArtifactContext;
};

export type ExecutePortableCompactionSummaryOptions = {
	runtime: NativeCompactionRuntime;
	compactedWindow: readonly unknown[];
	signal?: AbortSignal;
	settings?: ExtensionConfig;
	context?: ArtifactContext;
};

/** Mirrors Codex's open-source local compaction prompt, with a narrow output contract for Pi. */
export const CODEX_PORTABLE_SUMMARY_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.

Return only the plaintext summary body. Do not continue the task or call tools.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function isCompactOutputItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}

function isCompactResponseEnvelope(value: unknown): value is CompactResponseEnvelope {
	return isRecord(value) && Array.isArray(value.output) && value.output.every(isCompactOutputItem);
}

// OpenCodex's routed-model /responses/compact implementation returns its handoff
// summary as the final user/input_text item with this exact prefix.
const OPENCODEX_HANDOFF_SUMMARY_PREFIX =
	"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

function extractOpenCodexHandoffSummary(item: unknown): string | undefined {
	if (!isRecord(item) || item.type !== "message" || item.role !== "user") {
		return undefined;
	}

	const content = item.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(block): block is Record<string, unknown> & { text: string } =>
								isRecord(block) &&
								(block.type === "input_text" || block.type === "text") &&
								typeof block.text === "string",
						)
						.map((block) => block.text)
						.join("")
				: undefined;
	if (!text) {
		return undefined;
	}

	const framedPrefix = `${OPENCODEX_HANDOFF_SUMMARY_PREFIX}\n`;
	if (!text.startsWith(framedPrefix)) {
		return undefined;
	}

	const summary = text.slice(framedPrefix.length).trim();
	return summary.length > 0 ? summary : undefined;
}

function extractAssistantOutputText(output: readonly unknown[]): string | undefined {
	const texts: string[] = [];
	for (const item of output) {
		if (!isRecord(item) || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
			continue;
		}
		for (const block of item.content) {
			if (isRecord(block) && block.type === "output_text" && typeof block.text === "string" && block.text.trim()) {
				texts.push(block.text.trim());
			}
		}
	}

	const joined = texts.join("\n\n").trim();
	return joined.length > 0 ? joined : undefined;
}

/**
 * Extract a portable summary from the compacted window so the persisted
 * CompactionEntry.summary carries real context. Some compatible compact endpoints
 * expose it as assistant output_text, while OpenCodex routed-model responses expose
 * it as a specially framed user/input_text handoff message.
 */
export function extractCompactedSummaryText(output: readonly unknown[]): string | undefined {
	const assistantSummary = extractAssistantOutputText(output);
	const finalItem = output.length > 0 ? output[output.length - 1] : undefined;
	return assistantSummary ?? extractOpenCodexHandoffSummary(finalItem);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}

	try {
		const payloadText = Buffer.from(parts[1]!, "base64url").toString("utf8");
		const payload = JSON.parse(payloadText);
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const authClaims = payload?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims)) {
		return undefined;
	}

	const accountId = authClaims.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
}

function buildCodexUserAgent(): string {
	const platform = typeof process !== "undefined" ? process.platform : "browser";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `pi (${platform}; ${arch})`;
}

function toHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	const headers = new Headers(runtime.currentModel.headers ?? {});
	for (const [key, value] of Object.entries(runtime.headers ?? {})) {
		headers.set(key, value);
	}
	headers.set("accept", JSON_CONTENT_TYPE);
	headers.set("content-type", JSON_CONTENT_TYPE);
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}

	if (runtime.api === "openai-codex-responses") {
		const accountId = extractCodexAccountId(runtime.apiKey);
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}
		headers.set("originator", "pi");
		headers.set("user-agent", buildCodexUserAgent());
		headers.set("openai-beta", "responses=experimental");
	}

	return Object.fromEntries(headers.entries());
}

function writeCompactArtifact(
	data: unknown,
	settings: ExtensionConfig | undefined,
	context: ArtifactContext | undefined,
): void {
	if (!settings || !context) {
		return;
	}

	writeDebugArtifact("compact-response", data, settings, context);
}

type PortableSummaryParseResult =
	| { ok: true; summaryText: string; response: unknown }
	| {
		ok: false;
		reason: "invalid-json" | "malformed-response" | "incomplete-response" | "empty-summary";
		errorMessage?: string;
		responseJson?: unknown;
	};

function parsePortableSummaryResponse(responseText: string): PortableSummaryParseResult {
	let jsonResponse: unknown;
	try {
		jsonResponse = JSON.parse(responseText);
	} catch {
		jsonResponse = undefined;
	}

	if (jsonResponse !== undefined) {
		if (!isRecord(jsonResponse) || !Array.isArray(jsonResponse.output)) {
			return { ok: false, reason: "malformed-response", responseJson: jsonResponse };
		}
		if (typeof jsonResponse.status === "string" && jsonResponse.status !== "completed") {
			return {
				ok: false,
				reason: "incomplete-response",
				errorMessage: `response status was ${jsonResponse.status}`,
				responseJson: jsonResponse,
			};
		}
		const summaryText = extractAssistantOutputText(jsonResponse.output);
		return summaryText
			? { ok: true, summaryText, response: jsonResponse }
			: { ok: false, reason: "empty-summary", responseJson: jsonResponse };
	}

	const deltas: string[] = [];
	let doneText: string | undefined;
	let terminalResponse: unknown;
	let sawTerminal = false;
	let sawData = false;
	for (const line of responseText.split(/\r?\n/)) {
		if (!line.startsWith("data:")) {
			continue;
		}
		const data = line.slice("data:".length).trimStart();
		if (!data) {
			continue;
		}
		sawData = true;
		if (data === "[DONE]") {
			sawTerminal = true;
			continue;
		}

		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch (error) {
			return {
				ok: false,
				reason: "invalid-json",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
		if (!isRecord(event)) {
			continue;
		}

		if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
			deltas.push(event.delta);
		} else if (event.type === "response.output_text.done" && typeof event.text === "string") {
			doneText = event.text;
		} else if (event.type === "response.completed" || event.type === "response.done") {
			terminalResponse = event.response;
			if (
				isRecord(terminalResponse) &&
				typeof terminalResponse.status === "string" &&
				terminalResponse.status !== "completed"
			) {
				return {
					ok: false,
					reason: "incomplete-response",
					errorMessage: `response status was ${terminalResponse.status}`,
					responseJson: terminalResponse,
				};
			}
			sawTerminal = true;
		} else if (event.type === "response.incomplete" || event.type === "response.failed" || event.type === "error") {
			const responseError = isRecord(event.response) && isRecord(event.response.error) ? event.response.error : undefined;
			const nestedError = isRecord(event.error) ? event.error.message : responseError?.message;
			return {
				ok: false,
				reason: "incomplete-response",
				errorMessage:
					typeof nestedError === "string"
						? nestedError
						: typeof event.message === "string"
							? event.message
							: String(event.type),
				responseJson: event,
			};
		}
	}

	if (!sawData) {
		return { ok: false, reason: "invalid-json", errorMessage: "response was neither JSON nor Responses SSE" };
	}
	if (!sawTerminal) {
		return { ok: false, reason: "incomplete-response", errorMessage: "Responses stream ended without completion" };
	}

	const terminalSummary =
		isRecord(terminalResponse) && Array.isArray(terminalResponse.output)
			? extractAssistantOutputText(terminalResponse.output)
			: undefined;
	const summaryText = (terminalSummary ?? deltas.join("").trim()) || doneText?.trim();
	return summaryText
		? { ok: true, summaryText, response: terminalResponse ?? { type: "response.completed" } }
		: { ok: false, reason: "empty-summary", responseJson: terminalResponse };
}

export async function executePortableCompactionSummary(
	options: ExecutePortableCompactionSummaryOptions,
): Promise<PortableCompactionSummaryResult> {
	const { runtime, compactedWindow, signal, settings, context } = options;
	const url = buildResponsesUrl(runtime.baseUrl, runtime.api);
	const headers = toHeaders(runtime);
	headers.accept = "text/event-stream";
	const request = {
		model: runtime.model,
		instructions: CODEX_PORTABLE_SUMMARY_PROMPT,
		input: compactedWindow,
		stream: true,
		store: false,
	};

	if (signal?.aborted) {
		return { ok: false, reason: "aborted" };
	}

	const timeoutMs = settings?.compactTimeoutMs ?? MIN_COMPACT_TIMEOUT_MS;
	const controller = new AbortController();
	const onUserAbort = () => controller.abort();
	signal?.addEventListener("abort", onUserAbort);
	let onAttemptAbort: (() => void) | undefined;
	const attemptAbort = new Promise<never>((_resolve, reject) => {
		onAttemptAbort = () => reject(new DOMException("Portable summary attempt aborted", "AbortError"));
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
		const responseOperation = (async () => {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(request),
				signal: controller.signal,
			});
			const responseText = await response.text();
			return { response, responseText };
		})();
		const { response, responseText } = await Promise.race([responseOperation, attemptAbort]);

		if (!response.ok) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				responseText: responseText || undefined,
			};
			writeCompactArtifact(
				{
					stage: "portable-summary",
					request: { url, headers, body: request },
					response: { status: response.status, body: responseText },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}
		if (!responseText.trim()) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "empty-body",
				status: response.status,
			};
			writeCompactArtifact(
				{
					stage: "portable-summary",
					request: { url, headers, body: request },
					response: { status: response.status, body: responseText },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const parsed = parsePortableSummaryResponse(responseText);
		const result: PortableCompactionSummaryResult = parsed.ok
			? { ok: true, status: response.status, summaryText: parsed.summaryText, response: parsed.response }
			: {
				ok: false,
				reason: parsed.reason,
				status: response.status,
				errorMessage: parsed.errorMessage,
				responseJson: parsed.responseJson,
				responseText,
			};
		writeCompactArtifact(
			{
				stage: "portable-summary",
				request: { url, headers, body: request },
				response: { status: response.status, body: parsed.ok ? parsed.response : parsed.responseJson ?? responseText },
				outcome: result,
			},
			settings,
			context,
		);
		return result;
	} catch (error) {
		const failure: NativeCompactionClientFailure = signal?.aborted
			? { ok: false, reason: "aborted" }
			: timedOut
				? { ok: false, reason: "timeout", timeoutMs }
				: {
					ok: false,
					reason: "network-error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
		writeCompactArtifact(
			{ stage: "portable-summary", request: { url, headers, body: request }, outcome: failure },
			settings,
			context,
		);
		return failure;
	} finally {
		if (timeoutTimer !== undefined) {
			clearTimeout(timeoutTimer);
		}
		if (onAttemptAbort) {
			controller.signal.removeEventListener("abort", onAttemptAbort);
		}
		signal?.removeEventListener("abort", onUserAbort);
	}
}

export async function executeNativeCompaction(
	options: ExecuteNativeCompactionOptions,
): Promise<NativeCompactionClientResult> {
	const { runtime, request, signal, settings, context } = options;
	const headers = toHeaders(runtime);

	if (signal?.aborted) {
		const aborted: NativeCompactionClientFailure = {
			ok: false,
			reason: "aborted",
		};
		writeCompactArtifact(
			{
				request: {
					url: runtime.compactUrl,
					headers,
					body: request,
				},
				outcome: aborted,
			},
			settings,
			context,
		);
		return aborted;
	}
	const timeoutMs = settings?.compactTimeoutMs ?? MIN_COMPACT_TIMEOUT_MS;
	const controller = new AbortController();
	const onUserAbort = () => controller.abort();
	signal?.addEventListener("abort", onUserAbort);
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
		// Race the complete response-body read against our attempt signal. Aborting
		// the underlying fetch is still the primary cancellation mechanism, while
		// the race guarantees the hook settles even if a non-conforming fetch/proxy
		// ignores AbortSignal.
		const responseOperation = (async () => {
			const response = await fetch(runtime.compactUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(request),
				signal: controller.signal,
			});
			const responseText = await response.text();
			return { response, responseText };
		})();
		const { response, responseText } = await Promise.race([responseOperation, attemptAbort]);
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		if (!response.ok) {
			let responseJson: unknown;
			if (responseText.trim().length > 0) {
				try {
					responseJson = JSON.parse(responseText);
				} catch {
					responseJson = undefined;
				}
			}

			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				responseText: responseText || undefined,
				responseJson,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: responseJson ?? responseText,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (!responseText.trim()) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "empty-body",
				status: response.status,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: responseText,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(responseText);
		} catch (error) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "invalid-json",
				status: response.status,
				errorMessage: error instanceof Error ? error.message : String(error),
				responseText,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: responseText,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (!isCompactResponseEnvelope(parsed)) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "malformed-response",
				status: response.status,
				responseJson: parsed,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: parsed,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (parsed.output.length === 0) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "empty-output",
				status: response.status,
				responseJson: parsed,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: parsed,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const success: NativeCompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: [...parsed.output],
			compactResponseId: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined,
			createdAt: normalizeResponseTimestamp(parsed.created_at),
			summaryText: extractCompactedSummaryText(parsed.output),
			response: parsed,
		};
		writeCompactArtifact(
			{
				request: {
					url: runtime.compactUrl,
					headers,
					body: request,
				},
				response: {
					status: response.status,
					headers: responseHeaders,
					body: parsed,
				},
				outcome: {
					ok: true,
					status: success.status,
					compactResponseId: success.compactResponseId,
					createdAt: success.createdAt,
					compactedItems: success.compactedWindow.length,
				},
			},
			settings,
			context,
		);
		return success;
	} catch (error) {
		const failure: NativeCompactionClientFailure = signal?.aborted
			? {
				ok: false,
				reason: "aborted",
			}
			: timedOut
				? {
					ok: false,
					reason: "timeout",
					timeoutMs,
				}
				: isAbortError(error)
					? {
						ok: false,
						reason: "network-error",
						errorMessage: error instanceof Error ? error.message : String(error),
					}
					: {
						ok: false,
						reason: "network-error",
						errorMessage: error instanceof Error ? error.message : String(error),
					};

		writeCompactArtifact(
			{
				request: {
					url: runtime.compactUrl,
					headers,
					body: request,
				},
				outcome: failure,
			},
			settings,
			context,
		);
		return failure;
	} finally {
		if (timeoutTimer !== undefined) {
			clearTimeout(timeoutTimer);
		}
		if (onAttemptAbort) {
			controller.signal.removeEventListener("abort", onAttemptAbort);
		}
		signal?.removeEventListener("abort", onUserAbort);
	}
}
