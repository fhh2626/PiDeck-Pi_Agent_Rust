import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule(mockProcess = {}) {
	const source = readFileSync("src/main/linuxDisplayBackend.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const appendedSwitches = [];
	let disableHardwareAccelerationCalls = 0;
	const sandbox = {
		exports: {},
		process: { platform: "linux", env: {}, argv: [], ...mockProcess },
		require: (id) => {
			if (id !== "electron") return require(id);
			return {
				app: {
					disableHardwareAcceleration: () => { disableHardwareAccelerationCalls += 1; },
					commandLine: {
						appendSwitch: (name, value) => appendedSwitches.push({ name, value }),
					},
				},
			};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "linuxDisplayBackend.ts" });
	return {
		...sandbox.exports,
		appendedSwitches,
		getDisableHardwareAccelerationCalls: () => disableHardwareAccelerationCalls,
	};
}

const waylandEnv = {
	XDG_SESSION_TYPE: "wayland",
	WAYLAND_DISPLAY: "wayland-0",
	DISPLAY: ":0",
};

test("keeps the native display backend by default", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();
	assert.deepEqual(JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
		platform: "linux",
		env: waylandEnv,
		argv: [],
	}))), []);
});

test("uses X11 only when the backend is explicitly selected", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();
	assert.deepEqual(JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
		platform: "linux",
		env: { ...waylandEnv, PIDECK_LINUX_DISPLAY_BACKEND: "x11" },
		argv: [],
	}))), [
		{ name: "ozone-platform", value: "x11" },
		{ name: "log-level", value: "3" },
	]);
});

test("does not override an explicit Chromium ozone argument", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();
	assert.deepEqual(JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
		platform: "linux",
		env: { ...waylandEnv, PIDECK_LINUX_DISPLAY_BACKEND: "x11" },
		argv: ["pideck", "--ozone-platform=wayland"],
	}))), []);
});

test("applies explicit X11 switches and disables GPU acceleration", () => {
	const { applyLinuxDisplayBackendWorkaround, appendedSwitches, getDisableHardwareAccelerationCalls } = loadModule({
		platform: "linux",
		env: { ...waylandEnv, PIDECK_LINUX_DISPLAY_BACKEND: "x11" },
		argv: ["pideck"],
	});
	applyLinuxDisplayBackendWorkaround();
	assert.deepEqual(appendedSwitches, [
		{ name: "ozone-platform", value: "x11" },
		{ name: "log-level", value: "3" },
	]);
	assert.equal(getDisableHardwareAccelerationCalls(), 1);
});

test("respects the explicit GPU acceleration opt-out", () => {
	const { applyLinuxDisplayBackendWorkaround, getDisableHardwareAccelerationCalls } = loadModule({
		platform: "linux",
		env: {
			...waylandEnv,
			PIDECK_LINUX_DISPLAY_BACKEND: "x11",
			PIDECK_LINUX_DISABLE_GPU: "0",
		},
		argv: ["pideck"],
	});
	applyLinuxDisplayBackendWorkaround();
	assert.equal(getDisableHardwareAccelerationCalls(), 0);
});
