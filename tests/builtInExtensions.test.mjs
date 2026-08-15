import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadBuiltInExtensionsModule() {
	const source = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, require, console };
	vm.runInNewContext(outputText, sandbox, { filename: "builtInExtensions.ts" });
	return sandbox.exports;
}

function sameArgs(actual, expected) {
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.equal(JSON.stringify([...actual]), JSON.stringify(expected));
}

test("appendBuiltInExtensionArgs adds repeated --extension flags", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc"], [
		"C:\\app\\resources\\extensions\\pi-deck-todo.ts",
		"C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts",
	]);
	sameArgs(next, [
		"--mode",
		"rpc",
		"--extension",
		"C:\\app\\resources\\extensions\\pi-deck-todo.ts",
		"--extension",
		"C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts",
	]);
});

test("appendBuiltInExtensionArgs skips when noExtensions is true", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc", "--no-extensions"], [
		"/tmp/pi-deck-todo.ts",
	], { noExtensions: true });
	sameArgs(next, ["--mode", "rpc", "--no-extensions"]);
});

test("listActiveBuiltInExtensionPaths respects removedBuiltIn and missing files", () => {
	const { listActiveBuiltInExtensionPaths, BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "pideck-builtin-ext-"));
	const extDir = join(root, "resources", "extensions");
	mkdirSync(extDir, { recursive: true });
	// 只写入 ask + todo，故意不写 plan/nul，验证缺失跳过
	writeFileSync(join(extDir, "pi-deck-ask-question.ts"), "// ask\n", "utf8");
	writeFileSync(join(extDir, "pi-deck-todo.ts"), "// todo\n", "utf8");

	try {
		const paths = listActiveBuiltInExtensionPaths(
			{ appPath: root, resourcesPath: root, isDev: true },
			["pi-deck-todo.ts"],
		);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pi-deck-ask-question.ts"));
		// 内置扩展清单随版本增长：ask/nul-redirect/plan-mode/security-gate/todo/vision/better-compaction
		assert.equal(BUILT_IN_EXTENSIONS.length, 7);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-better-compaction is packaged as a built-in and disabled by default", () => {
	const { BUILT_IN_EXTENSIONS, DEFAULT_DISABLED_BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	assert.ok(BUILT_IN_EXTENSIONS.includes("pi-better-compaction.ts"));
	assert.ok(DEFAULT_DISABLED_BUILT_IN_EXTENSIONS.includes("pi-better-compaction.ts"));
	assert.match(
		readFileSync("src/main/settings/SettingsStore.ts", "utf8"),
		/removedBuiltInExtensions:\s*\[\.\.\.DEFAULT_DISABLED_BUILT_IN_EXTENSIONS\]/,
	);
	assert.ok(readFileSync("resources/extensions/pi-better-compaction.ts", "utf8").includes("extension-runtime.ts"));
});

test("default-disabled built-in migration is one-time and preserves a later restore", () => {
	const {
		BUILT_IN_EXTENSION_DEFAULTS_VERSION,
		migrateBuiltInExtensionDefaults,
	} = loadBuiltInExtensionsModule();
	const migrated = migrateBuiltInExtensionDefaults(["pi-deck-todo.ts"], undefined);
	assert.equal(migrated.migrated, true);
	assert.equal(migrated.removedBuiltInExtensions.includes("pi-better-compaction.ts"), true);

	const restored = migrateBuiltInExtensionDefaults([], BUILT_IN_EXTENSION_DEFAULTS_VERSION);
	assert.equal(restored.migrated, false);
	assert.equal(JSON.stringify(restored.removedBuiltInExtensions), "[]");
});

test("built-in extension removal has a registered IPC handler", () => {
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const extensionsTab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(storeIpc, /ipcChannels\.extensionsRemoveBuiltIn[\s\S]*extensionManager\.removeBuiltIn\(source\)/);
	assert.match(storeIpc, /ipcChannels\.extensionsRestoreBuiltIn[\s\S]*extensionManager\.restoreBuiltIn\(source\)/);
	assert.match(extensionsTab, /extension\.enabled === false/);
	assert.match(extensionsTab, /config\.enableExtension/);
});

test("AgentManager no longer deploys built-ins via ensurePiDeckExtension", () => {
	const index = readFileSync("src/main/index.ts", "utf8");
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const processSource = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.doesNotMatch(index, /async function ensurePiDeckExtension/);
	assert.doesNotMatch(storeIpc, /ensurePiDeckExtension/);
	assert.match(index, /migrateLegacyBuiltInExtensions/);
	assert.match(processSource, /appendBuiltInExtensionArgs/);
	assert.match(processSource, /--extension/);
});
