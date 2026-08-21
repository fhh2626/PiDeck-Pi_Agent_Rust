import { Menu, nativeImage, Tray } from "electron";

type AppTrayLabels = {
	showWindow: string;
	restart: string;
	quit: string;
};

type AppTrayActions = {
	showWindow: () => void;
	restart: () => void;
	quit: () => void;
};

/** Creates the app tray icon and keeps its platform-specific activation behavior local. */
export function createAppTray(iconPath: string, showWindow: () => void): Tray {
	const icon = nativeImage.createFromPath(iconPath);
	const tray = new Tray(icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("PiDeck-Q");
	tray.on("double-click", showWindow);
	return tray;
}

/** Rebuilds localized tray commands without coupling the tray module to SettingsStore. */
export function refreshAppTrayMenu(
	tray: Tray,
	labels: AppTrayLabels,
	actions: AppTrayActions,
): void {
	tray.setContextMenu(Menu.buildFromTemplate([
		{ label: labels.showWindow, click: actions.showWindow },
		{ type: "separator" },
		{ label: labels.restart, click: actions.restart },
		{ type: "separator" },
		{ label: labels.quit, click: actions.quit },
	]));
}
