import { session, type BrowserWindow } from "electron";
import { isDevToolsShortcut, toggleMainWindowDevTools } from "../devTools";
import type { AppLogger } from "../logging/AppLogger";
import { BROWSER_PANEL_PARTITION, isAllowedBrowserPanelUrl } from "./browserSecurity";
import { isAllowedGuestSystemProtocol } from "./externalLinks";

/** Electron does not expose webRequest listener removal, so the shared partition installs it once. */
let browserPanelRequestInstalled = false;

type BrowserPanelWebviewHostDeps = {
	appLogger: AppLogger;
	/** 与 index.ts openExternalUrl 一致；guest 分发的系统协议需要 forceSystem。 */
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
};

/** Applies the browser panel's permission, attachment, and navigation security policy. */
export function configureBrowserPanelWebviewHost(
	window: BrowserWindow,
	deps: BrowserPanelWebviewHostDeps,
): void {
	const browserPanelSession = session.fromPartition(BROWSER_PANEL_PARTITION);
	browserPanelSession.setPermissionCheckHandler(() => false);
	browserPanelSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	browserPanelSession.setDevicePermissionHandler(() => false);
	if (!browserPanelRequestInstalled) {
		browserPanelRequestInstalled = true;
		browserPanelSession.webRequest.onBeforeRequest((details, callback) => {
			const isFrameNavigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
			if (isFrameNavigation && !isAllowedBrowserPanelUrl(details.url)) {
				void deps.appLogger.warn("browser", "Blocked unsafe webview frame request", {
					resourceType: details.resourceType,
					url: details.url,
				});
				callback({ cancel: true });
				return;
			}
			callback({});
		});
	}

	window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		const sourceUrl = params.src || "about:blank";
		if ((params.partition && params.partition !== BROWSER_PANEL_PARTITION) || !isAllowedBrowserPanelUrl(sourceUrl)) {
			event.preventDefault();
			void deps.appLogger.warn("browser", "Blocked unsafe webview attachment", {
				sourceUrl,
				partition: params.partition,
			});
			return;
		}

		params.src = sourceUrl;
		params.partition = BROWSER_PANEL_PARTITION;
		delete params.preload;
		delete params.preloadURL;
		delete params.allowfileaccess;
		// 弹窗能力必须开启：Electron 22 起 webview new-window 事件已移除，target="_blank"/
		// window.open 只能经主进程 guest setWindowOpenHandler 接管；而 allowpopups=false
		// 时 guest 根本不会发起弹窗流（window.open 返回 null），handler 收不到任何调用。
		// 窗口创建仍一律 deny，实际去向由 URL 策略决定（新 tab / 系统处理器 / 拦截）。
		// params 是 Record<string, string>：属性以 HTML attribute 字符串形式传递。
		params.allowpopups = "true";

		webPreferences.partition = BROWSER_PANEL_PARTITION;
		webPreferences.sandbox = true;
		webPreferences.nodeIntegration = false;
		webPreferences.nodeIntegrationInWorker = false;
		webPreferences.nodeIntegrationInSubFrames = false;
		webPreferences.contextIsolation = true;
		webPreferences.webSecurity = true;
		webPreferences.allowRunningInsecureContent = false;
		webPreferences.webviewTag = false;
		delete webPreferences.preload;
		Reflect.deleteProperty(webPreferences, "preloadURL");
	});

	window.webContents.on("did-attach-webview", (_event, guest) => {
		if (guest.session !== browserPanelSession) {
			void deps.appLogger.warn("browser", "Closed webview with unexpected session");
			guest.close();
			return;
		}

		const blockUnsafeNavigation = (event: { url: string; preventDefault(): void }, phase: string) => {
			if (isAllowedBrowserPanelUrl(event.url)) return;
			// 非 http(s) 不一定都要拦死：mailto:/tel:/sms: 是网页里的合法外链，
			// 阻止 webview 导航并转交系统默认处理器；其余协议（file:/search-ms:/
			// 未知 scheme）阻止且不转系统，只记 warn。
			event.preventDefault();
			if (isAllowedGuestSystemProtocol(event.url)) {
				void deps.openExternalUrl(event.url, true);
				return;
			}
			void deps.appLogger.warn("browser", "Blocked unsafe webview navigation", { phase, url: event.url });
		};
		guest.on("will-frame-navigate", (event) => blockUnsafeNavigation(event, "navigate"));
		guest.on("will-redirect", (event) => blockUnsafeNavigation(event, "redirect"));
		guest.setWindowOpenHandler(({ url }) => {
			// guest 弹窗统一在此接管（Electron 22 起 webview new-window 事件已移除，
			// 渲染层监听不到；且 allowpopups 必须为 true 弹窗流才会到达本 handler）：
			// 一律 deny 创建真实窗口，按 URL 策略分发。
			if (url !== "about:blank" && isAllowedBrowserPanelUrl(url)) {
				void deps.openExternalUrl(url);
			} else if (isAllowedGuestSystemProtocol(url)) {
				// 网页触发的 mailto:/tel: 等通信深链：阻止弹窗并转交系统。
				void deps.openExternalUrl(url, true);
			} else if (!isAllowedBrowserPanelUrl(url)) {
				void deps.appLogger.warn("browser", "Blocked unsafe webview window open", { url });
			}
			return { action: "deny" };
		});
		guest.on("before-input-event", (event, input) => {
			if (!isDevToolsShortcut(input)) return;
			event.preventDefault();
			toggleMainWindowDevTools(window);
		});
	});
}
