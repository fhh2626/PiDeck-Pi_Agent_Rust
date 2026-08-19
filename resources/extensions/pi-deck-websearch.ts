/**
 * PiDeck-Q-WebSearch extension.
 *
 * Prefers the active Pi model's Responses endpoint and authentication. Official
 * OpenAI and OpenCodex share one protocol path; keyless providers form an ordered fallback.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSequentialWebSearchFallback } from "./pi-deck-websearch-fallback";

const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const MAX_SSE_TEXT_CHARS = 4_000_000;

type WebSearchModel = {
	provider?: string;
	api?: string;
	id?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
};
type WebSearchContext = {
	model?: WebSearchModel;
	modelRegistry: { getApiKeyAndHeaders?: (model: WebSearchModel) => Promise<unknown> };
};

export type WebSearchRuntime = {
	api: string;
	model: string;
	url: string;
	headers: Record<string, string>;
};

export type WebSearchFailureReason =
	| "missing-model"
	| "unsupported-api"
	| "missing-base-url"
	| "auth-failed"
	| "transport-error"
	| "http-error"
	| "empty-response-body"
	| "response-too-large"
	| "invalid-response"
	| "upstream-failed"
	| "upstream-incomplete"
	| "search-not-executed"
	| "empty-answer"
	| "aborted"
	| "fallback-failed";

export type WebSearchFailure = {
	ok: false;
	reason: WebSearchFailureReason;
	message: string;
	status?: number;
};

export type WebSearchSuccess = {
	ok: true;
	query: string;
	queries: string[];
	answer: string;
	sources: string[];
};

export type WebSearchResult = WebSearchSuccess | WebSearchFailure;
export type WebSearchRequest = { runtime: WebSearchRuntime; query: string; signal: AbortSignal };
export type WebSearchFallbackRequest = {
	query: string;
	signal: AbortSignal;
	primaryFailure: WebSearchFailure;
};

/** Search backend invoked when the active Responses upstream cannot complete web search. */
export interface WebSearchFallback {
	search(request: WebSearchFallbackRequest): Promise<WebSearchResult>;
}

export type WebSearchDependencies = { fetch?: typeof fetch; fallback?: WebSearchFallback };
type SearchAccumulator = {
	queries: string[];
	sources: string[];
	doneTexts: string[];
	deltaText: string;
	searchCompleted: boolean;
	responseCompleted: boolean;
	failure?: WebSearchFailure;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nestedMessage(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const direct = stringValue(value.message);
	if (direct) return direct;
	return nestedMessage(value.error) ?? nestedMessage(value.incomplete_details);
}

/** Build the Responses endpoint from Pi's active model descriptor. */
export function buildWebSearchUrl(baseUrl: string, api: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (normalized.endsWith("/responses")) return normalized;
	if (api === "openai-codex-responses") {
		return normalized.endsWith("/codex") ? `${normalized}/responses` : `${normalized}/codex/responses`;
	}
	return `${normalized}/responses`;
}

/** Resolve one unified Responses runtime from the current Pi model. */
export async function resolveWebSearchRuntime(
	ctx: WebSearchContext,
): Promise<{ ok: true; runtime: WebSearchRuntime } | WebSearchFailure> {
	const model = ctx.model;
	if (!model?.id || !model.api) {
		return { ok: false, reason: "missing-model", message: "The current model is unavailable." };
	}
	if (!SUPPORTED_APIS.has(model.api)) {
		return {
			ok: false,
			reason: "unsupported-api",
			message: `The current model API (${model.api}) does not support Responses web search.`,
		};
	}
	const baseUrl = model.baseUrl?.trim();
	if (!baseUrl) {
		return { ok: false, reason: "missing-base-url", message: "The current model has no Responses base URL." };
	}
	const registry = ctx.modelRegistry;
	if (typeof registry.getApiKeyAndHeaders !== "function") {
		return { ok: false, reason: "auth-failed", message: "The model registry cannot resolve request authentication." };
	}

	let auth: unknown;
	try {
		// Keep the registry receiver: alternate Pi/OpenCodex registries may use instance state.
		auth = await registry.getApiKeyAndHeaders(model);
	} catch (error) {
		return { ok: false, reason: "auth-failed", message: `Failed to resolve model authentication: ${errorMessage(error)}` };
	}
	if (!isRecord(auth) || auth.ok !== true) {
		return { ok: false, reason: "auth-failed", message: nestedMessage(auth) ?? "Model authentication is unavailable." };
	}

	const headers: Record<string, string> = {};
	// Preserve model-level routing and compatibility headers; resolved auth may override them.
	for (const [name, value] of Object.entries(model.headers ?? {})) {
		headers[name.toLowerCase()] = value;
	}
	if (isRecord(auth.headers)) {
		for (const [name, value] of Object.entries(auth.headers)) {
			if (typeof value === "string") headers[name.toLowerCase()] = value;
		}
	}
	headers["content-type"] = "application/json";
	const apiKey = stringValue(auth.apiKey);
	if (apiKey && !headers.authorization) headers.authorization = `Bearer ${apiKey}`;
	if (!apiKey && !headers.authorization) {
		return { ok: false, reason: "auth-failed", message: "The current model has no usable API authentication." };
	}

	return {
		ok: true,
		runtime: {
			api: model.api,
			model: model.id,
			url: buildWebSearchUrl(baseUrl, model.api),
			headers,
		},
	};
}

function addQueries(action: unknown, accumulator: SearchAccumulator): void {
	if (!isRecord(action)) return;
	const query = stringValue(action.query);
	if (query) accumulator.queries.push(query);
	if (!Array.isArray(action.queries)) return;
	for (const value of action.queries) {
		const candidate = stringValue(value);
		if (candidate) accumulator.queries.push(candidate);
	}
}

function addSources(value: unknown, accumulator: SearchAccumulator): void {
	if (!Array.isArray(value)) return;
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const url = stringValue(entry.url);
		if (url) accumulator.sources.push(url);
	}
}

