import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	nativeTheme,
	net,
	protocol,
	session,
	shell,
	Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { is } from "@electron-toolkit/utils";
import {
	applyLinuxDisplayBackendWorkaround,
	isUsingLinuxXWaylandWorkaround,
} from "./linuxDisplayBackend";
import {
	readElectronChromiumSandboxPreference,
	readSingleInstancePreference,
} from "./settings/SettingsStore";
import { acquireVersionSingleInstance, type FocusPayload } from "./singleInstance";
import { extractFocusTargetFromArgv } from "./utils/focusTarget";
import type { Project, StartupWindowMode } from "../shared/types";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";

// 构建标记：npm run dist:win:dev 打包时由 vite define 注入 true（构建期替换，非运行时环境变量）。
declare const __PIDECK_DEV_BUILD__: boolean;

// 开发态（electron-vite dev）或 dev 构建（dist:win:dev）统一使用 -dev 配置目录，
// 避免与正式版（pi-desktop / PiDeck）的数据、单实例锁和通知归属互相污染。
const isDevBuild = !app.isPackaged || __PIDECK_DEV_BUILD__;

// 开发态与正式版隔离 userData。
// 否则 npm run dev 会与已安装的 PiDeck 共用数据/锁，表现为「开发启动被复用到正式版窗口」。
// 必须在读取 settings / 版本单实例锁之前设置。
if (isDevBuild) {
	// 显式固定为 pi-desktop-dev：dev 构建的 productName 是 PiDeckDev，
	// 默认 userData 会落在 %APPDATA%\PiDeckDev，必须指回 dev 配置目录以复用现有配置。
	// 例外：命令行显式传入 --user-data-dir（e2e 隔离、多实例调试）时尊重该路径，
	// 否则 e2e 会读到本机真实开发数据（settings/projects 全部污染测试断言）。
	const explicitUserDataDir = process.argv.find((arg) => arg.startsWith("--user-data-dir="));
	if (!explicitUserDataDir) {
		app.setPath("userData", join(app.getPath("appData"), "pi-desktop-dev"));
	}
}

// 用户显式指定 X11 时必须在 app.ready 前应用；默认保持系统原生显示后端。
applyLinuxDisplayBackendWorkaround();

// Chromium 沙箱开关必须在 app.ready 前生效。
// 默认关闭：Windows 上部分安全软件/旧 GPU 驱动会在沙箱初始化时触发原生断点（0x80000003）。
// 用户可在「开发设置」中开启 electronChromiumSandbox，重启后走 Chromium 默认沙箱。
const electronChromiumSandboxEnabled = readElectronChromiumSandboxPreference();
if (!electronChromiumSandboxEnabled) {
	// 关闭沙箱时显式附带 no-sandbox，避免部分环境仍按默认策略启用。
	app.commandLine.appendSwitch("no-sandbox");
}

// V8 老生代堆上限（渲染进程 + 主进程 + worker 一并生效）：
// Chromium 默认上限 ≈ 物理内存 60%（8GB 机器 ≈ 4.8GB），V8 没有压力就不主动收缩，
// 会话消息/代码块高亮等大对象把堆撑大后 committed 空间长期不归还 OS（内存采样实测：
// V8 总 55MB → 210MB 不回落，RSS 基线随每次操作抬升）。
// 设 384MB：留 2 倍于实测 JS used 峰值（~185MB）的余量，超限即强制 GC 收缩。
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=384");

// Windows 系统通知必须设置 AppUserModelID，否则通知不显示、点击事件不触发。
// dev 与正式版使用不同 AppID，避免通知中心归属混淆（与 dev userData 隔离思路一致）。
if (process.platform === "win32") {
	app.setAppUserModelId(isDevBuild ? "com.ayuayue.pi-desktop-dev" : "com.ayuayue.pi-desktop");
}

// 注册 pideck:// 自定义协议：系统通知点击（toast activationType="protocol"）通过该协议唤起应用，
// 唤起实例的 argv 携带 pideck://session/<id> URL，主进程据此跳转对应会话。
// 仅 packaged 应用注册：dev 模式跑的是 electron 二进制，注册会把协议关联劫持到 electron.exe，
// 覆盖已安装正式版的关联；dev 模式下通知点击依赖 Electron 原生 click 事件聚焦即可。
// 安装包内 electron-builder 的 protocols 配置也会在安装时写入注册表，此处是运行时兜底。
if (app.isPackaged) {
	app.setAsDefaultProtocolClient("pideck");
}

// 按「应用版本」隔离的单实例：同版本复用窗口，不同版本可并行。
// 不用 Electron requestSingleInstanceLock：它按 userData 全局互斥，会导致 0.6.7 与 0.6.8 无法同开。
// focus 回调稍后挂到 focusMainWindow（定义在文件后部），避免顶层 TDZ。
// payload 携带次实例的 argv，可解析「点击系统通知」激活时携带的跳转目标。
let focusExistingWindow: ((payload?: FocusPayload) => void) | null = null;
const singleInstanceEnabled = readSingleInstancePreference();
const versionSingleInstance = acquireVersionSingleInstance(
	singleInstanceEnabled,
	app.getVersion(),
	(payload) => {
		focusExistingWindow?.(payload);
	},
);
const gotSingleInstanceLock = versionSingleInstance.isPrimary;
if (singleInstanceEnabled && !gotSingleInstanceLock) {
	// 同版本已有实例：立即退出，由主实例 watch .focus 后唤起窗口。
	// 用 exit(0) 而不是 quit()：第二进程尚未 ready，quit 更慢。
	app.exit(0);
}


// 开发模式下 stdout 管道可能断开导致 EPIPE 崩溃，全局静默处理
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});

process.on("uncaughtException", (error) => {
	void appLogger?.error("process", "Uncaught exception", error);
	console.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
	void appLogger?.error("process", "Unhandled rejection", reason);
	console.error("Unhandled rejection:", reason);
});
import { ipcChannels } from "../shared/ipc";
import {
	mainProcessT,
	normalizeMainProcessLocale,
	type MainProcessLocale,
	type MainProcessTranslationKey,
} from "../shared/i18n/mainProcessCopy";
import {
	buildSessionOriginKey,
	canonicalizeSessionPath,
	toAbsoluteSessionPath,
} from "../shared/sessionIdentity";
import type {
	AgentTab,
	AgentUiRequest,
	AppSettings,
	AppUpdateAsset,
	AppUpdateDownloadProgress,
	AppLogLevel,
	AppLogQuery,
	AppUpdateDownloadResult,
	AvailableModel,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	AppUpdateInfo,
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	SendPromptInput,
	SendPromptResult,
	SendSessionPromptInput,
	SessionRecord,
	SessionCommandError,
	SessionCommandResult,
	SessionRuntimeEvent,
	SessionRuntimeTarget,
	SessionUiResponseInput,
	CreatePiPromptTemplateInput,
	CreatePiSkillInput,
	PiPromptTemplateSummary,
	PromptStoreSearchResult,
	PromptStoreSearchResponse,
	PromptStoreRawItem,
	PromptStoreItem,
	YaoPromptListResult,
	YaoPromptDetailResult,
} from "../shared/types";
import { ProjectStore } from "./projects/ProjectStore";
import { FileSystemService } from "./fs/FileSystemService";
import { AgentManager } from "./pi/AgentManager";
import { PiLocator } from "./pi/PiLocator";
import { testPiProxy } from "./pi/PiProxyTester";
import { SessionScanner } from "./sessions/SessionScanner";
import {
	SessionCatalog,
	canAttachRuntimeMetadata,
} from "./sessions/SessionCatalog";
import {
	SessionRuntimeCoordinator,
	type SessionRuntimeBinding,
} from "./sessions/SessionRuntimeCoordinator";
import { SessionCommandIpcError } from "./sessions/SessionCommandIpcError";
import {
	DEFAULT_CONTEXT_CONTROLLER_STATE,
	parseContextControllerStateFromJsonl,
} from "./sessions/contextControllerStateReader";
import { CodexSessionImporter } from "./sessions/CodexSessionImporter";
import { ClaudeSessionImporter } from "./sessions/ClaudeSessionImporter";
import { OpenCodeSessionImporter } from "./sessions/OpenCodeSessionImporter";
import { SettingsStore } from "./settings/SettingsStore";
import { SecurityStore } from "./security/SecurityStore";
import { applyDesktopProxy } from "./settings/DesktopProxy";
import { GitService } from "./git/GitService";
import { WorktreeService } from "./git/WorktreeService";
import { ConfigManager } from "./config/ConfigManager";
import { TerminalSessionManager } from "./terminal/TerminalSessionManager";
import { PromptManager } from "./prompts/PromptManager";
import { XuePromptManager } from "./prompts/XuePromptManager";
import { SkillManager } from "./skills/SkillManager";
import { ExtensionManager } from "./extensions/ExtensionManager";
import { ProjectResourceManager } from "./projects/ProjectResourceManager";
import { listVisibleProjects, registerProjectsIpc } from "./ipc/projectsIpc";
import { registerUsageStatsIpc } from "./ipc/usageStatsIpc";
import { UsageStatsService } from "./usageStats/UsageStatsService";
import { readLastWindowBounds, saveLastWindowBounds } from "./windowState";
import { createRendererCrashRecoveryGuard } from "./window/rendererCrashRecovery";
import {
	registerBackgroundImageProtocol,
	registerBackgroundsIpc,
} from "./ipc/backgroundsIpc";
import { registerGitIpc } from "./ipc/gitIpc";
import { registerStoreIpc } from "./ipc/storeIpc";
import { registerTerminalIpc } from "./ipc/terminalIpc";
import { registerScratchPadIpc } from "./ipc/scratchPadIpc";
import { registerSecurityIpc } from "./ipc/securityIpc";
import { registerVisionIpc } from "./ipc/visionIpc";
import { VisionBridgeConfigManager } from "./settings/visionBridgeConfig";
import { registerSessionIpc, scheduleCatalogBackgroundScan } from "./ipc/sessionIpc";
import { registerSystemIpc } from "./ipc/systemIpc";
import { fetchModelList, getCachedModelList, refreshModelList } from "./pi/modelListCache";
import { ModelSpecsStore } from "./pi/modelSpecsStore";
import { registerFilesIpc } from "./ipc/filesIpc";
import {
	BROWSER_PANEL_PARTITION as BROWSER_PANEL_PARTITION_SHARED,
	isAllowedBrowserPanelUrl as isAllowedBrowserPanelUrlShared,
} from "./browser/browserSecurity";
import { WebServiceManager } from "./web/WebServiceManager";
import { preparePreloadPath } from "./preloadPath";
import { AppLogger } from "./logging/AppLogger";
import { setAppLogger } from "./logging/sharedLogger";
import { RpcLogger } from "./logging/RpcLogger";
import { registerEditorsIpc } from "./ipc/editorsIpc";
import {
	detectExternalEditors,
	listConfiguredExternalEditors,
	mergeDetectedExternalEditors,
	openProjectInEditor,
	validateExternalEditorCommand,
} from "./editors/EditorDetector";
import { startMemoryProfile, isMemoryProfileEnabled, type MemoryProfileHandle } from "./memory/MemoryMonitor";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
/** 渲染进程崩溃自动恢复守卫（2026-08 黑屏治理，见 window/rendererCrashRecovery.ts）：
 *  非正常崩溃自动 reload 恢复，崩溃风暴（60s 内超 2 次）放弃。 */
