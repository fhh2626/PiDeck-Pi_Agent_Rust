/** Lightweight ordered fallback providers for PiDeck Web Search. */
import type {
	WebSearchFallback,
	WebSearchFallbackRequest,
	WebSearchResult,
} from "./extension-runtime";

const MAX_RESULTS = 5;
const MAX_BODY_CHARS = 2_000_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const HTML_HEADERS = {
	accept: "text/html,application/xhtml+xml",
	"accept-language": "en-US,en;q=0.8",
	"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
};

type SearchResultItem = { title: string; url: string; snippet: string };
type FallbackProvider = {
	name: string;
	search(query: string, signal: AbortSignal): Promise<SearchResultItem[]>;
};
type SequentialFallbackOptions = { providerTimeoutMs?: number };
type TextResponse = { response: Response; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeHtml(value: string): string {
	return value
		.replace(/<!--([\s\S]*?)-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.replace(/\s+([.,;:!?])/g, "$1")
		.trim();
}

function attribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(attributes);
	return match?.[2];
}

function decodeBingTarget(value: string): string | undefined {
	if (!value.startsWith("a1")) return undefined;
	try {
		const encoded = value.slice(2).replace(/-/g, "+").replace(/_/g, "/");
		const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

function validHttpUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function normalizeResultUrl(rawValue: string, provider: "duckduckgo" | "bing" | "brave"): string | undefined {
	const decoded = decodeHtml(rawValue);
	const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
	let url: URL;
	try {
		url = new URL(absolute);
	} catch {
		return undefined;
	}

	if (provider === "duckduckgo" && url.hostname.endsWith("duckduckgo.com")) {
		const target = url.searchParams.get("uddg");
		const normalizedTarget = target ? validHttpUrl(target) : undefined;
		if (!normalizedTarget) return undefined;
		// DuckDuckGo ads redirect through its own y.js endpoint; do not expose it as a source.
		return new URL(normalizedTarget).hostname.endsWith("duckduckgo.com") ? undefined : normalizedTarget;
	}
	if (provider === "bing" && url.hostname.endsWith("bing.com") && url.pathname.startsWith("/ck/")) {
		const target = url.searchParams.get("u");
		return target ? validHttpUrl(decodeBingTarget(target) ?? "") : undefined;
	}
	return validHttpUrl(url.toString());
}

function uniqueResults(results: readonly SearchResultItem[]): SearchResultItem[] {
	const seen = new Set<string>();
	const unique: SearchResultItem[] = [];
	for (const result of results) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		unique.push(result);
		if (unique.length >= MAX_RESULTS) break;
	}
	return unique;
}

/** Parse DuckDuckGo's intentionally minimal HTML results page. */
export function parseDuckDuckGoResults(html: string): SearchResultItem[] {
	const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
		.filter((match) => (attribute(match[1] ?? "", "class") ?? "").split(/\s+/).includes("result__a"));
	const results: SearchResultItem[] = [];
	for (let index = 0; index < anchors.length; index += 1) {
		const match = anchors[index];
		const href = attribute(match[1] ?? "", "href");
		const url = href ? normalizeResultUrl(href, "duckduckgo") : undefined;
		const title = decodeHtml(match[2] ?? "");
		if (!url || !title) continue;
		const start = (match.index ?? 0) + match[0].length;
		const end = anchors[index + 1]?.index ?? html.length;
		const snippetMatch = /<(?:a|div)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(html.slice(start, end));
		results.push({ title, url, snippet: decodeHtml(snippetMatch?.[1] ?? "") });
	}
	return uniqueResults(results);
}

/** Parse Bing's regular result list and unwrap its encoded redirect URLs. */
export function parseBingResults(html: string): SearchResultItem[] {
	const results: SearchResultItem[] = [];
	for (const match of html.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
		const block = match[1] ?? "";
		const titleMatch = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block);
		const href = attribute(titleMatch?.[1] ?? "", "href");
		const url = href ? normalizeResultUrl(href, "bing") : undefined;
		const title = decodeHtml(titleMatch?.[2] ?? "");
		if (!url || !title) continue;
		const snippet = decodeHtml(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "");
		results.push({ title, url, snippet });
	}
	return uniqueResults(results);
}

/** Parse Brave Search's server-rendered web result snippets. */
export function parseBraveResults(html: string): SearchResultItem[] {
	const openings = [...html.matchAll(/<div\b(?=[^>]*\bclass=["'][^"']*\bsnippet\b)(?=[^>]*\bdata-type=["']web["'])[^>]*>/gi)];
	const results: SearchResultItem[] = [];
	for (let index = 0; index < openings.length; index += 1) {
		const start = openings[index].index ?? 0;
		const end = openings[index + 1]?.index ?? html.length;
		const block = html.slice(start, end);
		const linkMatch = /<a\b([^>]*)>[\s\S]*?<div\b[^>]*class=["'][^"']*\bsearch-snippet-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
		const href = attribute(linkMatch?.[1] ?? "", "href");
		const url = href ? normalizeResultUrl(href, "brave") : undefined;
		const title = decodeHtml(linkMatch?.[2] ?? "");
		if (!url || !title) continue;
		const snippet = decodeHtml(/<div\b[^>]*class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? "");
		results.push({ title, url, snippet });
	}
	return uniqueResults(results);
}

/** Parse both current v2 keyless shape and the older flat data array defensively. */
export function parseFirecrawlResults(payload: unknown): SearchResultItem[] {
	if (!isRecord(payload) || payload.success !== true) return [];
	const data = payload.data;
	const entries = Array.isArray(data)
		? data
		: isRecord(data) && Array.isArray(data.web)
			? data.web
			: [];
	const results: SearchResultItem[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const url = stringValue(entry.url);
		const title = stringValue(entry.title);
		const normalizedUrl = url ? validHttpUrl(url) : undefined;
		if (!normalizedUrl || !title) continue;
		const rawSnippet = stringValue(entry.description) ?? stringValue(entry.snippet) ?? stringValue(entry.markdown) ?? "";
		results.push({ title, url: normalizedUrl, snippet: rawSnippet.slice(0, 600).trim() });
	}
	return uniqueResults(results);
}

async function readLimitedText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let result = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
		if (result.length > MAX_BODY_CHARS) {
			await reader.cancel();
			throw new Error("response exceeded the fallback body limit");
		}
	}
	return result + decoder.decode();
}

function requestTextWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	parentSignal: AbortSignal,
	timeoutMs: number,
): Promise<TextResponse> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		let settled = false;
		const cleanup = () => {
			clearTimeout(timeout);
			parentSignal.removeEventListener("abort", onAbort);
		};
		const succeed = (value: TextResponse) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			controller.abort();
			fail(new Error("fallback request aborted"));
		};
		const timeout = setTimeout(() => {
			controller.abort();
			fail(new Error("fallback provider timed out"));
		}, timeoutMs);
		parentSignal.addEventListener("abort", onAbort, { once: true });
		if (parentSignal.aborted) {
			onAbort();
			return;
		}
		fetchImpl(url, { ...init, signal: controller.signal })
			.then(async (response) => ({
				response,
				text: response.ok ? await readLimitedText(response) : "",
			}))
			.then(succeed, (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
	});
}

function htmlProvider(
	name: string,
	baseUrl: string,
	parser: (html: string) => SearchResultItem[],
	fetchImpl: typeof fetch,
	timeoutMs: number,
): FallbackProvider {
	return {
		name,
		async search(query, signal) {
			const { response, text } = await requestTextWithTimeout(fetchImpl, `${baseUrl}${encodeURIComponent(query)}`, {
				method: "GET",
				headers: HTML_HEADERS,
				redirect: "follow",
			}, signal, timeoutMs);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return parser(text);
		},
	};
}

function firecrawlProvider(fetchImpl: typeof fetch, timeoutMs: number): FallbackProvider {
	return {
		name: "Firecrawl Keyless",
		async search(query, signal) {
			const { response, text } = await requestTextWithTimeout(fetchImpl, "https://api.firecrawl.dev/v2/search", {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify({ query, limit: MAX_RESULTS, sources: ["web"] }),
			}, signal, timeoutMs);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return parseFirecrawlResults(JSON.parse(text));
		},
	};
}

function formatAnswer(provider: string, results: readonly SearchResultItem[]): string {
	const lines = [`Search results from ${provider}:`];
	results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	});
	return lines.join("\n");
}