function consumeResponsesEvent(value: unknown, accumulator: SearchAccumulator): void {
	if (!isRecord(value)) return;
	const type = stringValue(value.type);
	if (!type) return;

	if (type === "response.output_item.done" && isRecord(value.item) && value.item.type === "web_search_call") {
		if (value.item.status === "completed") accumulator.searchCompleted = true;
		addQueries(value.item.action, accumulator);
		addSources(value.item.sources, accumulator);
		return;
	}
	if (type === "response.web_search_call.completed") {
		accumulator.searchCompleted = true;
		return;
	}
	if (type === "response.output_text.done") {
		const text = stringValue(value.text);
		if (text) accumulator.doneTexts.push(text);
		return;
	}
	if (type === "response.output_text.delta") {
		if (typeof value.delta === "string") accumulator.deltaText += value.delta;
		return;
	}
	if (type === "response.output_text.annotation.added" && isRecord(value.annotation)) {
		const url = stringValue(value.annotation.url);
		if (url) accumulator.sources.push(url);
		return;
	}
	if (type === "response.completed") {
		accumulator.responseCompleted = true;
		return;
	}
	if (type === "response.incomplete") {
		accumulator.failure = {
			ok: false,
			reason: "upstream-incomplete",
			message: nestedMessage(value.response) ?? "The web search response was incomplete.",
		};
		return;
	}
	if (type === "response.failed" || type === "error") {
		accumulator.failure = {
			ok: false,
			reason: "upstream-failed",
			message: nestedMessage(value.response) ?? nestedMessage(value) ?? "The web search response failed.",
		};
	}
}

function consumeSseBlock(block: string, accumulator: SearchAccumulator): void {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") return;
	try {
		consumeResponsesEvent(JSON.parse(data), accumulator);
	} catch {
		// Ignore one malformed event; later terminal events still determine the result.
	}
}

function consumeCompleteSseBlocks(buffer: string, accumulator: SearchAccumulator): string {
	let remainder = buffer;
	for (;;) {
		const match = /\r?\n\r?\n/.exec(remainder);
		if (!match || match.index === undefined) return remainder;
		consumeSseBlock(remainder.slice(0, match.index), accumulator);
		remainder = remainder.slice(match.index + match[0].length);
	}
}

async function parseResponsesStream(body: ReadableStream<Uint8Array>): Promise<SearchAccumulator | WebSearchFailure> {
	const accumulator: SearchAccumulator = {
		queries: [],
		sources: [],
		doneTexts: [],
		deltaText: "",
		searchCompleted: false,
		responseCompleted: false,
	};
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let decodedChars = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const decoded = decoder.decode(value, { stream: true });
		decodedChars += decoded.length;
		if (decodedChars > MAX_SSE_TEXT_CHARS) {
			await reader.cancel();
			return { ok: false, reason: "response-too-large", message: "The web search response exceeded the safety limit." };
		}
		buffer = consumeCompleteSseBlocks(buffer + decoded, accumulator);
	}
	buffer += decoder.decode();
	buffer = consumeCompleteSseBlocks(buffer, accumulator);
	if (buffer.trim()) consumeSseBlock(buffer, accumulator);
	return accumulator;
}

