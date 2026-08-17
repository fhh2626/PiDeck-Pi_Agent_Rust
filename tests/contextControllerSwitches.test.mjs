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

const switchStubs = {
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
};

test("parseSwitchStateFromWidgetLines extracts the three switches", () => {
	const { parseSwitchStateFromWidgetLines, parseSavedEstimateFromWidgetLines } = compile(
		"src/renderer/src/components/session/ContextControllerSwitches.tsx",
		switchStubs,
	);

	assert.equal(parseSwitchStateFromWidgetLines(undefined), null);
	assert.equal(parseSwitchStateFromWidgetLines([]), null);
	assert.equal(parseSavedEstimateFromWidgetLines(undefined), null);
	assert.equal(parseSavedEstimateFromWidgetLines([]), null);

	sameJson(
		parseSwitchStateFromWidgetLines([
			"~12k/256k 4.7%",
			"Tool history ON",
			"File content ON",
			"Command output ON",
		]),
		{ toolHistory: true, fileContent: true, commandOutput: true },
	);
	assert.equal(
		parseSavedEstimateFromWidgetLines([
			"~12k/256k 4.7%",
			"Tool history ON",
			"File content ON",
			"Command output ON",
		]),
		null,
	);

	sameJson(
		parseSwitchStateFromWidgetLines([
			"~8k/256k 3.1%",
			"Tool history ON",
			"File content ON",
			"Command output OFF",
			"Saved ~4k (33%)",
		]),
		{ toolHistory: true, fileContent: true, commandOutput: false },
	);
	assert.equal(
		parseSavedEstimateFromWidgetLines([
			"~8k/256k 3.1%",
			"Tool history ON",
			"File content ON",
			"Command output OFF",
			"Saved ~4k (33%)",
		]),
		"~4k (33%)",
	);

	assert.equal(
		parseSwitchStateFromWidgetLines([
			"Tool content OFF",
			"Tool history ON",
		]),
		null,
	);
});

test("applyLocalSwitch matches the plugin interlock table", () => {
	const { applyLocalSwitch } = compile(
		"src/renderer/src/components/session/ContextControllerSwitches.tsx",
		switchStubs,
	);
	const allOn = { toolHistory: true, fileContent: true, commandOutput: true };
	sameJson(applyLocalSwitch(allOn, "toolHistory", false), {
		toolHistory: false,
		fileContent: false,
		commandOutput: false,
	});
	sameJson(
		applyLocalSwitch({ toolHistory: true, fileContent: true, commandOutput: true }, "commandOutput", false),
		{ toolHistory: true, fileContent: true, commandOutput: false },
	);
	sameJson(
		applyLocalSwitch({ toolHistory: false, fileContent: false, commandOutput: false }, "fileContent", true),
		{ toolHistory: true, fileContent: true, commandOutput: false },
	);
});

test("parseContextControllerStateFromJsonl extracts latest three-field state", () => {
	const { parseContextControllerStateFromJsonl } = compile(
		"src/main/sessions/contextControllerStateReader.ts",
		{},
	);

	const empty = parseContextControllerStateFromJsonl("");
	sameJson(empty, { clearToolHistory: false, clearReadContent: false, clearCommandContent: false });

	const jsonlWithHistory = [
		JSON.stringify({ type: "session", id: "sess-1" }),
		JSON.stringify({
			type: "custom",
			customType: "pi-deck-context-controller",
			data: { clearReadContent: true, clearCommandContent: false, clearToolHistory: false },
		}),
		JSON.stringify({ type: "message", role: "assistant", content: "ok" }),
		JSON.stringify({
			type: "custom",
			customType: "pi-deck-context-controller",
			data: { clearReadContent: true, clearCommandContent: true, clearToolHistory: true },
		}),
	].join("\n");

	sameJson(parseContextControllerStateFromJsonl(jsonlWithHistory), {
		clearToolHistory: true,
		clearReadContent: true,
		clearCommandContent: true,
	});

	const unknownLegacy = [
		JSON.stringify({
			type: "custom",
			customType: "pi-deck-context-controller",
			data: { includeTools: false },
		}),
	].join("\n");
	sameJson(parseContextControllerStateFromJsonl(unknownLegacy), {
		clearToolHistory: false,
		clearReadContent: false,
		clearCommandContent: false,
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
		"ctx.switches.fileContent",
		"ctx.switches.fileContentTooltip",
		"ctx.switches.commandOutput",
		"ctx.switches.commandOutputTooltip",
		"ctx.switches.busyDisabled",
		"ctx.switches.pluginDisabled",
		"ctx.switches.nextTurnNote",
		"ctx.switches.savedEstimate",
		"ctx.switches.webAllTools",
		"ctx.switches.webFileContent",
		"ctx.switches.webCommandOutput",
	];

	for (const key of keys) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
	assert.ok(!zh.includes("ctx.switches.toolOutput"), "zh-CN still has retired toolOutput key");
	assert.ok(!en.includes("ctx.switches.toolOutput"), "en-US still has retired toolOutput key");
});

test("switch component has compact sm size and symmetric translate-x-2", () => {
	const source = readFileSync("src/renderer/src/components/ui-shadcn/switch.tsx", "utf8");
	assert.match(source, /data-\[size=sm\]:h-3\s+data-\[size=sm\]:w-5\s+data-\[size=sm\]:min-w-5\s+data-\[size=sm\]:p-0\.5/);
	assert.match(source, /data-\[size=sm\]:size-2\s+data-\[size=sm\]:data-\[state=checked\]:translate-x-2/);
	assert.match(source, /data-\[size=default\]:size-4/);
});

test("foundation.css header button rules exclude switch, checkbox, and select triggers from min-width: 60px", () => {
	const css = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	assert.match(css, /\.chat-header-actions button:not\(\[data-slot="switch"\]\):not\(\[data-slot="checkbox"\]\)/);
});