const rendererCrashGuard = createRendererCrashRecoveryGuard();
let projectStore: ProjectStore;
let fileSystemService: FileSystemService;
let sessionScanner: SessionScanner;
let sessionCatalog: SessionCatalog;
let sessionRuntimeCoordinator: SessionRuntimeCoordinator;
let codexSessionImporter: CodexSessionImporter;
let claudeSessionImporter: ClaudeSessionImporter;
let openCodeSessionImporter: OpenCodeSessionImporter;
let settingsStore: SettingsStore;
let securityStore: SecurityStore;
let worktreeService: WorktreeService;
let gitService: GitService;
let piLocator: PiLocator;
let agentManager: AgentManager;
let configManager: ConfigManager;
let promptManager: PromptManager;
let xuePromptManager: XuePromptManager;
let skillManager: SkillManager;
let extensionManager: ExtensionManager;
let projectResourceManager: ProjectResourceManager;
let webServiceManager: WebServiceManager;
let terminalManager: TerminalSessionManager;
let appLogger: AppLogger;
let rpcLogger: RpcLogger;
/** 内存采样句柄（PIDECK_MEMORY_PROFILE=1 时启用），quit 时停止 */
let memoryProfileHandle: MemoryProfileHandle | null = null;
let usageStatsService: UsageStatsService | null = null;


function sendSessionRuntimeEnvelope(event: SessionRuntimeEvent): void {
	const window = mainWindow;
	if (window && !window.isDestroyed()) {
		window.webContents.send(ipcChannels.sessionsRuntimeEvent, event);
	}
}

function emitSessionRuntimeEvent(
	agentId: string,
	sourceChannel: string,
	payload: unknown,
): boolean {
	const runtimeBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
	if (!runtimeBinding) return false;
	const event: SessionRuntimeEvent = {
		kind: "event",
		sessionId: runtimeBinding.sessionId,
		agentId,
		runtimeGeneration: runtimeBinding.runtimeGeneration,
		sourceChannel,
		payload,
	};
	sessionRuntimeCoordinator.observeRuntimeEvent(event);
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		const tab = payload as Partial<AgentTab>;
		if (typeof tab.sessionPath === "string" && tab.sessionPath) {
			const entry = sessionCatalog.get(runtimeBinding.sessionId);
			if (
				canAttachRuntimeMetadata(entry, tab) &&
				(entry?.filePath !== tab.sessionPath || entry.piSessionId !== tab.sessionId)
			) {
				void sessionCatalog.attachRuntime({
					sessionId: runtimeBinding.sessionId,
					filePath: tab.sessionPath,
					piSessionId: tab.sessionId,
				}).catch(() => undefined);
			}
		}
	}
	sendSessionRuntimeEnvelope(event);
	const tab = payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Partial<AgentTab>
		: undefined;
	// A crashed anonymous process has no durable session to reopen. The regular
	// Agent state event reaches the renderer first so diagnostics remain visible
	// for the current tick, then detach removes the transient conversation.
	if (tab?.noSession && tab.status === "closed") {
		sessionRuntimeCoordinator.unbindTerminalAgent(agentId);
		discardAnonymousSession({ ...runtimeBinding, agentId });
	}
	return true;
}

function emitSessionRuntimeDetach(binding: SessionRuntimeBinding): void {
	sendSessionRuntimeEnvelope({
		kind: "detach",
		sessionId: binding.sessionId,
		agentId: binding.agentId,
		runtimeGeneration: binding.runtimeGeneration,
		sourceChannel: "sessions:runtime-detach",
		payload: null,
	});
}

/**
 * Anonymous chats have no catalog file to rediscover. Once their runtime stops,
 * discard the in-memory record after broadcasting detach so every renderer can
 * remove its transient Session state.
 */
function discardAnonymousSession(binding: SessionRuntimeBinding): void {
	if (!sessionCatalog.get(binding.sessionId)?.noSession) return;
	sessionCatalog.removeTransient(binding.sessionId);
	emitSessionRuntimeDetach(binding);
}

async function createAnonymousSession(
	input: CreateAnonymousSessionInput,
): Promise<CreateAnonymousSessionResult> {
	const project = projectStore.get(input.projectId);
	if (!project) throw new Error(mainCopy("project.notFound"));

	// Resolve pi-configured defaults so the composer bar shows the effective
	// model / thinking level even before the anonymous Agent is fully started.
	let model = input.model;
	let thinkingLevel = input.thinkingLevel;
	try {
		// 引导页显式选择优先于 pi 配置；下面只为缺失字段补默认值。
		const [settingsResult, modelsResult] = await Promise.all([
			configManager.getSettingsConfig(),
			configManager.getModelsConfig(),
		]);
		const settings = settingsResult.parsed;
		const defaultProvider = typeof settings.defaultProvider === "string"
			? settings.defaultProvider
			: undefined;
		const defaultModelId = typeof settings.defaultModel === "string"
			? settings.defaultModel
			: undefined;
		if (!model && defaultProvider && defaultModelId) {
			model = { provider: defaultProvider, modelId: defaultModelId };
		} else if (!model) {
			const providers = modelsResult.parsed?.providers;
			if (providers) {
				const firstProviderName = Object.keys(providers)[0];
				const firstProvider = firstProviderName ? providers[firstProviderName] : undefined;
				const firstModel = firstProvider?.models?.[0];
				if (firstProviderName && firstModel?.id) {
					model = { provider: firstProviderName, modelId: firstModel.id };
				}
			}
		}
		const level = typeof settings.defaultThinkingLevel === "string"
			? settings.defaultThinkingLevel
			: undefined;
		if (!thinkingLevel) thinkingLevel = level;
	} catch {
		// Config read is best-effort.
	}

	const session = sessionCatalog.createAnonymous({
		projectId: project.id,
		title: input.title?.trim() || mainCopy("session.anonymousTitle", { project: project.name }),
		environment: settingsStore.get().wslEnabled ? "wsl" : "native",
		model,
		thinkingLevel,
	});
	// Agent 启动可能包含 spawn/get_state/历史准备；匿名会话先返回可选中的 Session，
	// 再后台绑定 runtime。这样欢迎页点击后能立即进入输入框，启动失败仍通过 detach/日志收敛。
	void activateAnonymousRuntime(session, project, input).catch(() => undefined);
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: session.projectId });
	}
	return { session };
}

async function activateAnonymousRuntime(
	session: SessionRecord,
	project: Project,
	input: CreateAnonymousSessionInput,
): Promise<void> {
	let agentId: string | undefined;
	try {
		const tab = await agentManager.create({
			projectId: project.id,
			title: session.title,
			environment: session.environment,
			source: "pi",
			wslDistro: session.wslDistro,
			wslUser: session.wslUser,
			noSession: true,
		});
		agentId = tab.id;
		const runtime = sessionRuntimeCoordinator.bindAnonymousRuntime(session.id, tab.id);
		// Anonymous Agent 使用 --no-session 创建，不会经过普通 activateRuntime 的恢复流程；
		// 因此在绑定后显式应用引导页选择，确保 pi 不再按自身默认优先级启动。
		if (input.model) {
			const result = await sessionRuntimeCoordinator.setRuntimeModel(runtime, input.model.provider, input.model.modelId);
			if (!result.ok) throw new Error(result.error.code);
		}
		if (input.thinkingLevel) {
			const result = await sessionRuntimeCoordinator.setRuntimeThinking(runtime, input.thinkingLevel);
			if (!result.ok) throw new Error(result.error.code);
		}
		emitReplacementState(runtime, true);
	} catch (error) {
		if (agentId) await agentManager.stop(agentId).catch(() => undefined);
		sessionCatalog.removeTransient(session.id);
		// createUnlocked 内部已尽量把 pi 启动失败落到会话错误卡；这里兜底信任/项目查找等
		// 前置异常，保证异步匿名启动失败仍可诊断且不会留下不可用的临时行。
		void appLogger.error("agent", "Agent create IPC failed", {
			projectId: project.id,
			title: input.title,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			platform: process.platform,
			arch: process.arch,
		});
	}
}

async function stopSessionRuntime(target: SessionRuntimeTarget) {
	const anonymous = sessionCatalog.get(target.sessionId)?.noSession === true;
	const result = await sessionRuntimeCoordinator.stopRuntime(target);
	if (result.ok) {
		terminalManager.closeAgent(target.agentId);
		if (anonymous) discardAnonymousSession(target);
		else emitSessionRuntimeDetach(target);
	}
	return result;
}

/**
 * 进程监控「停止 agent」入口：调用方只有 agentId，由 coordinator 反查会话并走
 * 完整停止链路（保留/解绑 + 关终端 + detach 推送）。与 stopSessionRuntime 的
 * 区别仅在于 target 的来源；不这么做的话渲染层收不到 detach，会话运行标记
 * 会停留在 running（用户可见的「停止后蓝点不变」现象）。
 */
async function stopAgentFromMonitor(
	agentId: string,
): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
	const result = await sessionRuntimeCoordinator.stopAgentById(agentId);
	if (!result.ok) return result;
	terminalManager.closeAgent(agentId);
	if (result.value) emitSessionRuntimeDetach(result.value);
	return result;
}

function emitReplacementState(binding: SessionRuntimeBinding, includeMessages: boolean): void {
	const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
	if (!tab) return;
	emitSessionRuntimeEvent(binding.agentId, ipcChannels.agentsState, tab);
	if (includeMessages) {
		// 与 flush 同一窗口协议：只下发显示窗口段 + windowStart/totalLength/fileVersion，
		// 渲染层合并逻辑一处生效（窗口前历史由 disk 轮次分页 prepend）
		emitSessionRuntimeEvent(binding.agentId, ipcChannels.agentsMessage, {
			agentId: binding.agentId,
			...agentManager.getMessageWindow(binding.agentId),
		});
	}
}

