import assert from "node:assert/strict";
import test from "node:test";

// BrowserPanelSession 行为测试：模块级会话状态（host 无关）。
// 渲染层纯函数模块（无 DOM/无 React 依赖），node:test 可直接 import（同 chatTypography.test.mjs 策略）。
import {
	consumePendingBrowserNavigation,
	createBrowserTabInSession,
	DEFAULT_HOME,
	ensureInitialBrowserTab,
	getBrowserPanelSessionSnapshot,
	peekPendingBrowserNavigation,
	requestBrowserNavigation,
	resetBrowserPanelSession,
	updateBrowserPanelSession,
} from "../src/renderer/src/browser/BrowserPanelSession.ts";
import { isExpectedNavigationAbort } from "../src/renderer/src/browser/electron/ElectronWebviewNavigation.ts";
import {
	deviceUserAgent,
	MOBILE_UA,
	TABLET_UA,
} from "../src/renderer/src/browser/electron/ElectronWebviewDeviceUA.ts";

function resetForTest() {
	resetBrowserPanelSession();
}

test("initial state: ensure creates exactly one Home tab and activates it", () => {
	resetForTest();
	const tab = ensureInitialBrowserTab();
	const snapshot = getBrowserPanelSessionSnapshot();
	assert.equal(snapshot.tabs.length, 1);
	assert.equal(snapshot.activeTabId, tab.id);
	assert.equal(tab.url, DEFAULT_HOME);
});

test("external request: each request creates a new active tab with pending URL", () => {
	resetForTest();
	ensureInitialBrowserTab();
	requestBrowserNavigation("https://example.test/a");
	const snapshot = getBrowserPanelSessionSnapshot();
	assert.equal(snapshot.tabs.length, 2);
	const newTab = snapshot.tabs.find((item) => item.url === "https://example.test/a");
	assert.ok(newTab);
	// 初始 title 为空，渲染层 fallback 显示 URL，等 page title 到达再替换
	assert.equal(newTab.title, "");
	assert.equal(snapshot.activeTabId, newTab.id);
	assert.deepEqual(peekPendingBrowserNavigation(), {
		tabId: newTab.id,
		url: "https://example.test/a",
	});
});

test("multiple external requests keep every tab; only the latest stays pending", () => {
	resetForTest();
	ensureInitialBrowserTab();
	requestBrowserNavigation("https://example.test/a");
	requestBrowserNavigation("https://example.test/b");
	const snapshot = getBrowserPanelSessionSnapshot();
	assert.equal(snapshot.tabs.length, 3);
	assert.ok(snapshot.tabs.some((tab) => tab.url === "https://example.test/a"), "tab A must survive");
	const tabB = snapshot.tabs.find((tab) => tab.url === "https://example.test/b");
	assert.equal(snapshot.activeTabId, tabB.id);
	assert.deepEqual(peekPendingBrowserNavigation(), {
		tabId: tabB.id,
		url: "https://example.test/b",
	});
});

test("pending navigation: peek does not clear; consume returns once then null", () => {
	resetForTest();
	ensureInitialBrowserTab();
	requestBrowserNavigation("https://example.test/only");
	const snapshot = getBrowserPanelSessionSnapshot();
	const expected = { tabId: snapshot.activeTabId, url: "https://example.test/only" };
	assert.deepEqual(peekPendingBrowserNavigation(), expected);
	assert.deepEqual(peekPendingBrowserNavigation(), expected);
	assert.deepEqual(consumePendingBrowserNavigation(), expected);
	assert.equal(peekPendingBrowserNavigation(), null);
	assert.equal(consumePendingBrowserNavigation(), null);
});

