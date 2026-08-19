import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const EXTENSION_PATH = "resources/extensions/pi-deck-websearch.ts";

function loadExtension() {
	const source = readFileSync(EXTENSION_PATH, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: EXTENSION_PATH,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier === "typebox") {
			return { Type: { Object: (shape) => shape, String: (options) => options } };
		}
		if (specifier === "./pi-deck-websearch-fallback") {
			return { createSequentialWebSearchFallback: () => ({ async search() { throw new Error("unused default fallback"); } }) };
		}
		return require(specifier);
	};
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		process,
		fetch,
		Headers,
		Response,
		ReadableStream,
		TextDecoder,
		AbortController,
		DOMException,
	}, { filename: EXTENSION_PATH });
	return module.exports;
}

const extension = loadExtension();

function streamResponse(chunks, status = 200) {
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	}), { status, headers: { "content-type": "text/event-stream" } });
}

function event(data, newline = "\n") {
	return `data: ${JSON.stringify(data)}${newline}${newline}`;
}

const runtime = {
	api: "openai-responses",
	model: "gpt-5.6-luna",
	url: "https://api.example.test/v1/responses",
	headers: { authorization: "Bearer test", "content-type": "application/json" },
};

test("resolveWebSearchRuntime uses the current Responses model and registry auth", async () => {
	let resolvedModel;
	const model = {
		provider: "OpenCodex",
		api: "openai-responses",
		id: "xai/grok-4.6",
		baseUrl: "http://127.0.0.1:10100/v1/",
		headers: { "User-Agent": "PiDeck", "X-Model-Route": "native" },
	};
	const result = await extension.resolveWebSearchRuntime({
		model,
		modelRegistry: {
			headerValue: "yes",
			async getApiKeyAndHeaders(value) {
				resolvedModel = value;
				return { ok: true, apiKey: "proxy-key", headers: { "x-extra": this.headerValue } };
			},
		},
	});
	assert.equal(result.ok, true);
	assert.equal(resolvedModel, model);
	assert.equal(result.runtime.model, "xai/grok-4.6");
	assert.equal(result.runtime.url, "http://127.0.0.1:10100/v1/responses");
	assert.equal(result.runtime.headers.authorization, "Bearer proxy-key");
	assert.equal(result.runtime.headers["x-extra"], "yes");
	assert.equal(result.runtime.headers["user-agent"], "PiDeck");
	assert.equal(result.runtime.headers["x-model-route"], "native");
});

test("OpenAI SSE succeeds only after a completed web_search_call", async () => {
	let request;
	const payload = [
		event({ type: "response.output_item.done", item: { type: "web_search_call", status: "completed", action: { query: "Pi Agent" } } }, "\r\n"),
		event({ type: "response.output_text.annotation.added", annotation: { url: "https://example.com/a" } }, "\r\n"),
		event({ type: "response.output_text.done", text: "Verified answer" }, "\r\n"),
		`data: ${JSON.stringify({ type: "response.completed" })}`,
	].join("");
	const result = await extension.executeResponsesWebSearch(
		{ runtime, query: "Pi Agent", signal: new AbortController().signal },
		async (url, options) => {
			request = { url, options };
			return streamResponse([payload.slice(0, 31), payload.slice(31, 89), payload.slice(89)]);
		},
	);
	assert.equal(result.ok, true);
	assert.equal(result.answer, "Verified answer");
	assert.equal(JSON.stringify(result.sources), JSON.stringify(["https://example.com/a"]));
	assert.equal(request.url, runtime.url);
	const body = JSON.parse(request.options.body);
	assert.equal(body.model, runtime.model);
	assert.equal(body.tools[0].type, "web_search");
	assert.equal(body.tool_choice.type, "web_search");
});

test("OpenCodex SSE accepts action.queries and item.sources", async () => {
	const payload = [
		event({
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				status: "completed",
				action: { type: "search", queries: ["query one", "query two"] },
				sources: [{ url: "https://example.com/one" }, { url: "https://example.com/two" }],
			},
		}),
		event({ type: "response.output_text.done", text: "OpenCodex answer" }),
		event({ type: "response.completed" }),
	].join("");
	const result = await extension.executeResponsesWebSearch(
		{ runtime, query: "original", signal: new AbortController().signal },
		async () => streamResponse([payload]),
	);
	assert.equal(result.ok, true);
	assert.equal(JSON.stringify(result.queries), JSON.stringify(["query one", "query two"]));
	assert.equal(JSON.stringify(result.sources), JSON.stringify(["https://example.com/one", "https://example.com/two"]));
});