async function readCatalogSessionReferenceMessages(sessionId: string) {
	const entry = sessionCatalog.get(sessionId);
	if (!entry?.filePath) return [];
	return sessionScanner.readMessages(entry.filePath);
}

async function copyCatalogSession(sessionId: string) {
	const entry = sessionCatalog.get(sessionId);
	if (!entry?.filePath) throw new Error(mainCopy("session.fileNotFound"));
	const result = await agentManager.cloneSessionFile(entry.projectId, entry.filePath, entry.environment) as {
		cancelled?: boolean;
		sessionPath?: string;
	};
	if (result.cancelled || !result.sessionPath) return { cancelled: true };
	const copied = await sessionCatalog.ensureRuntimeTarget({
		projectId: entry.projectId,
		title: entry.title,
		source: entry.source,
		environment: entry.environment,
		filePath: result.sessionPath,
		wslDistro: entry.wslDistro,
		wslUser: entry.wslUser,
		importedSourceId: entry.importedSourceId,
	});
	return { cancelled: false, targetSessionId: copied.id };
}

async function exportCatalogSessionHtml(sessionId: string): Promise<{ path: string }> {
	const entry = sessionCatalog.get(sessionId);
	if (!entry?.filePath) throw new Error(mainCopy("session.fileNotFound"));
	const result = await agentManager.exportSessionHtml(entry.projectId, entry.filePath);
	if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string") {
		throw new Error(mainCopy("session.exportFailed"));
	}
	return { path: result.path };
}

type AgentSessionReplacementResult = {
	cancelled?: boolean;
	[key: string]: unknown;
};

async function replaceAgentSession(
	agentId: string,
	replace: () => Promise<unknown>,
): Promise<AgentSessionReplacementResult & { targetSessionId?: string }> {
	const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
	const originEntry = originBinding
		? sessionCatalog.get(originBinding.sessionId)
		: undefined;
	const originKey = originEntry?.filePath
		? buildSessionOriginKey({
			source: originEntry.source,
			environment: originEntry.environment,
			filePath: originEntry.filePath,
			wslDistro: originEntry.wslDistro,
			wslUser: originEntry.wslUser,
			importedSourceId: originEntry.importedSourceId,
		})
		: undefined;
	return sessionRuntimeCoordinator.replaceBoundRuntime({
		agentId,
		replace: async () => {
			const result = await replace();
			return result && typeof result === "object" && !Array.isArray(result)
				? result as AgentSessionReplacementResult
				: {};
		},
		resolveTargetSessionId: async () => {
			const tab = agentManager.list().find((candidate) => candidate.id === agentId);
			if (!tab?.sessionPath) {
				throw new Error(`Replacement runtime has no session path: ${agentId}`);
			}
			const environment = tab.sessionEnvironment ?? originEntry?.environment ?? "native";
			const target = await sessionCatalog.ensureRuntimeTarget({
				projectId: tab.projectId,
				title: tab.title,
				source: tab.sessionSource ?? originEntry?.source ?? "pi",
				environment,
				filePath: tab.sessionPath,
				wslDistro: tab.wslDistro ?? (environment === "wsl" ? originEntry?.wslDistro : undefined),
				wslUser: tab.wslUser ?? (environment === "wsl" ? originEntry?.wslUser : undefined),
				importedSourceId: tab.importedSourceId ?? originEntry?.importedSourceId,
				piSessionId: tab.sessionId,
			});
			return target.id;
		},
		canRestoreOrigin: () => {
			const tab = agentManager.list().find((candidate) => candidate.id === agentId);
			if (!originKey || !tab?.sessionPath) return false;
			return buildSessionOriginKey({
				source: tab.sessionSource ?? "pi",
				environment: tab.sessionEnvironment ?? "native",
				filePath: tab.sessionPath,
				wslDistro: tab.wslDistro,
				wslUser: tab.wslUser,
				importedSourceId: tab.importedSourceId,
			}) === originKey;
		},
		onDetached: emitSessionRuntimeDetach,
		onAttached: (binding) => emitReplacementState(binding, true),
		onRestored: (binding) => emitReplacementState(binding, false),
	});
}

function cancelUnboundUiRequest(payload: unknown): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const request = payload as Partial<AgentUiRequest>;
	if (
		typeof request.agentId !== "string" ||
		typeof request.requestId !== "string" ||
		request.completed === true ||
		!(["select", "confirm", "input", "editor", "batch_ask"] as const).some(
			(method) => method === request.method,
		)
	) {
		return;
	}
	void appLogger.warn("session", "Cancelled unbound runtime UI request", {
		agentId: request.agentId,
		requestId: request.requestId,
		method: request.method,
	});
	void agentManager.sendUIResponse(request.agentId, request.requestId, { cancelled: true });
}

function applyNativeThemeSource(settings: AppSettings) {
	// 原生标题栏不受 renderer CSS 影响；跟随应用主题，避免暗色界面顶部仍是系统浅色栏。
	nativeTheme.themeSource = settings.theme === "system" ? "system" : settings.theme;
}

const RELEASES_URL = "https://github.com/ayuayue/pi-desktop/releases";
const LATEST_RELEASE_API =
	"https://api.github.com/repos/ayuayue/pi-desktop/releases/latest";

type GitHubReleaseAsset = {
	name: string;
	browser_download_url: string;
	size: number;
};

type GitHubRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: GitHubReleaseAsset[];
};

function normalizeVersion(version: string) {
	return version.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string) {
	const leftParts = normalizeVersion(left)
		.split(/[.-]/)
		.map((part) => Number(part) || 0);
	const rightParts = normalizeVersion(right)
		.split(/[.-]/)
		.map((part) => Number(part) || 0);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function selectRecommendedAsset(
	assets: AppUpdateAsset[],
	installationType?: "portable" | "installed",
) {
	const platform = process.platform;
	const arch = process.arch;
	// Windows 便携版以 electron-builder 注入的运行时环境变量为准；旧 settings 可能残留 installed。
	const isPortable =
		platform === "win32"
			? process.env.PORTABLE_EXECUTABLE_DIR !== undefined || installationType === "portable"
			: installationType === "portable";

	// 映射资产以便匹配
	const candidates = assets.map((asset) => ({
		...asset,
		lowerName: asset.name.toLowerCase(),
	}));

	// 根据架构确定关键词，严格匹配
	const archKeywords =
		arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "amd64", "x86_64"];
	const matchesArch = (name: string) =>
		archKeywords.some((keyword) => name.includes(keyword));

	// 检查是否为非目标架构（用于排除不匹配的资产）
	const isWrongArch = (name: string) => {
		if (arch === "arm64") {
			// 当前是 ARM64，排除 x64 相关的
			return /\b(x64|amd64|x86_64)\b/i.test(name);
		} else {
			// 当前是 x64，排除 arm64 相关的
			return /\b(arm64|aarch64)\b/i.test(name);
		}
	};

	const isWindowsAsset = (name: string) =>
		/\.(exe|msi)$/i.test(name) || (name.endsWith(".zip") && !/(mac|darwin|osx|linux|appimage|deb|tar\.gz)/i.test(name));
	const isMacAsset = (name: string) => /\.(dmg)$/i.test(name) || /(mac|darwin|osx)/i.test(name);
	const isLinuxAsset = (name: string) => /(appimage|\.deb$|\.tar\.gz$|linux)/i.test(name);

	if (platform === "win32") {
		// Windows 只能在 Windows 资产里挑选；Release 同时包含 macOS zip，不能用全局 zip 回退。
		const platformCandidates = candidates.filter((asset) => isWindowsAsset(asset.lowerName));
		// Windows: 优先匹配当前安装形态（便携版 vs 安装版）和架构
		if (isPortable) {
			// 便携版 exe 是单文件绿色版，无需安装；优先推荐非 Setup 的便携 exe，其次 .zip
			return (
				platformCandidates.find(
					(asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
				)
			);
		} else {
			// 安装版：优先推荐带 Setup 的安装 exe，其次普通 exe，最后 zip
			return (
				platformCandidates.find(
					(asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
				)
			);
		}
	}

	if (platform === "darwin") {
		// macOS 只在 macOS 资产中选择，避免 x64 zip 回退到 Windows/Linux 包。
		const platformCandidates = candidates.filter((asset) => isMacAsset(asset.lowerName));
		return (
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
			)
		);
	}

	if (platform === "linux") {
		// Linux 只在 Linux 资产中选择，避免跨平台 zip/exe 被误推荐。
		const platformCandidates = candidates.filter((asset) => isLinuxAsset(asset.lowerName));
		return (
			platformCandidates.find(
				(asset) => asset.lowerName.includes("appimage") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) =>
					asset.lowerName.includes("appimage") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && !isWrongArch(asset.lowerName),
			)
		);
	}

	// 回退：返回第一个匹配架构的资产
	return candidates.find((asset) => matchesArch(asset.lowerName)) ?? candidates[0];
}

async function checkForAppUpdate(
	installationType?: "portable" | "installed",
): Promise<AppUpdateInfo> {
	const currentVersion = app.getVersion();
	void appLogger.info("update", "Check for app update", { currentVersion, installationType });
	const response = await fetch(LATEST_RELEASE_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": `pi-desktop/${currentVersion}`,
		},
	});
	if (!response.ok) {
		void appLogger.warn("update", "GitHub release check failed", { status: response.status });
		throw new Error(mainCopy("update.checkFailed"));
	}
	const release = (await response.json()) as GitHubRelease;
	const latestVersion = normalizeVersion(release.tag_name || currentVersion);
	const assets = (release.assets ?? []).map((asset) => ({
		name: asset.name,
		url: asset.browser_download_url,
		size: asset.size,
	}));
	const recommendedAsset = selectRecommendedAsset(assets, installationType);
	void appLogger.info("update", "App update check completed", {
		currentVersion,
		latestVersion,
		hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		recommendedAsset: recommendedAsset?.name,
	});
	return {
		currentVersion,
		latestVersion,
		hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		releaseName: release.name || `v${latestVersion}`,
		releaseNotes: release.body || "",
		releaseUrl: release.html_url || RELEASES_URL,
		publishedAt: release.published_at,
		assets,
		recommendedAsset,
	};
}

function emitUpdateProgress(progress: AppUpdateDownloadProgress) {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(ipcChannels.appUpdateProgress, progress);
}

