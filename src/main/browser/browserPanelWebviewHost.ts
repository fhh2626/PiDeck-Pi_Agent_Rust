import { session, type BrowserWindow } from "electron";
import { isDevToolsShortcut, toggleMainWindowDevTools } from "../devTools";
import type { AppLogger } from "../logging/AppLogger";
import { BROWSER_PANEL_PARTITION, isAllowedBrowserPanelUrl } from "./browserSecurity";
import { isAllowedGuestSystemProtocol } from "./externalLinks";

/** Electron does not expose webRequest listener removal, so the shared partition installs it once. */
let browserPanelRequestInstalled = false;

type BrowserPanelWebviewHostDeps = {
	appLogger: AppLogger;
	/** 与 index.ts openExternalUrl 一致；window-open 分发的系统协议需要 forceSystem。 */
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	/** guest 页面请求 mailto/tel/sms 时向主窗口渲染层发确认请求（用户同意后才真正打开）。 */
	requestExternalProtocolConfirmation: (url: string) => void;
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
		// 弹窗能力必须开启（Electron 22 起 webview new-window 事件已移除，target="_blank"/
		// window.open 只能经主进程 guest setWindowOpenHandler 接管）。
		// 时机关键：guest-view-manager.ts 中 makeWebPreferences() 先于本事件执行
		// （disablePopups = !params.allowpopups 已算完），此处改 params 无效；但传入的
		// webPreferences 对象会在事件后直通展开给 WebContents.create()，因此改它有效。
		// disablePopups 是 Electron 内部字段（未收录进公开 WebPreferences 类型），
		// 用 Object.assign 写入避免类型断言。窗口创建仍一律 deny，去向由 URL 策略决定。
		Object.assign(webPreferences, { disablePopups: false });

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

		const blockUnsafeNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }, phase: string) => {
			if (isAllowedBrowserPanelUrl(event.url)) return;
			// 非 http(s) 不一定都要拦死：mailto:/tel:/sms: 是网页里的合法外链，
			// 阻止 webview 导航并交由受信渲染层确认后转系统；其余协议（file:/
			// search-ms:/未知 scheme）阻止且不转系统，只记 warn。
			event.preventDefault();
			// 确认门禁：will-frame-navigate 对所有 iframe 触发且无 userGesture 信息，
			// 任意远程脚本/隐藏 iframe 都可能反复唤起系统处理器；只有主 frame 的
			// 请求才值得打扰用户，subframe 一律拦截记日志。
			if (!event.isMainFrame) {
				void deps.appLogger.warn("browser", "Blocked non-main-frame external protocol request", { phase, url: event.url });
				return;
			}
			if (isAllowedGuestSystemProtocol(event.url)) {
				void deps.requestExternalProtocolConfirmation(event.url);
				return;
			}
			void deps.appLogger.warn("browser", "Blocked unsafe webview navigation", { phase, url: event.url });
		};
		guest.on("will-frame-navigate", (event) => blockUnsafeNavigation(event, "navigate"));
		guest.on("will-redirect", (event) => blockUnsafeNavigation(event, "redirect"));
		guest.setWindowOpenHandler(({ url }) => {
			// guest 弹窗统一在此接管（Electron 22 起 webview new-window 事件已移除，
			// 渲染层监听不到；且弹窗能力已在 will-attach-webview 经 webPreferences
			// 强制开启，弹窗流才能到达本 handler）：一律 deny 创建真实窗口，按 URL 策略分发。
			if (url !== "about:blank" && isAllowedBrowserPanelUrl(url)) {
				void deps.openExternalUrl(url);
			} else if (isAllowedGuestSystemProtocol(url)) {
				// 网页触发的 mailto:/tel: 等通信深链：同样交确认流（window.open 无用户
				// 手势信息可依赖，不直接启动系统处理器）。
				void deps.requestExternalProtocolConfirmation(url);
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
