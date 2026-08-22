import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归门禁（loadUrl 中心化不变量）：loadUrl() 必须在 host.loadUrl 之前同步
// url/inputValue。重构前所有导航入口天然拥有该保证；若缺失，「加载中」窗口期内
// selectDevice 会读到旧 url，把刚发起的导航打回旧页面 —— 地址栏 Enter / 新建 Tab /
// Home / 切 tab / 关 tab 全部受影响。所有产品入口统一经 loadUrl() 自动安全；
// pending 外部导航轮询直接调 host.loadUrl（plan §23），必须自带显式同步。
const panel = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");

/** 断言 markers 在源码中按给定顺序出现（用于锁定「先同步后加载」的先后关系）。 */
function assertOrdered(markers, label) {
	let cursor = -1;
	for (const marker of markers) {
		const found = panel.indexOf(marker, cursor + 1);
		assert.ok(found > cursor, `${label}: expected "${marker}" after position ${cursor}`);
		cursor = found;
	}
}

test("loadUrl itself syncs url/input before dispatching to the host", () => {
	assertOrdered(
		[
			"const loadUrl = useCallback(",
			"setUrl(targetUrl);",
			"setInputValue(targetUrl);",
			"setIsLoading(true);",
			"host.setDeviceProfile(",
			"await host.loadUrl(targetUrl);",
		],
		"loadUrl",
	);
});

test("product entries funnel through loadUrl; direct host.loadUrl only where explicitly synced", () => {
	// host.loadUrl 只允许出现两次：loadUrl 本体（中心同步）与 pending 轮询（显式同步）。
	// 新增导航入口若绕过 loadUrl 直调 host，必须先补同步并更新此计数。
	assert.equal((panel.match(/host\.loadUrl\(/g) ?? []).length, 2);
	for (const marker of [
		"void loadUrl(finalUrl);", // 地址栏 Enter（navigate）
		"void loadUrl(DEFAULT_HOME);", // 新建 Tab + Home 按钮
		"void loadUrl(tab.url);", // 切 tab
		"void loadUrl(nextTab.url);", // 关闭 active tab 加载邻居
	]) {
		assert.ok(panel.includes(marker), `entry must call loadUrl: ${marker}`);
	}
});

test("pending external navigation consumption syncs url/input before host.loadUrl", () => {
	assertOrdered(
		[
			"consumePendingBrowserNavigation()",
			"setUrl(targetUrl);",
			"setInputValue(targetUrl);",
			"host.setDeviceProfile(snapshot.device);",
			"host.loadUrl(targetUrl)",
		],
		"pending navigation polling",
	);
});