async function downloadUpdateAsset(asset: AppUpdateAsset): Promise<AppUpdateDownloadResult> {
	if (!asset.url || !/^https:\/\//i.test(asset.url)) {
		void appLogger.warn("update", "Rejected invalid update download URL", {
			assetName: asset.name,
			url: asset.url,
		});
		throw new Error(mainCopy("update.invalidDownloadUrl"));
	}

	const safeName = basename(asset.name).replace(/[<>:"/\\|?*]+/g, "-");
	const downloadDir = join(app.getPath("userData"), "updates");
	await mkdir(downloadDir, { recursive: true });
	const filePath = join(downloadDir, safeName);
	const startedAt = Date.now();
	let receivedBytes = 0;
	let totalBytes = asset.size > 0 ? asset.size : undefined;

	// 使用 Electron net 下载可继承 Chromium 的 TLS/代理能力；进度通过 IPC 推送给 renderer。
	return new Promise((resolve, reject) => {
			void appLogger.info("update", "Download update asset started", { assetName: asset.name, url: asset.url });
		const request = net.request({ method: "GET", url: asset.url });
		request.setHeader("User-Agent", `pi-desktop/${app.getVersion()}`);
		request.on("redirect", (_statusCode, _method, redirectUrl) => {
			// GitHub browser_download_url 通常会 302 到对象存储,必须显式跟随重定向。
			request.followRedirect();
			void appLogger.debug("update", "Follow update download redirect", { redirectUrl });
		});
		request.on("response", (response) => {
			if (response.statusCode < 200 || response.statusCode >= 300) {
				const publicError = new Error(mainCopy("update.downloadFailed"));
				void appLogger.warn("update", "Update download returned an error status", {
					assetName: asset.name,
					statusCode: response.statusCode,
				});
				emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
				reject(publicError);
				return;
			}

			const contentLength = Number(response.headers["content-length"]);
			if (Number.isFinite(contentLength) && contentLength > 0) totalBytes = contentLength;
			const output = createWriteStream(filePath);
			response.on("data", (chunk: Buffer) => {
				receivedBytes += chunk.length;
				output.write(chunk);
				const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
				emitUpdateProgress({
					assetName: asset.name,
					receivedBytes,
					totalBytes,
					percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
					bytesPerSecond: receivedBytes / elapsedSeconds,
					state: "downloading",
				});
			});
			response.on("end", () => output.end());
			output.on("finish", () => {
				output.close(() => {
					emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, percent: 100, state: "completed", filePath });
					void appLogger.info("update", "Download update asset completed", { assetName: asset.name, filePath, receivedBytes });
					resolve({ filePath, assetName: asset.name });
				});
			});
			output.on("error", (error) => {
				void appLogger.warn("update", "Failed to write update package", {
					assetName: asset.name,
					error: error.message,
				});
				const publicError = new Error(mainCopy("update.downloadFailed"));
				emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
				reject(publicError);
			});
		});
		request.on("error", (error) => {
			void appLogger.warn("update", "Update download request failed", {
				assetName: asset.name,
				error: error.message,
			});
			const publicError = new Error(mainCopy("update.downloadFailed"));
			emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
			reject(publicError);
		});
		request.end();
	});
}

async function installDownloadedUpdate(filePath: string) {
	// Windows/Linux 不同包类型的真正静默自更新风险较高；这里交给系统打开安装包或文件位置。
	// 便携版用户通常下载 zip/AppImage/tar.gz 后需要替换当前目录,避免在运行中覆盖自身可执行文件。
	await appLogger.info("update", "Open downloaded update package", { filePath });
	const openError = await shell.openPath(filePath);
	if (openError) {
		await appLogger.warn("update", "Failed to open downloaded update package", {
			filePath,
			error: openError,
		});
		throw new Error(mainCopy("update.openFailed"));
	}
}

/**
 * 重启应用：先同步退出标志并停掉常驻服务，再 relaunch + quit。
 * 必须置 isQuitting，否则 closeToTray 会把退出流程吞成「隐藏到托盘」，relaunch 不生效。
 */
function restartApp(): void {
	isQuitting = true;
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	void agentManager?.stopAll();
	app.relaunch();
	app.quit();
}

function refreshTrayContextMenu(): void {
	if (!tray) return;
	tray.setContextMenu(Menu.buildFromTemplate([
		{
			label: mainCopy("tray.showWindow"),
			click: () => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
		},
		{ type: "separator" },
		{
			// 托盘重启与系统设置 IPC 的 appRestart 保持同一套清理语义
			label: mainCopy("tray.restart"),
			click: restartApp,
		},
		{ type: "separator" },
		{
			label: mainCopy("tray.quit"),
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]));
}


/** 从托盘/任务栏/二次启动唤起主窗口：处理最小化、隐藏到托盘两种状态。 */
function focusMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	if (typeof mainWindow.setSkipTaskbar === "function") {
		mainWindow.setSkipTaskbar(false);
	}
	mainWindow.show();
	mainWindow.focus();
	if (process.platform === "win32") {
		mainWindow.setAlwaysOnTop(true);
		mainWindow.setAlwaysOnTop(false);
	}
}

/**
 * 同版本次实例请求聚焦：窗口已在则前置；若窗口尚未创建/已销毁，ready 后重建。
 * 若唤起源自「点击系统通知」（argv 携带 pideck:// URL），额外向 renderer 发送聚焦目标，
 * 切换到对应会话；agentId 为兼容旧 toast 的兜底格式，运行时经 coordinator 解析成会话。
 * 挂到顶层 focusExistingWindow，供版本单实例锁的 .focus 信号调用。
 */
function handleVersionFocusRequest(payload?: FocusPayload) {
	const target = extractFocusTargetFromArgv(payload?.argv);
	const activateSession = () => {
		if (!target || !mainWindow || mainWindow.isDestroyed()) return;
		let sessionId = target.sessionId;
		if (!sessionId && target.agentId && sessionRuntimeCoordinator) {
			sessionId = sessionRuntimeCoordinator.getSessionId(target.agentId);
		}
		if (sessionId) {
			mainWindow.webContents.send(ipcChannels.appFocusSessionTarget, { sessionId });
		}
	};
	if (mainWindow && !mainWindow.isDestroyed()) {
		focusMainWindow();
		activateSession();
		return;
	}
	void app.whenReady().then(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			focusMainWindow();
			activateSession();
			return;
		}
		if (settingsStore) {
			void createWindow()
				.then(() => {
					activateSession();
				})
				.catch((error) => {
					void appLogger?.error("app", "Failed to recreate window on version focus request", error);
				});
		}
	});
}

// 顶层锁回调延后绑定：focusMainWindow / createWindow 定义在锁申请之后。
focusExistingWindow = handleVersionFocusRequest;

function setupTray() {
	// iconPath 由 electron-vite 的 ?asset 后缀自动解析，打包后也能正确定位
	const icon = nativeImage.createFromPath(iconPath);
	tray = new Tray(icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("PiDeck-Q");

	// 双击托盘图标恢复窗口（Windows 常见交互）
	tray.on("double-click", () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.show();
			mainWindow.focus();
		}
	});

	refreshTrayContextMenu();
}

async function openExternalUrl(url: string, forceSystem = false) {
	if (!url.startsWith("http:") && !url.startsWith("https:")) return;
	// 更新页的发行说明和安装包必须离开内置浏览器，避免下载被 webview 的导航策略拦截。
	if (forceSystem) {
		await shell.openExternal(url);
		return;
	}
	const settings = settingsStore.get();
	if (settings.linkOpenMode === "internal") {
		openInternalLinkInBrowserPanel(url);
		return;
	}
	await shell.openExternal(url);
}

function openInternalLinkInBrowserPanel(url: string) {
	// 内部打开：将 URL 发送到渲染进程，由 BrowserPanel 在侧栏/弹框中加载，
	// 替代之前的独立 BrowserWindow 方案，保持一致的浏览体验。
	if (!mainWindow || mainWindow.isDestroyed()) {
		void shell.openExternal(url);
		return;
	}
	mainWindow.webContents.send(ipcChannels.appOpenInBrowser, url);
}

function printStartupInfo() {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	const settings = settingsStore.get();
	const appVersion = app.getVersion();
	const electronVersion = process.versions.electron;
	const chromeVersion = process.versions.chrome;
	const nodeVersion = process.versions.node;
	const platform = process.platform;
	const arch = process.arch;
	const persistentInstallationType = settings.installationType || "unknown";
	const isPortableEnv = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
	// Debug 中展示实际生效类型,便于发现持久化值和运行时便携信号不一致的问题。
	const effectiveInstallationType =
		process.platform === "win32" && isPortableEnv ? "portable" : persistentInstallationType;

	// 执行 console.log 输出到开发者工具
	mainWindow.webContents.executeJavaScript(`
		console.log(
			"%c╭──────────────────────────────────────────────────────────╮",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log(
			"%c│                     PiDeck-Q Desktop                     │",
			"color: #8b5cf6; font-weight: bold; font-size: 16px;"
		);
		console.log(
			"%c╰──────────────────────────────────────────────────────────╯",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log("");
		console.log("%c📦 Application Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Version:         %c${appVersion}", "color: #6b7280;", "color: #10b981; font-weight: bold;");
		console.log("%c  Installation:    %c${effectiveInstallationType}", "color: #6b7280;", "color: #f59e0b; font-weight: bold;");
		console.log("%c  Platform:        %c${platform} (${arch})", "color: #6b7280;", "color: #8b5cf6;");
		console.log("");
		console.log("%c⚡ Runtime Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Electron:        %c${electronVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Chrome:          %c${chromeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Node:            %c${nodeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("");
		console.log("%c🔧 Debug Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  PORTABLE_EXECUTABLE_DIR: %c${isPortableEnv ? '✅ Set' : '❌ Not set'}", "color: #6b7280;", "color: ${isPortableEnv ? '#10b981' : '#ef4444'};");
		console.log("%c  Persistent installationType: %c${persistentInstallationType}", "color: #6b7280;", "color: #8b5cf6; font-weight: bold;");
		console.log("");
		console.log("%c🐛 Found a bug? Report at:", "color: #6b7280;");
		console.log("%c  https://github.com/fhh2626/PiDeck-Pi_Agent_Rust/issues", "color: #3b82f6; text-decoration: underline;");
		console.log("");
		console.log("%c🎉 Easter egg: You found it! Thanks for exploring.", "color: #ec4899; font-weight: bold;");
		console.log("");
	`);
}

async function prepareMainPreloadPath() {
	const sourcePath = join(__dirname, "../preload/index.js");
	return preparePreloadPath(sourcePath, "main-preload.js");
}

