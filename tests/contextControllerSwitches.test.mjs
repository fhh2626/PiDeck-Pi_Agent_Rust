import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
		},
		{ filename: filePath },
	);
	return module.exports;
}

function sameJson(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("parseSwitchStateFromWidgetLines extracts toolContent and toolHistory correctly", () => {
	const { parseSwitchStateFromWidgetLines } = compile(
		"src/renderer/src/components/session/ContextControllerSwitches.tsx",
		{
			jotai: {},
			"jotai/utils": {},
			react: {},
			"lucide-react": {},
			"../../atoms": {},
			"../../hooks/useSessionTimelineController": {},
			"../../desktopApi": {},
			"../../i18n": { t: (k) => k },
			"../../utils/notice": {},
			"../ui-shadcn/switch": {},
			"../ui-shadcn/tooltip": {},
		},
	);

	assert.equal(parseSwitchStateFromWidgetLines(undefined), null);
	assert.equal(parseSwitchStateFromWidgetLines([]), null);

	sameJson(
		parseSwitchStateFromWidgetLines([
			"~12k/256k 4.7%",
			"Tool content ON",
			"Tool history ON",
		]),
		{ toolContent: true, toolHistory: true },
	);

	sameJson(
		parseSwitchStateFromWidgetLines([
			"~8k/256k 3.1%",
			"Tool content OFF",
			"Tool history ON",
			"Saved ~4k (33%)",
		]),
		{ toolContent: false, toolHistory: true },
	);

	sameJson(
		parseSwitchStateFromWidgetLines([
			"~2k/256k 0.8%",
			"Tool content OFF",
			"Tool history OFF",
			"Saved ~10k (83%)",
		]),
		{ toolContent: false, toolHistory: false },
	);
});

test("parseContextControllerStateFromJsonl extracts latest state from JSONL text", () => {
	const { parseContextControllerStateFromJsonl } = compile(
		"src/main/sessions/contextControllerStateReader.ts",
		{},
	);

	const empty = parseContextControllerStateFromJsonl("");
	sameJson(empty, { clearToolContent: false, clearToolHistory: false });

	const jsonlWithHistory = [
		JSON.stringify({ type: "session", id: "sess-1" }),
		JSON.stringify({ type: "message", role: "user", content: "hi" }),
		JSON.stringify({
			type: "custom",
			customType: "pi-deck-context-controller",
			data: { clearToolContent: true, clearToolHistory: false },
		}),
		JSON.stringify({ type: "message", role: "assistant", content: "ok" }),
		JSON.stringify({
			type: "custom",
			customType: "pi-deck-context-controller",
			data: { clearToolContent: true, clearToolHistory: true },
		}),
		JSON.stringify({ type: "message", role: "user", content: "next" }),
	].join("\n");

	const state = parseContextControllerStateFromJsonl(jsonlWithHistory);
	sameJson(state, { clearToolContent: true, clearToolHistory: true });

	const legacyJsonl = [
		JSON.stringify({
			type: "custom",
			customType: "pi-deck-context-controller",
			data: { includeTools: false },
		}),
	].join("\n");
	sameJson(parseContextControllerStateFromJsonl(legacyJsonl), {
		clearToolContent: true,
		clearToolHistory: true,
	});
});

test("ContextControllerSwitches is mounted in SessionHeader", () => {
	const headerSource = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
	const viewSource = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");

	assert.match(headerSource, /ContextControllerSwitches/);
	assert.match(headerSource, /<ContextControllerSwitches\s+sessionId={sessionId}/);
	assert.match(viewSource, /<SessionHeader[\s\S]*sessionId={sessionId}/);
});

test("SessionWidgetChips excludes pi-deck-context-controller from chip rendering", () => {
	const chipsSource = readFileSync("src/renderer/src/components/session/SessionWidgetChips.tsx", "utf8");
	assert.match(chipsSource, /widgetKey\s*!==\s*"pi-deck-context-controller"/);
});

test("silent context-controller prompts may send an empty message when agentMessage is present", () => {
	const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(coordinator, /hasSilentCommand/);
	assert.match(coordinator, /input\.silent && input\.agentMessage/);
	assert.match(agentManager, /静默命令必须是已注册扩展命令/);
	assert.match(agentManager, /Can't change context while generating/);
	assert.match(agentManager, /if \(!input\.silent\) \{/);
	assert.match(agentManager, /this\.promptRequestedAtByAgent\.set/);
});

test("i18n dictionaries contain matching context switch keys in both locales", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

	const keys = [
		"ctx.switches.allTools",
		"ctx.switches.allToolsTooltip",
		"ctx.switches.toolOutput",
		"ctx.switches.toolOutputTooltip",
		"ctx.switches.busyDisabled",
		"ctx.switches.pluginDisabled",
	];

	for (const key of keys) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
});