test("regression: user switching tab while host is loading does not navigate active tab to pending URL", () => {
	resetForTest();
	const homeTab = ensureInitialBrowserTab();
	// 1. 创建已有 tab C
	const tabC = createBrowserTabInSession("https://example.test/c", "Tab C");
	updateBrowserPanelSession({ activeTabId: tabC.id });

	// 2. 模拟外部导航请求 B（例如确认 popup B 产生）
	requestBrowserNavigation("https://example.test/b");
	const snapshotAfterRequest = getBrowserPanelSessionSnapshot();
	const tabB = snapshotAfterRequest.tabs.find((t) => t.url === "https://example.test/b");
	assert.ok(tabB);
	assert.equal(snapshotAfterRequest.activeTabId, tabB.id);

	// 3. 模拟 host.isLoading() 期间用户切换回 tab C
	updateBrowserPanelSession({ activeTabId: tabC.id });

	// 4. 模拟 BrowserPanel 轮询消费 pending B
	const hostLoadedUrls = [];
	const mockHost = {
		isLoading: () => false,
		loadUrl: async (url) => {
			hostLoadedUrls.push(url);
		},
		setDeviceProfile: () => {},
	};

	const pending = peekPendingBrowserNavigation();
	assert.ok(pending);
	assert.equal(mockHost.isLoading(), false);

	const consumed = consumePendingBrowserNavigation();
	assert.ok(consumed);

	// 执行与 BrowserPanel.tsx 相同的目标 tab 校验逻辑
	const currentSnapshot = getBrowserPanelSessionSnapshot();
	if (currentSnapshot.activeTabId !== consumed.tabId) {
		// 用户切走：跳过对 host 的 loadUrl
	} else {
		mockHost.loadUrl(consumed.url);
	}

	// 5. 断言：C.url 仍是 C，B.url 仍是 B，host 未将 B 加载进当前 tab C
	const finalSnapshot = getBrowserPanelSessionSnapshot();
	const finalC = finalSnapshot.tabs.find((t) => t.id === tabC.id);
	const finalB = finalSnapshot.tabs.find((t) => t.id === tabB.id);
	assert.equal(finalC.url, "https://example.test/c");
	assert.equal(finalB.url, "https://example.test/b");
	assert.equal(finalSnapshot.activeTabId, tabC.id);
	assert.deepEqual(hostLoadedUrls, [], "host must NOT navigate current tab C to pending URL B");
});

test("reset clears stale tabs and pending URL; next ensure recreates the Home tab", () => {
	resetForTest();
	ensureInitialBrowserTab();
	requestBrowserNavigation("https://example.test/stale");
	updateBrowserPanelSession({ device: "mobile" });
	resetForTest();
	// reset 后不主动 ensure：stale tabs 已清空，pending 为 null
	assert.equal(getBrowserPanelSessionSnapshot().tabs.length, 0);
	assert.equal(peekPendingBrowserNavigation(), null);
	// reset 不重置 device（与重构前一致）：设备模式是用户偏好，关闭最后 tab 不丢失
	assert.equal(getBrowserPanelSessionSnapshot().device, "mobile");
	// 下一次打开浏览器时 ensure 才重建默认 Home tab
	const tab = ensureInitialBrowserTab();
	assert.equal(tab.url, DEFAULT_HOME);
});

// ERR_ABORTED / -3 归属 Electron adapter；此处锁定迁移后的判断行为不回归。
test("expected navigation abort detection keeps original semantics", () => {
	assert.equal(isExpectedNavigationAbort(new Error("Failed to load URL... ERR_ABORTED")), true);
	assert.equal(isExpectedNavigationAbort(new Error("error code: -3")), true);
	assert.equal(isExpectedNavigationAbort(new Error("net::ERR_CONNECTION_REFUSED (-105)")), false);
	assert.equal(isExpectedNavigationAbort(new Error("ECONNREFUSED")), false);
	assert.equal(isExpectedNavigationAbort(new Error("random failure")), false);
});

// 设备 UA 回归（plan §61）：精确断言迁移后的 UA 值，防止后续被"顺手更新"。
// pc 返回 null 表示由 host 恢复该 guest 捕获的真实默认 UA，不是硬编码 UA。
test("device user-agent mapping matches the pre-refactor values exactly", () => {
	assert.equal(deviceUserAgent("mobile"), MOBILE_UA);
	assert.equal(
		deviceUserAgent("mobile"),
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	);
	assert.equal(deviceUserAgent("tablet"), TABLET_UA);
	assert.equal(
		deviceUserAgent("tablet"),
		"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	);
	assert.equal(deviceUserAgent("pc"), null);
});

test("regression: mount initializer consumes pending navigation if matching initialTab, preventing double load", () => {
	resetForTest();
	// 面板未挂载时外部请求打开 url
	requestBrowserNavigation("https://example.test/initial-target");
	assert.ok(peekPendingBrowserNavigation());

	// 模拟 BrowserPanel 挂载时的 useState(() => ...) 初始化器逻辑
	const initialTab = ensureInitialBrowserTab();
	const pending = peekPendingBrowserNavigation();
	if (pending && pending.tabId === initialTab.id) {
		consumePendingBrowserNavigation();
	}

	assert.equal(initialTab.url, "https://example.test/initial-target");
	assert.equal(peekPendingBrowserNavigation(), null, "pending must be cleared upon mount consumption");
});