const BROWSER_PANEL_PARTITION = BROWSER_PANEL_PARTITION_SHARED;

function isAllowedBrowserPanelUrl(targetUrl: string): boolean {
	return isAllowedBrowserPanelUrlShared(targetUrl);
}

/**
 * 浏览器面板 partition 上的导航白名单拦截是否已注册。
 * Electron webRequest 监听返回 void 且不可移除；macOS activate 重建窗口会重复调用
 * configureBrowserPanelWebviewHost，必须只注册一次，否则每次重建都在共享 partition
 * 上累积一份回调（2026-10 泄漏修复）。
 */
let browserPanelRequestInstalled = false;

function configureBrowserPanelWebviewHost(window: BrowserWindow): void {
	const browserPanelSession = session.fromPartition(BROWSER_PANEL_PARTITION);
	browserPanelSession.setPermissionCheckHandler(() => false);
	browserPanelSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	browserPanelSession.setDevicePermissionHandler(() => false);
	if (!browserPanelRequestInstalled) {
		browserPanelRequestInstalled = true;
		browserPanelSession.webRequest.onBeforeRequest(
			(details, callback) => {
		const isFrameNavigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
		if (isFrameNavigation && !isAllowedBrowserPanelUrl(details.url)) {
			void appLogger.warn("browser", "Blocked unsafe webview frame request", {
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
			void appLogger.warn("browser", "Blocked unsafe webview attachment", {
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
		delete (webPreferences as Record<string, unknown>).preloadURL;
	});

	window.webContents.on("did-attach-webview", (_event, guest) => {
		if (guest.session !== browserPanelSession) {
			void appLogger.warn("browser", "Closed webview with unexpected session");
			guest.close();
			return;
		}

		const blockUnsafeNavigation = (event: { url: string; preventDefault(): void }, phase: string) => {
			if (isAllowedBrowserPanelUrl(event.url)) return;
			event.preventDefault();
			void appLogger.warn("browser", "Blocked unsafe webview navigation", {
				phase,
				url: event.url,
			});
		};

		guest.on("will-frame-navigate", (event) => blockUnsafeNavigation(event, "navigate"));
		guest.on("will-redirect", (event) => blockUnsafeNavigation(event, "redirect"));
		guest.setWindowOpenHandler(({ url }) => {
			if (url !== "about:blank" && isAllowedBrowserPanelUrl(url)) {
				void openExternalUrl(url);
			} else if (!isAllowedBrowserPanelUrl(url)) {
				void appLogger.warn("browser", "Blocked unsafe webview window open", { url });
			}
			return { action: "deny" };
		});
	});
}

async function createWindow() {
	applyNativeThemeSource(settingsStore.get());
	const windowOptions = settingsStore.createWindowOptions();
	const showMainWindowImmediately = shouldShowMainWindowImmediately();
	const sourcePreloadPath = join(__dirname, "../preload/index.js");
	const mainPreloadPath = await prepareMainPreloadPath();
	void appLogger.info("app", "Main window preload configured", {
		sourcePreloadPath,
		preloadPath: mainPreloadPath,
		sourceExists: existsSync(sourcePreloadPath),
		exists: existsSync(mainPreloadPath),
		appPath: app.getAppPath(),
		userDataPath: app.getPath("userData"),
		packaged: app.isPackaged,
		isDev: is.dev,
		electronRendererUrl: process.env.ELECTRON_RENDERER_URL ? "set" : "unset",
	});

	// 根据用户的主题设置选择窗口背景色，避免系统标题栏与暗色主题间出现浅色条带。
	// 色值与 foundation.css 的 light/dark 基底保持一致（暖白 / 暖黑）。
	const theme = settingsStore.get().theme;
	const isDark =
		theme === "dark" ||
		(theme === "system" && nativeTheme.shouldUseDarkColors);
	const backgroundColor = isDark ? "#121212" : "#f8f8f5";

	// 按外观设置的启动预设调整初始尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	// startupWindowMode="last"：读上次关闭时的窗口大小；读不到（首次启动/记录损坏）顺延默认 maximized
	const requestedMode = settingsStore.get().startupWindowMode ?? "last";
	let effectiveStartupMode = requestedMode;
	let startupBounds: { width: number; height: number };
	if (requestedMode === "last") {
		const last = readLastWindowBounds(app.getPath("userData"));
		if (last) {
			startupBounds = last;
		} else {
			effectiveStartupMode = "maximized";
			startupBounds = resolveStartupWindowBounds("maximized");
		}
	} else {
		startupBounds = resolveStartupWindowBounds(requestedMode);
	}

	mainWindow = new BrowserWindow({
		show: showMainWindowImmediately,
		backgroundColor,
		width: startupBounds.width,
		height: startupBounds.height,
		minWidth: 880,
		minHeight: 640,
		// Windows 任务栏/Alt-Tab 显示这个标题。自定义无框标题栏时 UI 自己画标题，
		// 但 OS 任务栏仍读 BrowserWindow.title；空字符串会变成“只有图标、没有软件名”。
		title: "PiDeck-Q",
		icon: iconPath,
		frame: windowOptions.frame,
		titleBarStyle: windowOptions.titleBarStyle,
		...(windowOptions.trafficLightPosition ? { trafficLightPosition: windowOptions.trafficLightPosition } : {}),
		webPreferences: {
			preload: mainPreloadPath,
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true,
		},
	});
	const createdWindow = mainWindow;
	configureBrowserPanelWebviewHost(createdWindow);
	let hasShownMainWindow = false;
	function showMainWindowOnce() {
		if (createdWindow.isDestroyed() || hasShownMainWindow) return;
		hasShownMainWindow = true;
		createdWindow.show();
		createdWindow.focus();
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	// 窗口保持隐藏时先按启动预设调整（maximize/fullscreen），再加载页面；
	// 避免 ready-to-show 后再调整造成首帧布局跳变。
	applyStartupWindowMode(
		mainWindow,
		effectiveStartupMode,
		showMainWindowImmediately,
	);

	// 所有 target="_blank" 或 window.open 的链接统一经同一入口处理，遵守用户设置的打开方式。
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void openExternalUrl(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("did-start-loading", () => {
		void appLogger.info("app", "Main window load started", {
			url: mainWindow?.webContents.getURL(),
		});
	});
	mainWindow.webContents.on("did-finish-load", () => {
		void appLogger.info("app", "Main window load finished", {
			url: mainWindow?.webContents.getURL(),
		});
		// 恢复用户设置的窗口缩放；在 did-finish-load 后应用，避免早期设置被覆盖。
		mainWindow?.webContents.setZoomFactor(settingsStore.get().zoomFactor);
	});
	mainWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			void appLogger.error("app", "Main window load failed", {
				errorCode,
				errorDescription,
				validatedURL,
				isMainFrame,
			});
		},
	);
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		const level: AppLogLevel = details.reason === "clean-exit" ? "info" : "error";
		void appLogger.log(level, "app", "Main window renderer process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
		// 黑屏治理：非正常崩溃自动 reload 恢复；clean-exit（正常退出）、用户主动退出
		// 与崩溃风暴（窗口期内超限）不恢复。reload 前检查窗口/webContents 仍存活。
		if (isQuitting || !rendererCrashGuard.shouldAutoReload(details.reason)) return;
		void appLogger.warn("app", "Auto-reloading main window after renderer crash", {
			reason: details.reason,
			exitCode: details.exitCode,
			recoveriesInWindow: rendererCrashGuard.recoveriesInWindow(),
		});
		if (mainWindow && !mainWindow.isDestroyed()) {
			try {
				mainWindow.webContents.reload();
			} catch (error) {
				// reload 抛异常（webContents 已销毁等竞态）：记日志，留给用户手动处理
				void appLogger.error("app", "Auto-reload failed", error);
			}
		}
	});
	// 子进程（含 GPU/utility）异常退出：Mac 上偶发“整窗闪一下”，需要留下 reason/exitCode。
	app.on("child-process-gone", (_event, details) => {
		void appLogger.error("process", "Child process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
	});
	mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
		void appLogger.error("app", "Main window preload failed", {
			preloadPath,
			message: error.message,
			stack: error.stack,
		});
	});
	mainWindow.webContents.on("dom-ready", () => {
		void mainWindow?.webContents
			.executeJavaScript("Boolean(window.piDesktop)", true)
			.then((hasPiDesktop) => {
				void appLogger.info("app", "Main window preload API availability", {
					hasPiDesktop,
					url: mainWindow?.webContents.getURL(),
				});
			})
			.catch((error) => {
				void appLogger.warn("app", "Main window preload API check failed", error);
			});
	});
	mainWindow.webContents.on(
		"console-message",
		(event) => {
			if (!["warning", "error"].includes(event.level)) return;
			void appLogger.warn("app", "Main window renderer console error", {
				level: event.level,
				message: event.message,
				line: event.lineNumber,
				sourceId: event.sourceId,
			});
		},
	);

	mainWindow.once("ready-to-show", showMainWindowOnce);
	mainWindow.webContents.once("did-finish-load", showMainWindowOnce);
	setTimeout(showMainWindowOnce, 3000);
	if (showMainWindowImmediately) {
		showMainWindowOnce();
	}

	// 窗口大小记忆：关闭/退出前保存 normal bounds（最大化/全屏时取恢复后的尺寸），
	// 供下次 startupWindowMode="last" 启动使用；隐藏到托盘不记录（窗口未关闭）。
	// 注意：mainWindow 为模块级可空变量，此处用创建后的局部引用确保非空
	const windowForState = createdWindow;
	windowForState.on("close", () => {
		if (!windowForState.isDestroyed()) {
			const normal = windowForState.isMaximized() || windowForState.isFullScreen()
				? windowForState.getNormalBounds()
				: windowForState.getBounds();
			saveLastWindowBounds(app.getPath("userData"), { width: normal.width, height: normal.height });
		}
	});

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		if (!isQuitting && settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			isQuitting = true;
			app.quit();
		}
	});

	// 监听浏览器标准快捷键打开开发者工具
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;

		// F12
		if (input.key === "F12" && input.type === "keyDown") {
			event.preventDefault();
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools({ mode: "detach" });
			}
		}

		// Ctrl+Shift+I (Windows/Linux) 或 Cmd+Option+I (macOS)
		const isMac = process.platform === "darwin";
		const ctrlOrCmd = isMac ? input.meta : input.control;
		const shiftOrOption = input.shift || (isMac && input.alt);

		if (
			ctrlOrCmd &&
			shiftOrOption &&
			input.key.toLowerCase() === "i" &&
			input.type === "keyDown"
		) {
			event.preventDefault();
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools({ mode: "detach" });
			}
		}

		// Ctrl+Shift+J (Windows/Linux) 或 Cmd+Option+J (macOS) - 直接打开 Console
		if (
			ctrlOrCmd &&
			shiftOrOption &&
			input.key.toLowerCase() === "j" &&
			input.type === "keyDown"
		) {
			event.preventDefault();
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools({ mode: "detach", activate: true });
			}
		}
	});

	const devRendererUrl = shouldUseDevRendererUrl()
		? process.env.ELECTRON_RENDERER_URL
		: undefined;
	if (devRendererUrl) {
		mainWindow.loadURL(devRendererUrl);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

function shouldUseDevRendererUrl() {
	return is.dev && !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
}

function shouldShowMainWindowImmediately() {
	return isUsingLinuxXWaylandWorkaround();
}

/** 启动尺寸预设 → 初始窗口尺寸；全屏/最大化也给合理兜底，避免显示器信息异常时缩成最小窗。 */
function resolveStartupWindowBounds(mode: StartupWindowMode): {
	width: number;
	height: number;
} {
	switch (mode) {
		case "normal-compact":
			return { width: 1100, height: 720 };
		case "normal-medium":
			return { width: 1280, height: 840 };
		case "normal-large":
			return { width: 1480, height: 960 };
		case "maximized":
		case "fullscreen":
		default:
			return { width: 1480, height: 960 };
	}
}

/** 在窗口创建后应用启动尺寸预设；隐藏态先 maximize/fullscreen，减少首帧跳动。 */
function applyStartupWindowMode(
	window: BrowserWindow,
	mode: StartupWindowMode,
	showImmediately: boolean,
) {
	if (mode === "fullscreen") {
		// setFullScreen 在某些平台要求窗口已 show；隐藏态先 maximize 再在 show 后补全屏。
		if (showImmediately) {
			window.setFullScreen(true);
		} else {
			window.maximize();
			window.once("show", () => {
				if (!window.isDestroyed()) window.setFullScreen(true);
			});
		}
		return;
	}
	if (mode === "maximized") {
		window.maximize();
	}
}

function currentMainProcessLocale(): MainProcessLocale {
	const language = settingsStore.get().language;
	if (language === "pseudo") return "en-US";
	return normalizeMainProcessLocale(language === "system" ? app.getLocale() : language);
}

function mainCopy(
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
): string {
	return mainProcessT(currentMainProcessLocale(), key, params);
}

function sessionCommandIpcError(error: SessionCommandError): SessionCommandIpcError {
	if (error.debugDetails) {
		void appLogger?.warn("session-command", "Session command failed", {
			code: error.code,
			debugDetails: error.debugDetails,
		});
	}
	return new SessionCommandIpcError(error, mainCopy);
}

async function sendAgentPrompt(
	input: SendPromptInput,
): Promise<SendPromptResult> {
	const result = await agentManager.sendPrompt(input);
	void appLogger.info("agent", "Prompt sent", {
		agentId: input.agentId,
		messageLength: input.message.length,
		imageCount: input.images?.length ?? 0,
		streamingBehavior: input.streamingBehavior,
	});
	return result;
}

function registerIpc() {
	// 用量统计：业务在 UsageStatsService，handler 薄层只校验/适配
	registerUsageStatsIpc(ipcMain, usageStatsService);

	const catalogIdentityContext = () => {
		const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
		return wslEnabled ? { wslDistro, wslUser } : {};
	};

	registerEditorsIpc({
		settingsStore,
		appLogger,
		getMainWindow: () => mainWindow,
	});
	// 换肤背景图：协议服务 userData/backgrounds/，IPC 负责选图复制与删除
	registerBackgroundImageProtocol();
	registerBackgroundsIpc();
	registerProjectsIpc({
		projectStore,
		settingsStore,
		gitService,
		worktreeService,
		agentManager,
		appLogger,
		projectResourceManager,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getMainWindow: () => mainWindow,
	});

	registerScratchPadIpc({ appLogger });

	// 安全管理：配置读写 + 会话等级覆盖（SecurityStore 负责持久化与策略快照）
	registerSecurityIpc({
		securityStore,
		log: (domain, message, details) => void appLogger.info(domain, message, details),
	});

	// 视觉桥配置（~/.pi/agent/pi-deck-vision.json）界面化编辑；运行时由 pi-deck-vision 扩展消费
	registerVisionIpc({
		visionBridge: new VisionBridgeConfigManager(configManager),
		log: (message, ...args) => appLogger.info("vision", message, ...args),
	});

	registerSessionIpc({
		projectStore,
		settingsStore,
		sessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		codexSessionImporter,
		claudeSessionImporter,
		openCodeSessionImporter,
		appLogger,
		terminalManager,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getMainWindow: () => mainWindow,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		createAnonymousSession,
		stopSessionRuntime,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		copyCatalogSession,
		exportCatalogSessionHtml,
		replaceAgentSession,
	});

	// ── 启动预扫描（2026-08 展开项目卡顿优化）──
	// 延迟 3s 启动、项目间错开 1.5s 逐个调度后台扫描：预热 catalog 缓存，
	// 用户首次展开项目时直接命中缓存回显，不再同步全量扫描卡 UI。
	// 错开 + 协调器去重/冷却（sessionIpc 内）保证不与用户触发的扫描并发重扫。
	const prewarmTimer = setTimeout(() => {
		const projects = projectStore.list();
		projects.forEach((project, index) => {
			const timer = setTimeout(() => {
				scheduleCatalogBackgroundScan(project.id, async () => {
					try {
						const settings = settingsStore.get();
						let projectPath = project.path;
						if (settings.wslEnabled && settings.wslDistro) {
							projectPath = projectPath
								.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
								.replace(/\\/g, "/");
						}
						const summaries = await sessionScanner.list(projectPath);
						await sessionCatalog.mergeScanned(
							project.id,
							summaries,
							settings.wslEnabled ? { wslDistro: settings.wslDistro, wslUser: settings.wslUser } : {},
						);
					} catch (error) {
						void appLogger.warn("session", "Catalog prewarm scan failed", {
							projectId: project.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
			}, index * 1500);
			timer.unref?.();
		});
	}, 3000);
	prewarmTimer.unref?.();

	registerGitIpc({
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getLocale: currentMainProcessLocale,
		gitService,
		piLocator,
		projectStore,
		settingsStore,
		worktreeService,
	});

	// Phase 3.7 拆出 systemIpc 后这些可选依赖必须显式注入；
	// 漏传 extensionManager 会导致 pi:update-check / pi:update 根本不注册。
	// 模型规格存储：resources/model-specs.db（发版前由 scripts/sync-model-specs.mjs 同步），
	// 只读 + 懒加载索引；查询供配置界面失焦自动填充模型能力
	const modelSpecsStore = new ModelSpecsStore(
		app.isPackaged
			? join(process.resourcesPath, "model-specs.db")
			: join(app.getAppPath(), "resources", "model-specs.db"),
	);
	registerSystemIpc({
		piLocator,
		settingsStore,
		configManager,
		agentManager,
		skillManager,
		appLogger,
		rpcLogger,
		sessionRuntimeCoordinator,
		modelSpecsStore,
		// 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送）
		stopAgentFromMonitor,
		getMainWindow: () => mainWindow,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		checkForAppUpdate: checkForAppUpdate as (installationType?: string) => Promise<AppUpdateInfo | null>,
		downloadUpdateAsset,
		installDownloadedUpdate,
		openExternalUrl,
		extensionManager,
		// 设置变更副作用（代理 / 主题 / WSL / Web 服务）
		applyDesktopProxy,
		testPiProxy,
		applyWebServiceSettings: (settings) => webServiceManager.applySettings(settings),
		restartWebService: (settings) => webServiceManager.restart(settings),
		applyNativeThemeSource,
		refreshTrayContextMenu,
		notifyTitleBarChange: (window) => settingsStore.notifyTitleBarChange(window),
		setSessionCatalogIdentityContext: (ctx) => sessionCatalog.setIdentityContext(ctx),
		resolveWslEnvironment: async (distro, user, logger) => {
			const { resolveWslEnvironment: resolveWsl } = await import("./wsl/WslEnvironment");
			return resolveWsl(distro, user, logger);
		},
		configureSessionScannerWsl: (env) => sessionScanner.configureWsl(env),
		clearSessionScannerWsl: () => sessionScanner.clearWsl(),
		configureSkillManagerWsl: (env) => skillManager.configureWsl(env),
		configurePromptManagerWsl: (env) => promptManager.configureWsl(env),
		configureExtensionManagerWsl: (env) => extensionManager.configureWsl(env),
		configureConfigManagerWsl: (env) => configManager.configureWsl(env),
		configureXuePromptManagerWsl: (env) => xuePromptManager.configureWsl(env),
		sessionCommandIpcError,
		// 重启路径需要同步 isQuitting / 停服务，避免 closeToTray 吞掉 relaunch
		webServiceManager,
		terminalManager,
		isQuitting: {
			get value() {
				return isQuitting;
			},
			set value(next: boolean) {
				isQuitting = next;
			},
		},
		RELEASES_URL,
	});

	registerStoreIpc({
		promptManager,
		skillManager,
		xuePromptManager,
		extensionManager,
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
	});

	registerTerminalIpc({
		appLogger,
		sessionRuntimeCoordinator,
		terminalManager,
		toSessionCommandIpcError: sessionCommandIpcError,
	});

	// ── 配置管理 ──────────────────────────────────────

	// 后台预取 pi --list-models 缓存：registerIpc 完成后异步执行一次，
	// 使用户首次打开模型/思考选择器时不需要等待 fork pi 进程。
	// 已有缓存或在途请求时不会重复 fork。
	if (typeof piLocator !== "undefined" && typeof settingsStore !== "undefined") {
		setTimeout(() => {
			if (!getCachedModelList()) {
				void fetchModelList(piLocator, settingsStore).catch(() => {
					// 预取失败静默；用户首次点击选择器时会自动重试。
				});
			}
		}, 500);
	}

	// 预载模型规格索引（sql.js WASM + 全表读入约数十 ms，后台完成避免首次失焦卡顿）
	modelSpecsStore.warm();

	registerFilesIpc({
		fileSystemService,
		projectStore,
		settingsStore,
		appLogger,
		getMainWindow: () => mainWindow,
		openExternalUrl,
		getAuthorizedRoots: () => [
			...projectStore.list().map((project) => project.path),
			promptManager.getDir(),
			...skillManager.getDirs(),
			join(app.getPath("home"), ".pi", "agent"),
			app.getPath("userData"),
		],
	});
}

async function detectExternalEditorsOnFirstLaunch() {
	const current = settingsStore.get().externalEditors;
	if (Object.values(current).some((editor) => editor.command)) return;
	const detected = await detectExternalEditors();
	if (detected.length === 0) return;
	await settingsStore.update({
		externalEditors: mergeDetectedExternalEditors(current, detected),
	});
	void appLogger.info("editor", "External editors detected on first launch", { count: detected.length });
}

// 换肤背景图协议：自定义 scheme 必须在 ready 前注册特权声明（secure 以便渲染层 CSS 引用）
protocol.registerSchemesAsPrivileged([
	{ scheme: "pideck-bg", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
]);

app.whenReady().then(async () => {
	// 未拿到同版本主实例锁时不要继续初始化，避免第二进程短暂闪窗。
	if (singleInstanceEnabled && !gotSingleInstanceLock) return;

	projectStore = new ProjectStore(() => mainCopy("dialog.chooseProjectFolder"));
	fileSystemService = new FileSystemService();
	sessionScanner = new SessionScanner(mainCopy);
	codexSessionImporter = new CodexSessionImporter(mainCopy);
	claudeSessionImporter = new ClaudeSessionImporter(mainCopy);
	openCodeSessionImporter = new OpenCodeSessionImporter(mainCopy);
	settingsStore = new SettingsStore();
	// 安全管理：配置 owner + 策略快照写入（供 pi-deck-security-gate 扩展消费）
	securityStore = new SecurityStore({
		settingsStore,
		log: (domain, message, details) => void appLogger?.info(domain, message, details),
	});
	appLogger = new AppLogger();
	setAppLogger(appLogger);
	rpcLogger = new RpcLogger();
	// 用量统计：数据源 = pi-tracker 写入的 <agentDir>/analytics/usage.jsonl
	// （默认宿主 ~/.pi/agent；WSL 场景的目录同步暂按默认宿主处理）
	usageStatsService = new UsageStatsService({
		agentDir: join(app.getPath("home"), ".pi", "agent"),
		logger: {
			info: (message) => void appLogger?.info("usage-stats", message),
			warn: (message) => void appLogger?.warn("usage-stats", message),
		},
	});
	gitService = new GitService();
	worktreeService = new WorktreeService(mainCopy);
	piLocator = new PiLocator(mainCopy);
	configManager = new ConfigManager(undefined, mainCopy);
	promptManager = new PromptManager(
		undefined,
		mainCopy,
		() => settingsStore.get(),
		(patch) => settingsStore.update(patch),
	);
	xuePromptManager = new XuePromptManager();
	skillManager = new SkillManager(undefined, mainCopy);
	extensionManager = new ExtensionManager(
		piLocator,
		() => settingsStore.get(),
		() => settingsStore.get(),
		(patch) => settingsStore.update(patch),
		mainCopy,
	);
	projectResourceManager = new ProjectResourceManager(
		(projectId) => projectStore.get(projectId),
		mainCopy,
	);
	agentManager = new AgentManager(
		(id) => projectStore.get(id),
		() => mainWindow,
		settingsStore,
		configManager,
		rpcLogger,
		appLogger,
		undefined,
		mainCopy,
		// 每次 spawn Agent 前异步刷新模型列表缓存（防用户直接改 models.json/auth.json 不生效）。
		() => {
			if (piLocator && settingsStore) {
				void refreshModelList(piLocator, settingsStore).catch(() => undefined);
			}
		},
		securityStore,
		// spawn pi 前预检并修复旧版私有头行或路径与 session header 粘连的损坏文件。
		(filePath) => sessionScanner.repairCorruptSessionHeader(filePath),
	);
	webServiceManager = new WebServiceManager({
		// dev 模式（electron-vite dev 不产出 out/renderer 构建物）下，静态资源
		// 代理到 vite dev server，外部 Web 端加载重构后的 React 版页面并支持热更新；
		// 打包/正式构建走 out/renderer 构建产物，此值为空。
		devRendererUrl: shouldUseDevRendererUrl()
			? process.env.ELECTRON_RENDERER_URL
			: undefined,
		// 订阅 pi agent 事件流，供 Web SSE 端点转发给浏览器。
		subscribePiEvents: (handler) => agentManager.addLocalEventListener(
			(agentId, event, streamGeneration) => handler(agentId, event as never, streamGeneration),
		),
		// agentId → sessionId 路由：pi 事件只有 agentId，SSE 连接按 session 订阅。
		getSessionIdForAgent: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
		listProjects: () => projectStore.list(),
		createProject: (path) => projectStore.add(
			path,
			undefined,
			settingsStore.get().wslEnabled ? "wsl" : "windows",
		),
		deleteProject: async (projectId) => {
			if (!projectStore.get(projectId) || projectStore.get(projectId)?.kind === "chat") return false;
			await projectStore.remove(projectId);
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(
					ipcChannels.projectsChanged,
					listVisibleProjects(projectStore, settingsStore),
				);
			}
			return true;
		},
		listModels: () => fetchModelList(piLocator, settingsStore),
		listSessions: (projectId) => {
			const project = projectStore.get(projectId);
			return sessionScanner.list(project?.path);
		},
		getSessionRuntimeMessages: (sessionId) =>
			sessionRuntimeCoordinator.getRuntimeMessages(sessionId),
		listCatalogSessions: async (projectId) => {
			if (!projectId) {
				return sessionCatalog.listEntries()
					.map((entry) => sessionCatalog.getRecord(entry.id))
					.filter((record): record is SessionRecord => Boolean(record));
			}
			const project = projectStore.get(projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			let projectPath = project.path;
			const settings = settingsStore.get();
			if (settings.wslEnabled && settings.wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
					.replace(/\\/g, "/");
			}
			const summaries = await sessionScanner.list(projectPath);
			const { wslEnabled, wslDistro, wslUser } = settings;
			const records = await sessionCatalog.mergeScanned(
				projectId,
				summaries,
				wslEnabled ? { wslDistro, wslUser } : {},
			);
			const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(records);
			for (const binding of bindings) {
				const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
			}
			return records;
		},
		createSessionDraft: async (input) => {
			const project = projectStore.get(input.projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			const record = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.title?.trim() || mainCopy("session.newTitle"),
				environment: settingsStore.get().wslEnabled ? "wsl" : "native",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: input.projectId });
			}
			return record;
		},
		createAnonymousSession,
		updateSessionRecord: async (sessionId, patch) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) throw new Error(mainCopy("session.notFound"));
			const title = patch.title?.trim();
			if (title && title !== entry.title) {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
					if (!renamed.ok) throw sessionCommandIpcError(renamed.error);
				} else if (entry.filePath) {
					await sessionScanner.rename(entry.filePath, title);
				}
			}
			const record = await sessionCatalog.update(sessionId, {
				...patch,
				title: title || undefined,
			});
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: record.projectId });
			}
			return record;
		},
		deleteSessionRecord: async (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) return false;
			if (
				sessionRuntimeCoordinator.getTarget(sessionId) ||
				sessionRuntimeCoordinator.isActivating(sessionId)
			) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			const projectId = entry.projectId;
			if (entry.filePath) await sessionScanner.delete(entry.filePath);
			await sessionCatalog.remove(sessionId);
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
			}
			return true;
		},
		copySessionRecord: (sessionId) => copyCatalogSession(sessionId),
		exportSessionRecordHtml: (sessionId) => exportCatalogSessionHtml(sessionId),
		readSessionReferenceMessages: (sessionId) =>
			readCatalogSessionReferenceMessages(sessionId),
		readSessionMessages: async (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return [];
			const content = await sessionScanner.readSessionRawText(entry.filePath);
			return agentManager.readSessionDisplayMessages(entry.filePath, sessionId, content);
		},
		readSessionMessagePage: async (sessionId, before, pageSize) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return { messages: [], total: 0, nextBefore: null };
			return agentManager.readSessionDisplayMessagePage(entry.filePath, sessionId, before, pageSize);
		},
		sendSessionPrompt: async (input) => {
			const result = await sessionRuntimeCoordinator.send(input);
			if (result.agentId) {
				const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
			}
			return result;
		},
		getContextControllerState: async (sessionId) => {
			if (typeof sessionId !== "string" || !sessionId.trim()) {
				return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
			}
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
			try {
				const content = await sessionScanner.readSessionRawText(entry.filePath);
				return parseContextControllerStateFromJsonl(content);
			} catch {
				return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
			}
		},
		listSessionRuntimes: () => sessionRuntimeCoordinator.listRuntimes(),
		listSessionRuntimeModels: (target) => sessionRuntimeCoordinator.listRuntimeModels(target),
		stopSessionRuntime: stopSessionRuntime,
		abortSessionRuntime: (target) => sessionRuntimeCoordinator.abortRuntime(target),
		restartSessionRuntime: async (target) => {
			terminalManager.closeAgent(target.agentId);
			const result = await sessionRuntimeCoordinator.restartRuntime(target);
			if (result.ok) {
				if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
				emitReplacementState(result.value.runtime, false);
			}
			return result;
		},
		compactSessionRuntime: (target, prompt) =>
			sessionRuntimeCoordinator.compactRuntime(target, prompt),
		getSessionRuntimeState: (target) =>
			sessionRuntimeCoordinator.getRuntimeState(target),
		listSessionRuntimeCommands: (target) =>
			sessionRuntimeCoordinator.listRuntimeCommands(target),
		exportSessionRuntimeHtml: (target) =>
			sessionRuntimeCoordinator.exportRuntimeHtml(target),
		editSessionRuntimeMessage: (target, messageId, newText) =>
			sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText),
		deleteSessionRuntimeMessage: (target, messageId) =>
			sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId),
		prepareSessionRuntimeResend: (target, messageId) =>
			sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId),
		setSessionRuntimeModel: (target, provider, modelId) =>
			sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId),
		setSessionRuntimeThinking: (target, level) =>
			sessionRuntimeCoordinator.setRuntimeThinking(target, level),
		cloneSessionRuntime: async (target) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				return {
					ok: true as const,
					value: await replaceAgentSession(
						target.agentId,
						() => agentManager.cloneSession(target.agentId),
					),
				};
			} catch (error) {
				return {
					ok: false as const,
					error: {
						code: "SESSION_COMMAND_FAILED" as const,
						debugDetails: error instanceof Error ? error.message : String(error),
					},
				};
			}
		},
	});
	terminalManager = new TerminalSessionManager(
		(agentId) => agentManager.getCwd(agentId),
		(channel, payload) => mainWindow?.webContents.send(channel, payload),
	);

	await settingsStore.load();
	const initialSessionSettings = settingsStore.get();
	sessionCatalog = new SessionCatalog(
		join(app.getPath("userData"), "session-catalog.json"),
		initialSessionSettings.wslEnabled
			? { wslDistro: initialSessionSettings.wslDistro, wslUser: initialSessionSettings.wslUser }
			: {},
		// 会话路径统一绝对化：pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，
		// get_state 返回的 sessionFile 是相对 cwd 的；与扫描器绝对路径 originKey 不一致
		// 会导致同一会话在侧栏出现两条记录。加载与写入边界都经此归一化。
		(projectId, filePath, environment) => {
			const project = projectStore.get(projectId);
			if (!project) return filePath;
			return toAbsoluteSessionPath(filePath, project.path, environment);
		},
	);
	await sessionCatalog.load();
	sessionRuntimeCoordinator = new SessionRuntimeCoordinator(
		sessionCatalog,
		agentManager,
		sendAgentPrompt,
		appLogger,
	);
	agentManager.onOutput((sourceChannel, payload) => {
		if (sourceChannel === ipcChannels.agentsState && Array.isArray(payload)) {
			for (const tab of payload) {
				if (tab && typeof tab === "object" && typeof tab.id === "string") {
					emitSessionRuntimeEvent(tab.id, sourceChannel, tab);
				}
			}
			return;
		}
		if (payload && typeof payload === "object" && "agentId" in payload) {
			const agentId = (payload as { agentId?: unknown }).agentId;
			if (typeof agentId !== "string") return;
			const forwarded = emitSessionRuntimeEvent(agentId, sourceChannel, payload);
			if (!forwarded && sourceChannel === ipcChannels.agentsUiRequest) {
				cancelUnboundUiRequest(payload);
			}
		}
	});

	await appLogger.info("app", "Application started", {
		version: app.getVersion(),
		platform: process.platform,
		arch: process.arch,
		installationType: settingsStore.get().installationType,
	});
	await applyDesktopProxy(settingsStore.get());
	registerIpc();

	// 内存分析模式（PIDECK_MEMORY_PROFILE=1）：尽早开始采样，覆盖窗口创建/加载全过程。
	// 采样失败不阻塞启动（诊断工具降级为不可用）。
	if (isMemoryProfileEnabled()) {
		memoryProfileHandle = await startMemoryProfile(() => agentManager.hasActiveStreaming()).catch((error) => {
			console.error("Failed to start memory profile:", error);
			return null;
		});
	}
	// 窗口先于 WSL 探测 / pi settings 修补 / Web 服务启动创建：
	// 那几步可能各花数秒（wsl.exe printenv 最多 8s），Typora/VS Code 不会在首窗前做这些事。
	await createWindow();
	setupTray();

	// 根据已加载的 WSL 设置配置会话扫描器，使其能同时扫描 WSL 中的 pi 会话目录
	const syncWslConfig = async () => {
		const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
		if (wslEnabled && wslDistro && wslUser) {
			const { resolveWslEnvironment: resolveWsl2 } = await import("./wsl/WslEnvironment");
			const wslEnv = await resolveWsl2(wslDistro, wslUser, {
				warn: (msg: string, detail: unknown) => console.warn("[PiDeck] " + String(msg), detail),
			});
			await sessionScanner.configureWsl(wslEnv);
			skillManager.configureWsl(wslEnv);
			promptManager.configureWsl(wslEnv);
			extensionManager.configureWsl(wslEnv);
			if (configManager) configManager.configureWsl(wslEnv);
			if (xuePromptManager) xuePromptManager.configureWsl(wslEnv);
		} else {
			sessionScanner.clearWsl();
			skillManager.configureWsl(null);
			promptManager.configureWsl(null);
			extensionManager.configureWsl(null);
			if (configManager) configManager.configureWsl(null);
			if (xuePromptManager) xuePromptManager.configureWsl(null);
		}
	};
	// 这些启动修补不挡住首窗；失败只记日志，用户已经能看到 boot overlay。
	void syncWslConfig().catch((error) => {
		console.error("Failed to sync WSL config:", error);
	});
	void migrateLegacyBuiltInExtensions().catch((error) => {
		console.error("Failed to migrate legacy built-in extensions:", error);
	});
	void ensureAllPiSettingsDefaults().catch((error) => {
		console.error("Failed to ensure pi settings defaults:", error);
	});
	void webServiceManager.applySettings(settingsStore.get()).catch((error) => {
		console.error("Failed to start web service:", error);
		void appLogger.warn("web", "Web service disabled after apply failure", {
			error: error instanceof Error ? error.message : String(error),
		});
		void settingsStore.update({ webServiceEnabled: false });
	});

	// 冷启动通知唤起：应用未运行时点击系统通知，本进程即为唯一实例（无次实例 .focus 流转），
	// argv 携带 pideck:// URL，窗口就绪后直接向 renderer 发送跳转目标。
	// catalog 可能尚未加载完，renderer 侧监听会小间隔重试直到能解析到会话记录。
	const coldStartTarget = extractFocusTargetFromArgv(process.argv);
	if (coldStartTarget?.sessionId && mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(ipcChannels.appFocusSessionTarget, {
			sessionId: coldStartTarget.sessionId,
		});
	}
	void detectExternalEditorsOnFirstLaunch().catch((error) => {
		void appLogger.warn("editor", "External editor first launch detection failed", error);
	});

	// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
	void projectStore
		.load()
		.then(() => {
			const s = settingsStore.get();
			const visible = s.wslEnabled
				? projectStore.list().filter((p) => p.kind === "chat" || p.environment === "wsl")
				: projectStore.list().filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
			mainWindow?.webContents.send("projects:changed", visible);
		})
		.catch(() => undefined);

	// 启动后异步检查 RPC 超时时间，如果小于 600 秒则自动修正为 600 秒
	// 避免用户配置的过小超时（如 30 秒）导致启动或命令执行频繁超时
	setTimeout(() => {
		void settingsStore.ensureRpcTimeoutMinimum().catch((error) => {
			void appLogger.warn("settings", "Failed to ensure rpcTimeout minimum", error);
		});
	}, 0);

	// macOS dock 点击或任务栏点击时恢复窗口
	app.on("activate", () => {
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		} else {
			void createWindow().catch((error) => {
				void appLogger.error("app", "Failed to create window on activate", error);
			});
		}
	});
});

