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
		{ role: "user", content: "请读取 config.json 并改端口" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先读文件再改" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.json" } },
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
				{ type: "thinking", thinking: "可以改了" },
				{ type: "text", text: "端口已经改成 8080。" },
			],
		},
	];
}

const OFF = { clearToolContent: false, clearToolHistory: false };

test("default state keeps the full context", () => {
	const { DEFAULT_STATE, normalizeState } = loadContextControllerModule();
	sameJson(DEFAULT_STATE, OFF);
	sameJson(normalizeState(undefined), OFF);
});

test("turning history off also drops content; turning content on restores history", () => {
	const { applyIncludeSwitch } = loadContextControllerModule();
	sameJson(applyIncludeSwitch(OFF, "clearToolHistory", false), {
		clearToolContent: true,
		clearToolHistory: true,
	});
	sameJson(applyIncludeSwitch({ clearToolContent: true, clearToolHistory: true }, "clearToolContent", true), OFF);
});

test("turning content off leaves history included; turning history on only restores history", () => {
	const { applyIncludeSwitch } = loadContextControllerModule();
	sameJson(applyIncludeSwitch(OFF, "clearToolContent", false), {
		clearToolContent: true,
		clearToolHistory: false,
	});
	sameJson(
		applyIncludeSwitch({ clearToolContent: true, clearToolHistory: true }, "clearToolHistory", true),
		{ clearToolContent: true, clearToolHistory: false },
	);
});

test("legacy includeTools / clearAll snapshots migrate to history strip", () => {
	const { normalizeState } = loadContextControllerModule();
	sameJson(normalizeState({ includeTools: false }), {
		clearToolContent: true,
		clearToolHistory: true,
	});
	sameJson(normalizeState({ clearAll: true }), {
		clearToolContent: true,
		clearToolHistory: true,
	});
});

test("filter keeps the full list when all strip switches are off", () => {
	const { filterContextMessages, DEFAULT_STATE } = loadContextControllerModule();
	const messages = sampleMessages();
	assert.equal(filterContextMessages(messages, DEFAULT_STATE).length, messages.length);
});

test("clearToolContent stubs toolResult but keeps toolCall history", () => {
	const { filterContextMessages } = loadContextControllerModule();
	const filtered = filterContextMessages(sampleMessages(), {
		clearToolContent: true,
		clearToolHistory: false,
	});
	assert.equal(filtered.length, 4);
	assert.equal(filtered[2].role, "toolResult");
	assert.equal(filtered[2].content[0].text, "[Tool output omitted]");
	assert.equal(filtered[1].content.some((block) => block.type === "toolCall"), true);
	assert.equal(filtered[1].content.some((block) => block.type === "thinking"), true);
});

test("clearToolHistory removes toolResult and tool-only assistant turns", () => {
	const { filterContextMessages } = loadContextControllerModule();
	const filtered = filterContextMessages(sampleMessages(), {
		clearToolContent: true,
		clearToolHistory: true,
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
		{ type: "custom", customType: "pi-deck-context-controller", data: { clearToolContent: true } },
		{ type: "custom", customType: "pi-deck-context-controller", data: { clearToolHistory: true } },
	], DEFAULT_STATE);
	sameJson(restored, { clearToolContent: true, clearToolHistory: true });
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
		buildWidgetLines(OFF, { filteredTokens: 12400, savedTokens: 0, percentSaved: 0, contextWindow: 128000 }),
		["~12k/128k 9.7%", "Tool content ON", "Tool history ON"],
	);
	sameJson(
		buildWidgetLines(
			{ clearToolContent: true, clearToolHistory: true },
			{ filteredTokens: 2100, savedTokens: 10300, percentSaved: 83, contextWindow: 128000 },
		),
		["~2.1k/128k 1.6%", "Tool content OFF", "Tool history OFF", "Saved ~10k (83%)"],
	);
});

test("status helper reports include flags for the current chat", () => {
	const { getContextControllerStatus, formatStatusText, DEFAULT_STATE } = loadContextControllerModule();
	sameJson(getContextControllerStatus(DEFAULT_STATE), { toolContent: "on", toolHistory: "on" });
	assert.equal(formatStatusText(getContextControllerStatus(DEFAULT_STATE)), "tool-content on | tool-history on");
	sameJson(
		getContextControllerStatus({ clearToolContent: true, clearToolHistory: false }),
		{ toolContent: "off", toolHistory: "on" },
	);
});

test("slash command for content strip is named context-tool-content", () => {
	const source = readFileSync("resources/extensions/pi-deck-context-controller.ts", "utf8");
	assert.match(source, /registerCommand\("context-tool-content"/);
	assert.match(source, /registerCommand\("context-status"/);
	assert.doesNotMatch(source, /registerCommand\("context-content"/);
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
	const afterOff = applyIncludeSwitch(DEFAULT_STATE, "clearToolContent", parseOnOffArg("off"));
	const stripped = summarizeFilter(messages, afterOff);
	assert.ok(stripped.filteredTokens < full.filteredTokens);
	assert.ok(stripped.savedTokens > 0);
	assert.equal(filterContextMessages(messages, afterOff)[2].content[0].text, "[Tool output omitted]");

	const lines = buildWidgetLines(afterOff, { ...stripped, contextWindow: 128000 });
	assert.match(lines[0], /^~/);
	assert.equal(lines[1], "Tool content OFF");
	assert.equal(lines[2], "Tool history ON");

	const restored = restoreStateFromEntries([
		{ type: "custom", customType: "pi-deck-context-controller", data: afterOff },
	], DEFAULT_STATE);
	sameJson(restored, afterOff);
});

test("a session without its own snapshot does not inherit another chat's off state", () => {
	const { restoreStateFromEntries, DEFAULT_STATE } = loadContextControllerModule();
	sameJson(restoreStateFromEntries([], DEFAULT_STATE), DEFAULT_STATE);
});

test("desktop maps the context-controller widget instead of parsing it as todos", () => {
	const chips = readFileSync("src/renderer/src/components/session/SessionWidgetChips.tsx", "utf8");
	const titles = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	assert.match(titles, /pi-deck-context-controller/);
	assert.match(titles, /app\.widgetTitleContext/);
	assert.match(chips, /isContextController/);
	assert.match(chips, /SlidersHorizontal/);
});
