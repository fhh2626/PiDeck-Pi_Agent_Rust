import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归门禁：导航入口必须在 host.loadUrl **之前**同步 url/inputValue 本地状态。
//
// 背景：重构后 BrowserPanel.loadUrl() 本体不再做 setUrl/setInputValue（plan §19），
// 地址栏依赖 did-navigate 事件回填。若调用点不同步，则「切换 tab / 关闭 active tab /
// 外部导航消费」之后、did-navigate 到达之前的窗口期内，url 状态仍指向旧页面；
// 此时用户切换设备（selectDevice 读当前 url 重新加载）会把新 active tab 导航回旧 URL。
// plan §23/§26/§27.3 分别要求这三处保留/执行 setUrl + setInput 同步。
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

test("switchTab syncs url/input to the target tab before loading it", () => {
	assertOrdered(
		[
			"updateBrowserPanelSession({ activeTabId: tabId })",
			"setActiveTabId(tabId)",
			"setUrl(tab.url)",
			"setInputValue(tab.url)",
			"loadUrl(tab.url)",
		],
		"switchTab",
	);
});

test("closing the active tab syncs url/input to the neighbour before loading it", () => {
	assertOrdered(
		[
			"persistTabs(nextTabs, nextActiveId)",
			"setUrl(nextTab.url)",
			"setInputValue(nextTab.url)",
			"loadUrl(nextTab.url)",
		],
		"closeTab",
	);
});

test("pending external navigation consumption syncs url/input before host.loadUrl", () => {
	assertOrdered(
		[
			"consumePendingBrowserNavigation()",
			"setUrl(targetUrl)",
			"setInputValue(targetUrl)",
			"host.setDeviceProfile(snapshot.device)",
			"host.loadUrl(targetUrl)",
		],
		"pending navigation polling",
	);
});