/**
 * 删除用户扩展目录中的 PiDeck 扩展文件（历史部署或已下线扩展）。
 * 内置扩展现改为 -e 从 app resources 加载，用户目录不应再有 pi-deck-* 副本。
 */
async function removeStalePiDeckExtension(extensionName: string, homeDir?: string): Promise<void> {
	const home = homeDir ?? app.getPath("home");
	const targetPath = join(home, ".pi", "agent", "extensions", extensionName);
	await rm(targetPath, { force: true });
	appLogger?.info("extension", "Removed legacy/stale extension", { path: targetPath });
}

/**
 * 升级迁移：清掉历史版本复制到 ~/.pi/agent/extensions 的内置扩展与已下线扩展。
 * 覆盖 Windows home；WSL 启用时同步清理 \\wsl$ 映射 home。
 */
async function migrateLegacyBuiltInExtensions(): Promise<void> {
	const { BUILT_IN_EXTENSIONS } = await import("./extensions/builtInExtensions");
	const legacyNames = [
		...BUILT_IN_EXTENSIONS,
		"pi-deck-project-trust.ts",
		"pi-deck-file-capture.ts",
	];
	const homes = [app.getPath("home")];
	const wslSettings = settingsStore.get();
	if (wslSettings.wslEnabled && wslSettings.wslDistro && wslSettings.wslUser) {
		homes.push(`\\\\wsl$\\${wslSettings.wslDistro}\\home\\${wslSettings.wslUser}`);
	}
	for (const home of homes) {
		for (const name of legacyNames) {
			await removeStalePiDeckExtension(name, home).catch(() => undefined);
		}
	}
}