test("a successful response without web_search_call is not accepted as search", async () => {
	const payload = [
		event({ type: "response.output_text.done", text: "Unverified model answer" }),
		event({ type: "response.completed" }),
	].join("");
	const result = await extension.executeResponsesWebSearch(
		{ runtime, query: "current news", signal: new AbortController().signal },
		async () => streamResponse([payload]),
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "search-not-executed");
});

test("an incomplete Responses terminal is returned as a structured failure", async () => {
	const payload = event({ type: "response.incomplete", response: { incomplete_details: { reason: "upstream_stall" } } });
	const result = await extension.executeResponsesWebSearch(
		{ runtime, query: "current news", signal: new AbortController().signal },
		async () => streamResponse([payload]),
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "upstream-incomplete");
});

test("runWebSearch invokes an explicitly supplied fallback after primary failure", async () => {
	let fallbackCalls = 0;
	const fallback = {
		async search(request) {
			fallbackCalls += 1;
			assert.equal(request.primaryFailure.reason, "search-not-executed");
			return { ok: true, query: request.query, queries: [request.query], answer: "fallback", sources: [] };
		},
	};
	const primaryFetch = async () => streamResponse([
		event({ type: "response.output_text.done", text: "No tool" }),
		event({ type: "response.completed" }),
	].join(""));
	const withoutFallback = await extension.runWebSearch(
		{ runtime, query: "q", signal: new AbortController().signal },
		{ fetch: primaryFetch },
	);
	assert.equal(withoutFallback.ok, false);
	assert.equal(fallbackCalls, 0);
	const withFallback = await extension.runWebSearch(
		{ runtime, query: "q", signal: new AbortController().signal },
		{ fetch: primaryFetch, fallback },
	);
	assert.equal(withFallback.ok, true);
	assert.equal(withFallback.answer, "fallback");
	assert.equal(fallbackCalls, 1);
});

test("runWebSearch never invokes fallback after user cancellation", async () => {
	let fallbackCalls = 0;
	const controller = new AbortController();
	controller.abort();
	const result = await extension.runWebSearch(
		{ runtime, query: "q", signal: controller.signal },
		{ fallback: { async search() { fallbackCalls += 1; } } },
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "aborted");
	assert.equal(fallbackCalls, 0);
});

test("searchWithContext can fallback before a Responses runtime is available", async () => {
	let fallbackCalls = 0;
	const result = await extension.searchWithContext(
		{
			model: { provider: "anthropic", api: "anthropic-messages", id: "claude" },
			modelRegistry: {},
		},
		"current information",
		new AbortController().signal,
		{
			fallback: {
				async search(request) {
					fallbackCalls += 1;
					assert.equal(request.primaryFailure.reason, "unsupported-api");
					return { ok: true, query: request.query, queries: [request.query], answer: "fallback", sources: [] };
				},
			},
		},
	);
	assert.equal(result.ok, true);
	assert.equal(fallbackCalls, 1);
});

test("registered tool uses the unified web_search contract", () => {
	let tool;
	extension.default({ registerTool(value) { tool = value; } });
	assert.equal(tool.name, "web_search");
	assert.equal(tool.label, "PiDeck-Q-WebSearch");
	assert.ok(tool.parameters.query);
});

test("registered tool throws failures so Pi marks the result as an error", async () => {
	let tool;
	extension.default({ registerTool(value) { tool = value; } });
	await assert.rejects(
		tool.execute("call", { query: "" }, new AbortController().signal, () => {}, {
			modelRegistry: {},
		}),
		/search query is required/i,
	);
	await assert.rejects(
		tool.execute("call", { query: "news" }, new AbortController().signal, () => {}, {
			model: { provider: "anthropic", api: "anthropic-messages", id: "claude" },
			modelRegistry: {},
		}),
		/fallback-failed/i,
	);
});
