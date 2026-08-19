import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const FALLBACK_PATH = "resources/extensions/pi-deck-websearch-fallback.ts";

function loadFallback() {
	const source = readFileSync(FALLBACK_PATH, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: FALLBACK_PATH,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		console,
		fetch,
		Response,
		Headers,
		URL,
		TextDecoder,
		AbortController,
		setTimeout,
		clearTimeout,
		atob,
	}, { filename: FALLBACK_PATH });
	return module.exports;
}

const fallback = loadFallback();

function htmlResponse(body, status = 200) {
	return new Response(body, { status, headers: { "content-type": "text/html" } });
}

test("search HTML parsers extract stable result fields and unwrap redirects", () => {
	const duck = fallback.parseDuckDuckGoResults(`
		<div class="result result--ad">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dexample.com">Advertisement</a>
			<a class="result__snippet">Sponsored result.</a>
		</div>
		<div class="result results_links">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Example &amp; Docs</a>
			<a class="result__snippet">A <b>useful</b> result.</a>
		</div>`);
	assert.equal(duck[0].url, "https://example.com/docs");
	assert.equal(duck[0].title, "Example & Docs");
	assert.equal(duck[0].snippet, "A useful result.");
	assert.equal(duck.length, 1);

	const bingTarget = "https://openai.com/";
	const encodedTarget = `a1${Buffer.from(bingTarget).toString("base64url")}`;
	const bing = fallback.parseBingResults(`
		<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encodedTarget}"><strong>OpenAI</strong></a></h2>
		<div class="b_caption"><p>Research &amp; deployment.</p></div></li>`);
	assert.equal(bing[0].url, bingTarget);
	assert.equal(bing[0].title, "OpenAI");

	const brave = fallback.parseBraveResults(`
		<div class="snippet x" data-type="web"><a href="https://brave.com/search/">
		<div class="title search-snippet-title">Brave Search</div></a>
		<div class="generic-snippet"><div class="content">Private <strong>search</strong>.</div></div></div>`);
	assert.equal(brave[0].url, "https://brave.com/search/");
	assert.equal(brave[0].snippet, "Private search.");
});

test("sequential fallback stops at the first provider with useful results", async () => {
	const calls = [];
	const client = fallback.createSequentialWebSearchFallback(async (url) => {
		calls.push(String(url));
		if (String(url).startsWith("https://html.duckduckgo.com/")) return htmlResponse("no results");
		if (String(url).startsWith("https://www.bing.com/")) return htmlResponse("blocked", 403);
		if (String(url).startsWith("https://search.brave.com/")) {
			return htmlResponse(`<div class="snippet" data-type="web"><a href="https://example.com/"><div class="title search-snippet-title">Example</div></a><div class="generic-snippet"><div class="content">Answer</div></div></div>`);
		}
		throw new Error("Firecrawl must not run");
	});
	const result = await client.search({
		query: "OpenAI",
		signal: new AbortController().signal,
		primaryFailure: { ok: false, reason: "unsupported-api", message: "unsupported" },
	});
	assert.equal(result.ok, true);
	assert.match(result.answer, /Brave Search/);
	assert.equal(JSON.stringify(result.sources), JSON.stringify(["https://example.com/"]));
	assert.equal(calls.length, 3);
	assert.match(calls[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=OpenAI$/);
	assert.match(calls[1], /^https:\/\/www\.bing\.com\/search\?q=OpenAI$/);
	assert.match(calls[2], /^https:\/\/search\.brave\.com\/search\?q=OpenAI$/);
});

test("Firecrawl keyless is last and sends no authorization header", async () => {
	const calls = [];
	const client = fallback.createSequentialWebSearchFallback(async (url, options = {}) => {
		calls.push({ url: String(url), options });
		if (!String(url).startsWith("https://api.firecrawl.dev/")) return htmlResponse("empty");
		return Response.json({
			success: true,
			data: { web: [{ title: "Firecrawl", description: "Keyless result", url: "https://firecrawl.dev/" }] },
		});
	});
	const result = await client.search({
		query: "firecrawl",
		signal: new AbortController().signal,
		primaryFailure: { ok: false, reason: "search-not-executed", message: "missing" },
	});
	assert.equal(result.ok, true);
	assert.match(result.answer, /Firecrawl Keyless/);
	assert.equal(calls.length, 4);
	const firecrawl = calls[3];
	assert.equal(firecrawl.url, "https://api.firecrawl.dev/v2/search");
	assert.equal(firecrawl.options.method, "POST");
	assert.equal(new Headers(firecrawl.options.headers).has("authorization"), false);
	assert.equal(JSON.parse(firecrawl.options.body).query, "firecrawl");
});

test("sequential fallback stops immediately when cancelled", async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort();
	const client = fallback.createSequentialWebSearchFallback(async () => {
		calls += 1;
		return htmlResponse("unused");
	});
	const result = await client.search({
		query: "cancelled",
		signal: controller.signal,
		primaryFailure: { ok: false, reason: "transport-error", message: "failed" },
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "aborted");
	assert.equal(calls, 0);
});

test("provider timeout covers a response body that never finishes", async () => {
	const calls = [];
	const client = fallback.createSequentialWebSearchFallback(async (url) => {
		calls.push(String(url));
		if (String(url).startsWith("https://html.duckduckgo.com/")) {
			return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }));
		}
		if (String(url).startsWith("https://www.bing.com/")) {
			return htmlResponse(`<li class="b_algo"><h2><a href="https://example.com/">Example</a></h2><p>Recovered</p></li>`);
		}
		throw new Error("later providers must not run");
	}, { providerTimeoutMs: 20 });
	const result = await client.search({
		query: "timeout",
		signal: new AbortController().signal,
		primaryFailure: { ok: false, reason: "transport-error", message: "failed" },
	});
	assert.equal(result.ok, true);
	assert.match(result.answer, /Bing/);
	assert.equal(calls.length, 2);
});