/**
 * 补齐 pi 全局 settings.json 的推荐默认项。
 * 仅添加缺失的 key，不覆盖用户已有配置。
 * 适用于新安装 pi 或配置精简的用户。
 */
/** 补齐指定 configDir 下 settings.json 的缺失默认项 */
async function ensurePiSettingsDefaults(configDir: string, piVersionHint?: string): Promise<void> {
	const filePath = join(configDir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		const raw = await readFile(filePath, "utf8");
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch { /* 文件不存在或解析失败，使用空对象 */ }

	let changed = false;
	const defaults: Record<string, unknown> = {
		theme: "dark",
		hideThinkingBlock: false,
		defaultProjectTrust: "ask",
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		retry: { enabled: true, maxRetries: 3 },
	};

	if (piVersionHint && !current.lastChangelogVersion) {
		current.lastChangelogVersion = piVersionHint;
		changed = true;
	}

	for (const [key, defaultValue] of Object.entries(defaults)) {
		if (!(key in current)) {
			current[key] = defaultValue;
			changed = true;
		}
	}

	if (changed) {
		await mkdir(configDir, { recursive: true });
		await writeFile(filePath, JSON.stringify(current, null, 2), "utf8");
		console.log('[PiDeck] Ensured pi settings defaults at:', filePath);
	}
}

/** 对当前环境和 WSL 环境（如果启用）都补齐 settings.json 默认项 */
async function ensureAllPiSettingsDefaults(): Promise<void> {
	const s = settingsStore.get();
	let piVersion = "";
	if (piLocator) {
		piVersion = (await piLocator.check(
			s.customPiPath,
			s.wslEnabled,
			s.wslDistro,
			s.wslUser,
			s.piRuntimePreference,
			s.piTypescriptPath,
			s.piRustPath,
		).catch(() => null))?.version ?? "";
	}

	// Windows 本地
	const winDir = join(app.getPath("home"), ".pi", "agent");
	await ensurePiSettingsDefaults(winDir, piVersion).catch(() => {});

	// WSL（如果已配置）
	if (s.wslEnabled && s.wslDistro && s.wslUser) {
		const wslDir = join(`\\\\wsl$\\${s.wslDistro}\\home\\${s.wslUser}`, ".pi", "agent");
		await ensurePiSettingsDefaults(wslDir, piVersion).catch(() => {});
	}
}

app.on("before-quit", () => {
	isQuitting = true;
	memoryProfileHandle?.stop();
	memoryProfileHandle = null;
	tray?.destroy();
	tray = null;
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	agentManager?.stopAll();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