/** Execute the common Responses web-search request used by OpenAI and OpenCodex. */
export async function executeResponsesWebSearch(
	request: WebSearchRequest,
	fetchImpl: typeof fetch = fetch,
): Promise<WebSearchResult> {
	if (request.signal.aborted) return { ok: false, reason: "aborted", message: "Web search was cancelled." };
	let response: Response;
	try {
		response = await fetchImpl(request.runtime.url, {
			method: "POST",
			headers: request.runtime.headers,
			body: JSON.stringify({
				model: request.runtime.model,
				store: false,
				stream: true,
				input: request.query,
				tools: [{ type: "web_search" }],
				tool_choice: { type: "web_search" },
			}),
			signal: request.signal,
		});
	} catch (error) {
		if (request.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
			return { ok: false, reason: "aborted", message: "Web search was cancelled." };
		}
		return { ok: false, reason: "transport-error", message: `Web search request failed: ${errorMessage(error)}` };
	}
	if (!response.ok) {
		const responseText = await response.text().catch(() => "");
		return {
			ok: false,
			reason: "http-error",
			message: responseText.trim() || `Web search upstream returned HTTP ${response.status}.`,
			status: response.status,
		};
	}
	if (!response.body) {
		return { ok: false, reason: "empty-response-body", message: "Web search upstream returned an empty response body." };
	}

	let parsed: SearchAccumulator | WebSearchFailure;
	try {
		parsed = await parseResponsesStream(response.body);
	} catch (error) {
		if (request.signal.aborted) return { ok: false, reason: "aborted", message: "Web search was cancelled." };
		return { ok: false, reason: "invalid-response", message: `Failed to read the web search response: ${errorMessage(error)}` };
	}
	if ("ok" in parsed) return parsed;
	if (parsed.failure) return parsed.failure;
	if (!parsed.responseCompleted) {
		return { ok: false, reason: "invalid-response", message: "Web search ended without a completed Responses terminal." };
	}
	if (!parsed.searchCompleted) {
		return { ok: false, reason: "search-not-executed", message: "The current upstream did not execute the requested web search." };
	}
	const answer = (parsed.doneTexts.length > 0 ? parsed.doneTexts.join("") : parsed.deltaText).trim();
	if (!answer) return { ok: false, reason: "empty-answer", message: "Web search completed without an answer." };
	const queries = unique(parsed.queries);
	return {
		ok: true,
		query: queries[0] ?? request.query,
		queries: queries.length > 0 ? queries : [request.query],
		answer,
		sources: unique(parsed.sources),
	};
}

/** Run the primary backend and invoke an explicitly supplied fallback only on failure. */
export async function runWebSearch(
	request: WebSearchRequest,
	dependencies: WebSearchDependencies = {},
): Promise<WebSearchResult> {
	const primary = await executeResponsesWebSearch(request, dependencies.fetch ?? fetch);
	// Cancellation is a user decision, not an upstream failure eligible for fallback.
	if (primary.ok || primary.reason === "aborted" || !dependencies.fallback) return primary;
	try {
		return await dependencies.fallback.search({ query: request.query, signal: request.signal, primaryFailure: primary });
	} catch (error) {
		return { ok: false, reason: "fallback-failed", message: `Web search fallback failed: ${errorMessage(error)}` };
	}
}

/** Resolve the active upstream first, falling back even when no Responses runtime is available. */
export async function searchWithContext(
	ctx: WebSearchContext,
	query: string,
	signal: AbortSignal,
	dependencies: WebSearchDependencies = {},
): Promise<WebSearchResult> {
	const resolution = await resolveWebSearchRuntime(ctx);
	if (resolution.ok) {
		return runWebSearch({ runtime: resolution.runtime, query, signal }, dependencies);
	}
	if (signal.aborted) return { ok: false, reason: "aborted", message: "Web search was cancelled." };
	if (!dependencies.fallback) return resolution;
	try {
		return await dependencies.fallback.search({ query, signal, primaryFailure: resolution });
	} catch (error) {
		return { ok: false, reason: "fallback-failed", message: `Web search fallback failed: ${errorMessage(error)}` };
	}
}

/** Register PiDeck's default Web Search tool. */
export default function websearch(pi: ExtensionAPI) {
	const fallback = createSequentialWebSearchFallback();
	pi.registerTool({
		name: "web_search",
		label: "PiDeck-Q-WebSearch",
		description:
			"Search the web for current and verifiable information through the active Responses upstream or ordered keyless fallbacks.",
		promptSnippet: "Search the web for current and verifiable information",
		promptGuidelines: [
			"Use web_search when current, time-sensitive, specialized, or externally verifiable information is needed.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "A focused web search query" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query?.trim();
			if (!query) {
				throw new Error("A search query is required.");
			}
			const result = await searchWithContext(ctx, query, signal, { fallback });
			// Pi marks custom tool failures only when execute throws.
			if (!result.ok) throw new Error(`[${result.reason}] ${result.message}`);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { query: result.query, queries: result.queries, sources: result.sources },
			};
		},
	});
}
