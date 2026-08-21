import type { BrowserWindow } from "electron";
import type { AppSettings } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { RpcRouter } from "../transport/RpcRouter";

export interface BackendPaths {
	home: string;
	userData: string;
	appPath: string;
	resourcesPath: string;
}

export interface BackendAppInfo {
	version: string;
	locale: string;
	isPackaged: boolean;
	devRendererUrl?: string;
}

export interface BackendHost {
	getMainWindow(): BrowserWindow | null;
	sendToRenderer(channel: string, ...args: unknown[]): void;
	openExternalUrl(url: string, forceSystem?: boolean): Promise<void>;
	applyNativeThemeSource(settings: AppSettings): void;
	refreshTrayContextMenu(): void;
	takePendingFocusTarget(): { sessionId: string } | null;
	readonly quittingState: {
		value: boolean;
	};
}

export interface CreateBackendOptions {
	router: RpcRouter;
	paths: BackendPaths;
	appInfo: BackendAppInfo;
	host: BackendHost;
}

export interface Backend {
	readonly appLogger: AppLogger;
	readonly settingsStore: SettingsStore;
	readonly mainCopy: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	resolveSessionIdForAgent(agentId: string): string | undefined;
	hasActiveStreaming(): boolean;
	startAfterWindowCreated(): void;
	dispose(): void;
}