/** Create the fixed fallback chain: DuckDuckGo, Bing, Brave, then Firecrawl Keyless. */
export function createSequentialWebSearchFallback(
	fetchImpl: typeof fetch = fetch,
	options: SequentialFallbackOptions = {},
): WebSearchFallback {
	const configuredTimeout = options.providerTimeoutMs;
	const timeoutMs = typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: PROVIDER_TIMEOUT_MS;
	const providers: FallbackProvider[] = [
		htmlProvider("DuckDuckGo", "https://html.duckduckgo.com/html/?q=", parseDuckDuckGoResults, fetchImpl, timeoutMs),
		htmlProvider("Bing", "https://www.bing.com/search?q=", parseBingResults, fetchImpl, timeoutMs),
		htmlProvider("Brave Search", "https://search.brave.com/search?q=", parseBraveResults, fetchImpl, timeoutMs),
		firecrawlProvider(fetchImpl, timeoutMs),
	];
	return {
		async search(request: WebSearchFallbackRequest): Promise<WebSearchResult> {
			if (request.signal.aborted) return { ok: false, reason: "aborted", message: "Web search was cancelled." };
			const failures: string[] = [];
			for (const provider of providers) {
				if (request.signal.aborted) return { ok: false, reason: "aborted", message: "Web search was cancelled." };
				try {
					const results = await provider.search(request.query, request.signal);
					if (results.length === 0) {
						failures.push(`${provider.name}: no results`);
						continue;
					}
					return {
						ok: true,
						query: request.query,
						queries: [request.query],
						answer: formatAnswer(provider.name, results),
						sources: results.map((result) => result.url),
					};
				} catch (error) {
					if (request.signal.aborted) return { ok: false, reason: "aborted", message: "Web search was cancelled." };
					failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return {
				ok: false,
				reason: "fallback-failed",
				message: `All web search fallbacks failed (${failures.join("; ")}).`,
			};
		},
	};
}
