import { writeDebugArtifact } from "./debug";
import { buildResponsesUrl, type ResponsesSummaryRuntime } from "./runtime";
import {
	MIN_COMPACT_TIMEOUT_MS,
	type ArtifactContext,
	type ExtensionConfig,
} from "./types";

const JSON_CONTENT_TYPE = "application/json";

export type ResponsesSummaryFailureReason =
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

export type ResponsesSummaryFailure = {
	ok: false;
	reason: ResponsesSummaryFailureReason;
	status?: number;
	errorMessage?: string;
	timeoutMs?: number;
	responseText?: string;
	responseJson?: unknown;
};

export type ResponsesSummarySuccess = {
	ok: true;
	status: number;
	summaryText: string;
	response: unknown;
};

export type ResponsesSummaryResult = ResponsesSummarySuccess | ResponsesSummaryFailure;

export type ExecuteResponsesSummaryOptions = {
	runtime: ResponsesSummaryRuntime;
	input: readonly unknown[];
	prompt?: string;
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
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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

function toHeaders(runtime: ResponsesSummaryRuntime): Record<string, string> {
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

export async function executeResponsesSummary(
	options: ExecuteResponsesSummaryOptions,
): Promise<ResponsesSummaryResult> {
	const { runtime, input, signal, settings, context } = options;
	const url = buildResponsesUrl(runtime.baseUrl, runtime.api);
	const headers = toHeaders(runtime);
	headers.accept = "text/event-stream";
	const request = {
		model: runtime.model,
		input: [
			...input,
			{
				role: "user",
				content: [{ type: "input_text", text: options.prompt ?? CODEX_PORTABLE_SUMMARY_PROMPT }],
			},
		],
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
		onAttemptAbort = () => reject(new DOMException("Responses summary attempt aborted", "AbortError"));
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
			const failure: ResponsesSummaryFailure = {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				responseText: responseText || undefined,
			};
			writeCompactArtifact(
				{
					stage: "direct-summary",
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
			const failure: ResponsesSummaryFailure = {
				ok: false,
				reason: "empty-body",
				status: response.status,
			};
			writeCompactArtifact(
				{
					stage: "direct-summary",
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
		const result: ResponsesSummaryResult = parsed.ok
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
			stage: "direct-summary",
				request: { url, headers, body: request },
				response: { status: response.status, body: parsed.ok ? parsed.response : parsed.responseJson ?? responseText },
				outcome: result,
			},
			settings,
			context,
		);
		return result;
	} catch (error) {
		const failure: ResponsesSummaryFailure = signal?.aborted
			? { ok: false, reason: "aborted" }
			: timedOut
				? { ok: false, reason: "timeout", timeoutMs }
				: {
					ok: false,
					reason: "network-error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
		writeCompactArtifact(
			{ stage: "direct-summary", request: { url, headers, body: request }, outcome: failure },
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
