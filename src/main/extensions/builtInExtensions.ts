import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * PiDeck 内置扩展（随应用 resources 分发，不再复制到 ~/.pi/agent/extensions）。
 * 启动 RPC 时通过可重复的 `--extension/-e` 注入，避免污染用户全局 pi。
 */
export const BUILT_IN_EXTENSIONS = [
	"pi-deck-ask-question.ts",
	"pi-deck-context-controller.ts",
	"pi-deck-nul-redirect-fix.ts",
	"pi-deck-plan-mode.ts",
	"pi-deck-security-gate.ts",
	"pi-deck-todo.ts",
	"pi-deck-vision.ts",
	"pi-better-compaction.ts",
] as const;

export type BuiltInExtensionName = (typeof BUILT_IN_EXTENSIONS)[number];

/** 出厂默认关闭的内置扩展；用户可在设置页恢复。 */
export const DEFAULT_DISABLED_BUILT_IN_EXTENSIONS = [
	"pi-better-compaction.ts",
] as const satisfies readonly BuiltInExtensionName[];

/** 每次新增默认关闭的内置扩展时递增，用于老配置的一次性迁移。 */
export const BUILT_IN_EXTENSION_DEFAULTS_VERSION = 1;

export function migrateBuiltInExtensionDefaults(
	removedBuiltInExtensions: readonly string[] | undefined,
	persistedVersion: number | undefined,
): {
	removedBuiltInExtensions: string[];
	version: number;
	migrated: boolean;
} {
	if (persistedVersion === BUILT_IN_EXTENSION_DEFAULTS_VERSION) {
		return {
			removedBuiltInExtensions: [...(removedBuiltInExtensions ?? [])],
			version: persistedVersion,
			migrated: false,
		};
	}

	const next = new Set(removedBuiltInExtensions ?? []);
	for (const name of DEFAULT_DISABLED_BUILT_IN_EXTENSIONS) {
		next.add(name);
	}
	return {
		removedBuiltInExtensions: [...next],
		version: BUILT_IN_EXTENSION_DEFAULTS_VERSION,
		migrated: true,
	};
}

export type BuiltInExtensionPathRoots = {
	/** 开发态 app 根（含 resources/extensions） */
	appPath: string;
	/** 打包态 process.resourcesPath（extraResources 的 extensions/） */
	resourcesPath: string;
	isDev: boolean;
};

/** 校验 source 是否为允许的内置扩展 basename（防路径穿越）。 */
export function isBuiltInExtensionName(source: string): source is BuiltInExtensionName {
	const name = basename(source.trim());
	return (BUILT_IN_EXTENSIONS as readonly string[]).includes(name) && name === source.trim();
}

/**
 * 解析单个内置扩展在本机磁盘上的绝对路径。
 * 开发态读 appPath/resources/extensions；打包态读 resourcesPath/extensions。
 */
export function resolveBuiltInExtensionPath(
	extensionName: string,
	roots: BuiltInExtensionPathRoots,
): string {
	const name = basename(extensionName.trim());
	if (!isBuiltInExtensionName(name)) {
		throw new Error(`非法内置扩展名: ${extensionName}`);
	}
	return roots.isDev
		? join(roots.appPath, "resources", "extensions", name)
		: join(roots.resourcesPath, "extensions", name);
}

/**
 * 返回当前应注入到 pi RPC 的内置扩展绝对路径列表。
 * - removedBuiltInExtensions 中的跳过
 * - 源文件缺失的跳过（打日志由调用方处理）
 * - piRpcNoExtensions 由调用方决定是否整段跳过
 */
export function listActiveBuiltInExtensionPaths(
	roots: BuiltInExtensionPathRoots,
	removedBuiltInExtensions: readonly string[] = [],
): string[] {
	const removed = new Set(
		removedBuiltInExtensions.map((item) => basename(item.trim())).filter(Boolean),
	);
	const paths: string[] = [];
	for (const name of BUILT_IN_EXTENSIONS) {
		if (removed.has(name)) continue;
		const fullPath = resolveBuiltInExtensionPath(name, roots);
		if (!existsSync(fullPath)) continue;
		paths.push(fullPath);
	}
	return paths;
}

/**
 * 把内置扩展路径追加为可重复的 `--extension <path>`。
 * pi 文档：`--no-extensions` 只关自动发现，显式 -e 仍有效；
 * 但 PiDeck 约定 piRpcNoExtensions 时连内置也不注入（诊断干净）。
 */
export function appendBuiltInExtensionArgs(
	args: readonly string[],
	extensionPaths: readonly string[],
	options: { noExtensions?: boolean } = {},
): string[] {
	if (options.noExtensions || extensionPaths.length === 0) return [...args];
	const next = [...args];
	for (const extensionPath of extensionPaths) {
		const trimmed = extensionPath.trim();
		if (!trimmed) continue;
		next.push("--extension", trimmed);
	}
	return next;
}
