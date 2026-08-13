import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadPiLocatorModule(platform = process.platform) {
	const source = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const compatibility = (() => {
		const source = readFileSync("src/shared/piCompatibility.ts", "utf8");
		const { outputText } = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		});
		const module = { exports: {} };
		vm.runInNewContext(outputText, { module, exports: module.exports }, { filename: "piCompatibility.ts" });
		return module.exports;
	})();
	const sandbox = {
		Buffer,
		TextDecoder,
		exports: {},
		process: {
			...process,
			env: { ...process.env },
			platform,
		},
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => tmpdir() } };
			}
			if (id === "../../shared/piCompatibility") return compatibility;
			return require(id);
		},
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, {
		filename: "PiLocator.ts",
	});
	sandbox.exports.detectPiRuntimeKind = compatibility.detectPiRuntimeKind;
	return sandbox.exports;
}

test("uses the pi shim bin directory as PATH prefix on macOS when node is beside the shim", () => {
	const root = join(tmpdir(), `pi-desktop-locator-${process.pid}-${Date.now()}`);
	const binDir = join(root, ".nvm", "versions", "node", "v22.22.1", "bin");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi");
	writeFileSync(piPath, "#!/usr/bin/env node\n", "utf8");
	writeFileSync(join(binDir, "node"), "", "utf8");

	try {
		const { PiLocator } = loadPiLocatorModule("darwin");
		const invocation = new PiLocator().createInvocation(piPath, ["--version"]);

		assert.equal(invocation.command, piPath);
		assert.deepEqual(invocation.args, ["--version"]);
		assert.equal(invocation.shell, false);
		assert.equal(invocation.pathPrefix, binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("uses the pi cmd shim bin directory as PATH prefix on Windows when node.exe is beside the shim", () => {
	const root = join(tmpdir(), `pi-desktop-locator-win-${process.pid}-${Date.now()}`);
	const binDir = join(root, "nvm", "v22.22.1");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi.cmd");
	writeFileSync(piPath, "@echo off\r\nnode \"%~dp0\\node_modules\\pi\\bin.js\" %*\r\n", "utf8");
	writeFileSync(join(binDir, "node.exe"), "", "utf8");

	try {
		const { PiLocator } = loadPiLocatorModule("win32");
		const locator = new PiLocator();
		const invocation = locator.createInvocation(piPath, ["--version"]);

		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
		assert.equal(JSON.stringify(invocation.args.slice(0, 3)), JSON.stringify(["/d", "/s", "/c"]));
		assert.equal(invocation.shell, false);
		assert.equal(invocation.pathPrefix, binDir);
		assert.equal(invocation.windowsVerbatimArguments, true);

		// Windows cmd 读 Path；createProcessEnv 必须把 pathPrefix 同步进 PATH/Path
		const env = locator.createProcessEnv(undefined, invocation.pathPrefix);
		assert.equal(typeof env.PATH, "string");
		assert.ok(String(env.PATH).startsWith(binDir));
		assert.equal(env.Path, env.PATH);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("places an explicit WSL cwd before the pi command", () => {
	const { PiLocator } = loadPiLocatorModule("win32");
	const invocation = new PiLocator().createInvocation(
		"wsl://Ubuntu-24.04/root/pi",
		["--mode", "rpc"],
		{ wslCwd: "/root/ba cli" },
	);

	assert.deepEqual(
		Array.from(invocation.args),
		["-d", "Ubuntu-24.04", "-u", "root", "--cd", "/root/ba cli", "pi", "--mode", "rpc"],
	);
	assert.equal(invocation.wsl.distro, "Ubuntu-24.04");
});

test("classifies the original and Rust version formats", () => {
	const { detectPiRuntimeKind } = loadPiLocatorModule("darwin");
	assert.equal(detectPiRuntimeKind("0.84.1"), "typescript");
	assert.equal(detectPiRuntimeKind("pi 0.2.0 (unknown abc)"), "rust");
	assert.equal(detectPiRuntimeKind("development build"), "unknown");
});

test("explicit runtime paths override the generic PATH command", () => {
	const { PiLocator } = loadPiLocatorModule("darwin");
	const locator = new PiLocator();
	assert.equal(
		locator.resolveCommand(undefined, false, undefined, undefined, "typescript", "/opt/pi-ts", "/opt/pi-rust"),
		"/opt/pi-ts",
	);
	assert.equal(
		locator.resolveCommand(undefined, false, undefined, undefined, "rust", "/opt/pi-ts", "/opt/pi-rust"),
		"/opt/pi-rust",
	);
});
