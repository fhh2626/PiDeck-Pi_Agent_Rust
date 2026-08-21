import { session, type BrowserWindow } from "electron";
import { isDevToolsShortcut, toggleMainWindowDevTools } from "../devTools";
import type { AppLogger } from "../logging/AppLogger";
import { BROWSER_PANEL_PARTITION, isAllowedBrowserPanelUrl } from "./browserSecurity";

/** Electron does not expose webRequest listener removal, so the shared partition installs it once. */
let browserPanelRequestInstalled = false;

type BrowserPanelWebviewHostDeps = {
	appLogger: AppLogger;
	openExternalUrl: (url: string) => Promise<void>;
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
		delete params.allowpopups;

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
			event.preventDefault();
			void deps.appLogger.warn("browser", "Blocked unsafe webview navigation", { phase, url: event.url });
		};
		guest.on("will-frame-navigate", (event) => blockUnsafeNavigation(event, "navigate"));
		guest.on("will-redirect", (event) => blockUnsafeNavigation(event, "redirect"));
		guest.setWindowOpenHandler(({ url }) => {
			if (url !== "about:blank" && isAllowedBrowserPanelUrl(url)) {
				void deps.openExternalUrl(url);
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
