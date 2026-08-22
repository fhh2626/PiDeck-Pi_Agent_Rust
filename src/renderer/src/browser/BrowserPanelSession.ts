/**
 * BrowserPanel 的 host 无关模块级会话状态。
 *
 * 浏览器抽屉/全屏切换会导致 BrowserPanel remount，但 tabs/activeTabId/device/navigateKey
 * 必须在同一 renderer 生命周期内保留，因此这里沿用原 BrowserPanel.tsx 中的
 * intentional module state（不迁 Jotai，见任务边界）。
 *
 * 该模块不允许出现任何 Electron/webview 引用；宿主 API（BrowserHostApi 实例）
 * 绝不能缓存在这里，否则 remount 后会持有已销毁的 guest webContents。
 */
import type { BrowserDeviceProfile } from "./BrowserHostApi";

export const DEFAULT_HOME = "https://github.com/fhh2626/PiDeck-Pi_Agent_Rust";

export type BrowserTab = {
	id: string;
	title: string;
	url: string;
};

export type BrowserPanelSessionSnapshot = {
	tabs: BrowserTab[];
	activeTabId: string | null;
	device: BrowserDeviceProfile;
	navigateKey: number;
};

export type PendingBrowserNavigation = {
	tabId: string;
	url: string;
};

let nextTabId = 1;
function genTabId(): string {
	return `tab-${nextTabId++}`;
}

const moduleState: BrowserPanelSessionSnapshot = {
	tabs: [],
	activeTabId: null,
	device: "pc",
	navigateKey: 0,
};

/** 待消费的外部导航请求（记录目标 tabId 与 URL），BrowserPanel 通过轮询检测。 */
let pendingNavigation: PendingBrowserNavigation | null = null;

function ensureInitialTab() {
	if (moduleState.tabs.length > 0) return;
	const id = genTabId();
	moduleState.tabs = [{ id, title: "PiDeck-Q", url: DEFAULT_HOME }];
	moduleState.activeTabId = id;
}

/** 读取当前快照（纯读，不触发初始 tab 创建；ensure 只发生在组件挂载路径）。 */
export function getBrowserPanelSessionSnapshot(): BrowserPanelSessionSnapshot {
	return {
		tabs: [...moduleState.tabs],
		activeTabId: moduleState.activeTabId,
		device: moduleState.device,
		navigateKey: moduleState.navigateKey,
	};
}

/** 组件首次挂载时取 active tab（tabs 为空则先建默认 Home tab）。 */
export function ensureInitialBrowserTab(): BrowserTab {
	ensureInitialTab();
	return (
		moduleState.tabs.find((tab) => tab.id === moduleState.activeTabId) ??
		moduleState.tabs[0]
	);
}

/** 写回部分快照字段；调用方负责随后同步 React state。 */
export function updateBrowserPanelSession(patch: Partial<BrowserPanelSessionSnapshot>): void {
	if (patch.tabs !== undefined) moduleState.tabs = patch.tabs;
	if (patch.activeTabId !== undefined) moduleState.activeTabId = patch.activeTabId;
	if (patch.device !== undefined) moduleState.device = patch.device;
	if (patch.navigateKey !== undefined) moduleState.navigateKey = patch.navigateKey;
}

/** 在 session 内新建一个 tab（统一 id 生成入口，返回新 tab；不改变 activeTabId）。 */
export function createBrowserTabInSession(url: string, title: string): BrowserTab {
	const id = genTabId();
	const tab: BrowserTab = { id, title, url };
	moduleState.tabs = [...moduleState.tabs, tab];
	return tab;
}

/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 每次都新建 tab，避免多个外部链接复用同一个 tab。
 */
export function requestBrowserNavigation(url: string): void {
	// 每次外部导航创建新 tab，避免多个链接复用同一个 tab
	const id = genTabId();
	// 初始 title 留空（渲染层 fallback 显示 URL，等宿主上报真实 page title 后替换），
	// 防止标题闪烁
	moduleState.tabs.push({ id, title: "", url });
	moduleState.activeTabId = id;
	moduleState.navigateKey += 1;
	// 记录目标 tabId 与 URL；轮询消费时校验 activeTabId 匹配，防止加载期间切 tab 导致串扰
	pendingNavigation = { tabId: id, url };
}

/** 查看待消费的外部导航请求（不清除）。 */
export function peekPendingBrowserNavigation(): PendingBrowserNavigation | null {
	return pendingNavigation;
}

/** 消费待处理的外部导航请求（返回并清除）；无 pending 时返回 null。 */
export function consumePendingBrowserNavigation(): PendingBrowserNavigation | null {
	const pending = pendingNavigation;
	pendingNavigation = null;
	return pending;
}

/**
 * 清空会话状态（关闭最后一个 tab 时使用），下次打开时重建默认 Home tab。
 * 注意：与重构前行为一致，不重置 device——设备模式（mobile/tablet UA + 视口约束）
 * 属于用户偏好，关闭最后一个 tab 不应静默丢失。
 */
export function resetBrowserPanelSession(): void {
	moduleState.tabs = [];
	moduleState.activeTabId = null;
	moduleState.navigateKey = 0;
	pendingNavigation = null;
}
