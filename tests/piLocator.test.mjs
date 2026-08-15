import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadPiLocatorModule(platform = process.platform, envOverrides = {}, homePath = tmpdir()) {
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
			env: { ...process.env, ...envOverrides },
			platform,
		},
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => homePath } };
			}
			if (id === "../../shared/piCompatibility") return compatibility;
			return require(id);
		},
	};
	sandbox.global = sandbox;
	// 宿主开发机可能已设置 MISE_DATA_DIR 等变量（如 D:\mise-data），
	// 未显式覆盖时剔除，保证每个用例从“干净环境”出发验证默认路径逻辑。
	if (!("MISE_DATA_DIR" in envOverrides)) delete sandbox.process.env.MISE_DATA_DIR;
	if (!("MISE_INSTALLS_DIR" in envOverrides)) delete sandbox.process.env.MISE_INSTALLS_DIR;
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

test("getSearchDirs honors MISE_DATA_DIR and MISE_INSTALLS_DIR on Windows", () => {
	const root = join(tmpdir(), `pi-desktop-locator-mise-${process.pid}-${Date.now()}`);
	const miseData = join(root, "mise-data");
	const miseInstalls = join(root, "custom-installs");
	const installDir = join(miseInstalls, "node", "v24.0.0");
	mkdirSync(installDir, { recursive: true });
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{
				MISE_DATA_DIR: miseData,
				MISE_INSTALLS_DIR: miseInstalls,
				LOCALAPPDATA: join(root, "Local"),
				APPDATA: join(root, "Roaming"),
			},
			root,
		);
		const dirs = new PiLocator().getSearchDirs();
		// 自定义数据目录生效，且不再依赖 %LOCALAPPDATA%\mise 默认位置
		assert.ok(dirs.includes(join(miseData, "shims")));
		assert.ok(dirs.includes(installDir));
		assert.ok(!dirs.includes(join(root, "Local", "mise", "shims")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs falls back to %LOCALAPPDATA%\\mise without MISE_DATA_DIR (Windows)", () => {
	const root = join(tmpdir(), `pi-desktop-locator-mise-default-${process.pid}-${Date.now()}`);
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const dirs = new PiLocator().getSearchDirs();
		assert.ok(dirs.includes(join(root, "Local", "mise", "shims")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs scans fnm node-versions and scoop dirs on Windows", () => {
	const root = join(tmpdir(), `pi-desktop-locator-fnm-${process.pid}-${Date.now()}`);
	const fnmInstall = join(root, "Local", "fnm", "node-versions", "v22.0.0", "installation");
	mkdirSync(fnmInstall, { recursive: true });
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const dirs = new PiLocator().getSearchDirs();
		assert.ok(dirs.includes(fnmInstall));
		assert.ok(dirs.includes(join(root, "scoop", "shims")));
		assert.ok(dirs.includes(join(root, "scoop", "apps", "nodejs", "current")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs uses ~/.local/share/mise on darwin and linux", () => {
	for (const platform of ["darwin", "linux"]) {
		const root = join(tmpdir(), `pi-desktop-locator-mise-${platform}-${process.pid}-${Date.now()}`);
		try {
			const { PiLocator } = loadPiLocatorModule(platform, {}, root);
			const dirs = new PiLocator().getSearchDirs();
			assert.ok(
				dirs.includes(join(root, ".local", "share", "mise", "shims")),
				`${platform} should scan ~/.local/share/mise`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("createProcessEnv prepends search dirs to PATH/Path without pathPrefix (npm check path)", () => {
	const root = join(tmpdir(), `pi-desktop-locator-npm-env-${process.pid}-${Date.now()}`);
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const env = new PiLocator().createProcessEnv();
		// npm 检测（piCheckNpm）直接复用该 env 执行 npm --version
		assert.ok(String(env.PATH).split(";").includes(join(root, "Local", "pnpm")));
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
