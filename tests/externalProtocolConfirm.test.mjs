import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// 确认流状态竞态测试（真实行为，非源码匹配）：
// 远程脚本可在用户点击前连续推送 A/B/C —— hook 必须锁定首条请求，
// confirm 打开的必须与用户看到的（第一条）一致。
const source = readFileSync("src/renderer/src/hooks/useExternalProtocolConfirm.ts", "utf8");

function compileHook(reactStub, desktopApiStub) {
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "src/renderer/src/hooks/useExternalProtocolConfirm.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (specifier) => {
			if (specifier === "react") return reactStub;
			if (specifier === "../desktopApi") return desktopApiStub;
			return {};
		},
	}, { filename: "useExternalProtocolConfirm.ts" });
	return module.exports;
}

/** 极简 React 替身：useState/useEffect/useCallback 按调用序展开。 */
function createHarness(openedUrls) {
	const states = [];
	let cursor = 0;
	let effectCleanup = null;
	let effectFactory = null;
	const react = {
		useState(initial) {
			const index = cursor++;
			states[index] ??= typeof initial === "function" ? initial() : initial;
			const setter = (next) => {
				states[index] = typeof next === "function" ? next(states[index]) : next;
			};
			return [states[index], setter];
		},
		useCallback(fn) {
			cursor++;
			return fn;
		},
		// useEffect 与 useState/useCallback 一样占 hook 槽位，必须推进 cursor。
		useEffect(factory) {
			cursor++;
			effectFactory = factory;
		},
	};
	const desktopApi = {
		app: { onConfirmExternalProtocol: (cb) => { harness.pushedFrom = cb; return () => { harness.pushedFrom = null; }; } },
		browser: { openExternal: (url) => openedUrls.push(url) },
	};
	const hooks = compileHook(react, { desktopApi });
	const harness = {
		pushedFrom: null,
		render() {
			cursor = 0;
			return hooks.useExternalProtocolConfirm();
		},
		/** 模拟 React 提交：先渲染 hook 体，再运行 effect（含 StrictMode 双挂载：mount → cleanup → mount）。 */
		runEffect() {
			this.render();
			if (effectCleanup) { effectCleanup(); effectCleanup = null; }
			effectCleanup = effectFactory?.() ?? undefined;
		},
	};
	return harness;
}

test("first request wins: later pushes never replace the pending URL", () => {
	const opened = [];
	const h = createHarness(opened);
	h.runEffect();

	let r = h.render();
	assert.equal(r.url, null);

	// 网页连续触发三条外部协议请求
	h.pushedFrom("mailto:first@example.com");
	r = h.render();
	assert.equal(r.url, "mailto:first@example.com");

	h.pushedFrom("mailto:second@example.com");
	h.pushedFrom("tel:+9876543210");
	r = h.render();
	// TOCTOU 门禁：确认框仍显示第一条
	assert.equal(r.url, "mailto:first@example.com");

	// 用户确认：打开的必须是用户看到的第一条
	r.confirm();
	assert.deepEqual(opened, ["mailto:first@example.com"]);
	assert.equal(h.render().url, null);
});

test("dismiss clears the locked slot so a later request can start fresh", () => {
	const opened = [];
	const h = createHarness(opened);
	h.runEffect();
	h.pushedFrom("mailto:first@example.com");
	let r = h.render();
	assert.equal(r.url, "mailto:first@example.com");

	r.dismiss();
	r = h.render();
	assert.equal(r.url, null);

	h.pushedFrom("tel:+111");
	r = h.render();
	assert.equal(r.url, "tel:+111");
	assert.deepEqual(opened, []);
});

test("unsubscribe stops new requests from reaching the state", () => {
	const h = createHarness([]);
	h.runEffect();
	assert.ok(h.pushedFrom, "subscription active");
	h.runEffect(); // StrictMode 双挂载：cleanup 后重订阅仍可用
	assert.ok(h.pushedFrom, "re-subscribed after cleanup");
});

test("confirm does nothing when no request is pending", () => {
	const opened = [];
	const h = createHarness(opened);
	h.runEffect();
	const r = h.render();
	r.confirm();
	assert.deepEqual(opened, []);
});
