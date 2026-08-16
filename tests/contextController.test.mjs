import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function sameJson(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function loadContextControllerModule() {
	const source = readFileSync("resources/extensions/pi-deck-context-controller.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "pi-deck-context-controller.ts",
	});
	const sandbox = {
		exports: {},
		module: { exports: {} },
		require,
		console,
		process,
		Buffer,
	};
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(outputText, sandbox, { filename: "pi-deck-context-controller.ts" });
	return sandbox.module.exports;
}

function sampleMessages() {
	return [
		{ role: "user", content: "请读取 config.json 并跑测试" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先读文件再跑测试" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.json", offset: 1, limit: 40 } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: '{"port":3000}'.repeat(40) }],
		},
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "npm test" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_2",
			content: [{ type: "text", text: "PASS tests\n".repeat(80) }],
		},
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "可以改了" },
				{ type: "text", text: "端口已经改成 8080。" },
			],
		},
	];
}

const ALL_ON = { clearToolHistory: false, clearReadContent: false, clearCommandContent: false };

test("default state keeps the full context", () => {
	const { DEFAULT_STATE, normalizeState } = loadContextControllerModule();
	sameJson(DEFAULT_STATE, ALL_ON);
	sameJson(normalizeState(undefined), ALL_ON);
});

test("turning history off also drops both content switches", () => {
	const { applyIncludeSwitch } = loadContextControllerModule();
	sameJson(applyIncludeSwitch(ALL_ON, "clearToolHistory", false), {
		clearToolHistory: true,
		clearReadContent: true,
		clearCommandContent: true,
	});
});

test("turning history on only restores the master switch", () => {
	const { applyIncludeSwitch } = loadContextControllerModule();
	sameJson(
		applyIncludeSwitch(
			{ clearToolHistory: true, clearReadContent: true, clearCommandContent: true },
			"clearToolHistory",
			true,
		),
		{ clearToolHistory: false, clearReadContent: true, clearCommandContent: true },
	);
});

test("turning file or command on also opens history", () => {
	const { applyIncludeSwitch } = loadContextControllerModule();
	sameJson(
		applyIncludeSwitch(
			{ clearToolHistory: true, clearReadContent: true, clearCommandContent: true },
			"clearReadContent",
			true,
		),
		{ clearToolHistory: false, clearReadContent: false, clearCommandContent: true },
	);
	sameJson(
		applyIncludeSwitch(
			{ clearToolHistory: false, clearReadContent: false, clearCommandContent: false },
			"clearCommandContent",
			false,
		),
		{ clearToolHistory: false, clearReadContent: false, clearCommandContent: true },
	);
});

test("filter keeps the full list when all strip switches are off", () => {
	const { filterContextMessages, DEFAULT_STATE } = loadContextControllerModule();
	const messages = sampleMessages();
	assert.equal(filterContextMessages(messages, DEFAULT_STATE).length, messages.length);
});

test("clearReadContent stubs only read results and keeps the path", () => {
	const { filterContextMessages } = loadContextControllerModule();
	const filtered = filterContextMessages(sampleMessages(), {
		clearToolHistory: false,
		clearReadContent: true,
		clearCommandContent: false,
	});
	assert.equal(filtered.length, 6);
	assert.equal(filtered[2].role, "toolResult");
	assert.equal(filtered[2].content[0].text, "[File content omitted: config.json (lines 1-40)]");
	assert.match(filtered[4].content[0].text, /PASS tests/);
	assert.equal(filtered[1].content.some((block) => block.type === "toolCall"), true);
});

test("clearCommandContent stubs non-read results including bash without toolName", () => {
	const { filterContextMessages } = loadContextControllerModule();
	const filtered = filterContextMessages(sampleMessages(), {
		clearToolHistory: false,
		clearReadContent: false,
		clearCommandContent: true,
	});
	assert.match(filtered[2].content[0].text, /port/);
	assert.equal(filtered[4].content[0].text, "[Command output omitted: npm test]");
});

test("websearch and webfetch follow the command-output switch", () => {
	const { filterContextMessages, formatOmittedToolResult } = loadContextControllerModule();
	assert.equal(formatOmittedToolResult("websearch", { query: "pi rpc" }), `[Web search omitted: "pi rpc"]`);
	assert.equal(formatOmittedToolResult("webfetch", { url: "https://example.com" }), "[Web fetch omitted: https://example.com]");

	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "w1", name: "websearch", arguments: { query: "pi rpc" } }],
		},
		{ role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "lots of search hits" }] },
	];
	const filtered = filterContextMessages(messages, {
		clearToolHistory: false,
		clearReadContent: true,
		clearCommandContent: true,
	});
	assert.equal(filtered[1].content[0].text, `[Web search omitted: "pi rpc"]`);
});

test("clearToolHistory removes toolResult and tool-only assistant turns", () => {
	const { filterContextMessages } = loadContextControllerModule();
	const filtered = filterContextMessages(sampleMessages(), {
		clearToolHistory: true,
		clearReadContent: true,
		clearCommandContent: true,
	});
	assert.equal(filtered.some((message) => message.role === "toolResult"), false);
	assert.equal(filtered.some((message) =>
		Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"),
	), false);
	assert.equal(filtered.length, 2);
	assert.equal(filtered[0].role, "user");
	assert.equal(filtered[1].content.some((block) => block.type === "thinking"), true);
});

