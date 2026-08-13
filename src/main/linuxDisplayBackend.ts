import { app } from "electron";

type DisplayBackendInput = {
	platform?: NodeJS.Platform | "linux";
	env?: NodeJS.ProcessEnv;
	argv?: string[];
};

type CommandLineSwitch = {
	name: string;
	value?: string;
};

const BACKEND_ENV = "PIDECK_LINUX_DISPLAY_BACKEND";
const DISABLE_GPU_ENV = "PIDECK_LINUX_DISABLE_GPU";

function normalizeBackend(value: string | undefined) {
	return value?.trim().toLowerCase();
}

function hasArg(argv: string[], name: string) {
	return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function shouldDisableGpuForXWayland(env: NodeJS.ProcessEnv) {
	return normalizeBackend(env[DISABLE_GPU_ENV]) !== "0";
}

/**
 * Linux 默认保持系统原生显示后端。只有用户显式设置
 * `PIDECK_LINUX_DISPLAY_BACKEND=x11` 时才切换到 XWayland；`=wayland` 强制原生 Wayland。
 */
export function getLinuxDisplayBackendSwitches(
	input: DisplayBackendInput = {},
): CommandLineSwitch[] {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const argv = input.argv ?? process.argv;
	if (platform !== "linux") return [];

	const requestedBackend = normalizeBackend(env[BACKEND_ENV]);
	if (requestedBackend === "wayland") return [];
	if (hasArg(argv, "--ozone-platform") || hasArg(argv, "--ozone-platform-hint")) {
		return [];
	}

	if (requestedBackend !== "x11") return [];

	const isWaylandSession =
		normalizeBackend(env.XDG_SESSION_TYPE) === "wayland" ||
		Boolean(env.WAYLAND_DISPLAY);
	const hasXWaylandDisplay = Boolean(env.DISPLAY);
	if (!isWaylandSession || !hasXWaylandDisplay) return [];

	const switches = [{ name: "ozone-platform", value: "x11" }];
	if (!hasArg(argv, "--log-level")) {
		switches.push({ name: "log-level", value: "3" });
	}
	return switches;
}

export function applyLinuxDisplayBackendWorkaround() {
	const switches = getLinuxDisplayBackendSwitches();
	if (
		switches.some(
			(item) => item.name === "ozone-platform" && item.value === "x11",
		) &&
		shouldDisableGpuForXWayland(process.env)
	) {
		app.disableHardwareAcceleration();
	}
	for (const item of switches) {
		if (item.value === undefined) app.commandLine.appendSwitch(item.name);
		else app.commandLine.appendSwitch(item.name, item.value);
	}
}

export function isUsingLinuxXWaylandWorkaround() {
	return getLinuxDisplayBackendSwitches().some(
		(item) => item.name === "ozone-platform" && item.value === "x11",
	);
}
