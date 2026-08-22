import assert from "node:assert/strict";
import test from "node:test";

// 外部链接协议网关行为测试：openExternalUrl 是渲染层/更新流程共用的唯一入口，
// 协议路由策略抽在 src/main/browser/externalLinks.ts（纯函数 + 依赖注入）。
import {
	isAllowedExternalProtocol,
	isHttpLikeExternalUrl,
	NON_HTTP_EXTERNAL_SCHEMES,
	openExternalLink,
} from "../src/main/browser/externalLinks.ts";

/** 记录 openInSystem / openInBrowserPanel 调用的替身。 */
function makeDeps(overrides = {}) {
	const calls = { system: [], panel: [], warns: [] };
	const deps = {
		openInSystem: async (url) => {
			calls.system.push(url);
		},
		openInBrowserPanel: (url) => {
			calls.panel.push(url);
		},
		linkOpenMode: () => "external",
		logger: {
			warn: (scope, message, detail) => {
				calls.warns.push({ scope, message, detail });
			},
		},
		...overrides,
	};
	return { deps, calls };
}

test("isHttpLikeExternalUrl only accepts web protocols", () => {
	assert.equal(isHttpLikeExternalUrl("https://example.com"), true);
	assert.equal(isHttpLikeExternalUrl("http://example.com"), true);
	assert.equal(isHttpLikeExternalUrl("mailto:test@example.com"), false);
	assert.equal(isHttpLikeExternalUrl("file:///C:/x"), false);
});

test("allowlist covers communication and editor schemes, case-insensitive", () => {
	for (const scheme of NON_HTTP_EXTERNAL_SCHEMES) {
		const url = `${scheme}rest`;
		assert.equal(isAllowedExternalProtocol(url), true, url);
	}
	assert.equal(isAllowedExternalProtocol("MAILTO:test@example.com"), true);
	assert.equal(isAllowedExternalProtocol("VSCode://open"), true);
});

test("dangerous or unknown protocols are rejected before reaching the OS", () => {
	for (const url of ["file:///C:/Windows/System32/config", "search-ms:query=x", "ms-settings:display", "javascript:alert(1)", "ftp://host/x"]) {
		assert.equal(isAllowedExternalProtocol(url), false, url);
	}
});

test("mailto goes to the system handler instead of being silently dropped", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("mailto:test@example.com", deps);
	assert.deepEqual(calls.system, ["mailto:test@example.com"]);
	assert.deepEqual(calls.panel, []);
	assert.deepEqual(calls.warns, []);
});

test("non-http open failure is downgraded to a warn log, not propagated", async () => {
	const { deps, calls } = makeDeps({
		openInSystem: async () => {
			throw new Error("no handler for scheme");
		},
	});
	await openExternalLink("tel:+1234567890", deps);
	assert.equal(calls.warns.length, 1);
	assert.equal(calls.warns[0].message, "Failed to open non-http external link");
});

test("rejected protocol produces an observable warn instead of silence", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("search-ms:query=secret", deps);
	assert.deepEqual(calls.system, []);
	assert.deepEqual(calls.panel, []);
	assert.equal(calls.warns.length, 1);
	assert.equal(calls.warns[0].message, "Rejected external link with non-allowlisted protocol");
});

test("http respects linkOpenMode=internal via the browser panel", async () => {
	const { deps, calls } = makeDeps({ linkOpenMode: () => "internal" });
	await openExternalLink("https://example.com/docs", deps);
	assert.deepEqual(calls.panel, ["https://example.com/docs"]);
	assert.deepEqual(calls.system, []);
});

test("forceSystem path (linkOpenMode pinned external) sends https straight to shell", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("https://example.com/release", deps);
	assert.deepEqual(calls.system, ["https://example.com/release"]);
	assert.deepEqual(calls.panel, []);
});

test("http(s) open failures still propagate (update flow depends on it)", async () => {
	const { deps } = makeDeps({
		openInSystem: async () => {
			throw new Error("shell exploded");
		},
	});
	await assert.rejects(() => openExternalLink("https://example.com/download", deps), /shell exploded/);
});