test("session snapshot overrides the global fallback", () => {
	const { restoreStateFromEntries, DEFAULT_STATE } = loadContextControllerModule();
	const restored = restoreStateFromEntries([
		{ type: "custom", customType: "other", data: { clearToolHistory: true } },
		{ type: "custom", customType: "pi-deck-context-controller", data: { clearReadContent: true } },
		{ type: "custom", customType: "pi-deck-context-controller", data: { clearToolHistory: true, clearCommandContent: true } },
	], DEFAULT_STATE);
	sameJson(restored, { clearToolHistory: true, clearReadContent: true, clearCommandContent: true });
});

test("on/off args are explicit and do not invert", () => {
	const { parseOnOffArg } = loadContextControllerModule();
	assert.equal(parseOnOffArg("on"), true);
	assert.equal(parseOnOffArg("off"), false);
	assert.equal(parseOnOffArg(""), null);
	assert.equal(parseOnOffArg("true"), null);
	assert.equal(parseOnOffArg("ON"), true);
});

test("widget first line is the estimated usage so the chip shows it immediately", () => {
	const { buildWidgetLines, formatCompactTokens, formatUsageLine } = loadContextControllerModule();
	assert.equal(formatCompactTokens(1200), "1.2k");
	assert.equal(formatCompactTokens(128000), "128k");
	assert.equal(formatUsageLine({ filteredTokens: 12400, savedTokens: 0, percentSaved: 0, contextWindow: 128000 }), "~12k/128k 9.7%");
	sameJson(
		buildWidgetLines(ALL_ON, { filteredTokens: 12400, savedTokens: 0, percentSaved: 0, contextWindow: 128000 }),
		["~12k/128k 9.7%", "Tool history ON", "File content ON", "Command output ON"],
	);
	sameJson(
		buildWidgetLines(
			{ clearToolHistory: true, clearReadContent: true, clearCommandContent: true },
			{ filteredTokens: 2100, savedTokens: 10300, percentSaved: 83, contextWindow: 128000 },
		),
		["~2.1k/128k 1.6%", "Tool history OFF", "File content OFF", "Command output OFF", "Saved ~10k (83%)"],
	);
});

test("status helper reports include flags for the current chat", () => {
	const { getContextControllerStatus, formatStatusText, DEFAULT_STATE } = loadContextControllerModule();
	sameJson(getContextControllerStatus(DEFAULT_STATE), {
		toolHistory: "on",
		fileContent: "on",
		commandOutput: "on",
	});
	assert.equal(
		formatStatusText(getContextControllerStatus(DEFAULT_STATE)),
		"tool-history on | file-content on | command-output on",
	);
	sameJson(
		getContextControllerStatus({ clearToolHistory: false, clearReadContent: true, clearCommandContent: false }),
		{ toolHistory: "on", fileContent: "off", commandOutput: "on" },
	);
});

test("slash commands use the three-switch names", () => {
	const source = readFileSync("resources/extensions/pi-deck-context-controller.ts", "utf8");
	assert.match(source, /registerCommand\("context-tools"/);
	assert.match(source, /registerCommand\("context-files"/);
	assert.match(source, /registerCommand\("context-commands"/);
	assert.match(source, /registerCommand\("context-status"/);
	assert.doesNotMatch(source, /registerCommand\("context-tool-content"/);
	assert.doesNotMatch(source, /registerCommand\("ctx-tools"/);
});

test("command off immediately shrinks the widget estimate and snapshots the session", () => {
	const {
		DEFAULT_STATE,
		filterContextMessages,
		summarizeFilter,
		buildWidgetLines,
		restoreStateFromEntries,
		parseOnOffArg,
		applyIncludeSwitch,
	} = loadContextControllerModule();
	const messages = sampleMessages();
	const full = summarizeFilter(messages, DEFAULT_STATE);
	const afterOff = applyIncludeSwitch(DEFAULT_STATE, "clearCommandContent", parseOnOffArg("off"));
	const stripped = summarizeFilter(messages, afterOff);
	assert.ok(stripped.filteredTokens < full.filteredTokens);
	assert.ok(stripped.savedTokens > 0);
	assert.equal(filterContextMessages(messages, afterOff)[4].content[0].text, "[Command output omitted: npm test]");

	const lines = buildWidgetLines(afterOff, { ...stripped, contextWindow: 128000 });
	assert.match(lines[0], /^~/);
	assert.equal(lines[1], "Tool history ON");
	assert.equal(lines[2], "File content ON");
	assert.equal(lines[3], "Command output OFF");

	const restored = restoreStateFromEntries([
		{ type: "custom", customType: "pi-deck-context-controller", data: afterOff },
	], DEFAULT_STATE);
	sameJson(restored, afterOff);
});

test("a session without its own snapshot does not inherit another chat's off state", () => {
	const { restoreStateFromEntries, DEFAULT_STATE } = loadContextControllerModule();
	sameJson(restoreStateFromEntries([], DEFAULT_STATE), DEFAULT_STATE);
});

test("desktop maps the context-controller widget and excludes it from left chips", () => {
	const chips = readFileSync("src/renderer/src/components/session/SessionWidgetChips.tsx", "utf8");
	const titles = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const switches = readFileSync("src/renderer/src/components/session/ContextControllerSwitches.tsx", "utf8");
	assert.match(titles, /pi-deck-context-controller/);
	assert.match(titles, /app\.widgetTitleContext/);
	assert.match(chips, /widgetKey\s*!==\s*"pi-deck-context-controller"/);
	assert.match(switches, /pi-deck-context-controller/);
	assert.match(switches, /\/context-files/);
	assert.match(switches, /\/context-commands/);
});
