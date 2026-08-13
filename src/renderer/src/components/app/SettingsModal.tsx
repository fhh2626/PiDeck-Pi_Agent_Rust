// @ts-nocheck - extracted from AppParts, pre-existing type issues
import { Component, useState, useEffect, useRef, type ReactNode } from "react";
import QRCode from "qrcode";
import { Input } from "../ui-shadcn/input";
import {
	Settings2,
	Network,
	Wrench,
	PawPrint,
	Trash2,
	RotateCw,
	Brush,
	Eye,
	Minus,
	Plus,
	ChartColumnBig,
	Activity,
	MessageSquare,
} from "lucide-react";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { ACCENT_PRESETS } from "../../themePresets";
import { Button } from "../ui-shadcn/button";
import { UsageStatsTab } from "./settings/UsageStatsTab";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../ui-shadcn/tabs";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "../ui-shadcn/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui-shadcn/alert-dialog";
import { SettingsSection, StorageTab } from "./settings/SettingsStorageTab";
import { SettingBox, SettingRow, SettingSwitchRow, SettingTextarea } from "./settings/SettingRows";
import { ExternalEditorsSection } from "./settings/ExternalEditorsSection";
import { ProcessMetricsTab } from "./settings/ProcessMetricsTab";
import { ImTab } from "./settings/ImTab";
import { VisionBridgeSettingsTab, useVisionBridgeDraft } from "./settings/VisionBridgeSettingsTab";
import { ModelPicker } from "../session/ComposerComponents";
import type { AppSettings, AppInfo, AvailableModel, PiInstallStatus, PiUpdateCheckResult, PiCliUpdateResult, PetManifest, WebNetworkAddress } from "../../../shared/types";
import { GRID_COLS, CELL_W, CELL_H, MODE_ROW, MODE_FRAMES } from "../../pet/PetSpriteSheet";
import { Label } from "../../components/ui-shadcn/label";

const ZOOM_FACTOR_MIN = 0.8;
const ZOOM_FACTOR_MAX = 1.5;
const ZOOM_FACTOR_STEP = 0.05;


type SettingsTabId = "common" | "appearance" | "proxy" | "dev" | "im" | "pet" | "storage" | "usage" | "process" | "vision";

// 注意：修改 SettingsTabId 枚举时需同步更新 SETTINGS_TAB_IDS 校验数组

/** localStorage 键：设置页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const SETTINGS_LAST_TAB_KEY = "pideck-settings-last-tab";

/** 全部合法 tab id，用于校验持久化值（避免版本更新后残留旧值导致无高亮）。 */
const SETTINGS_TAB_IDS: readonly SettingsTabId[] = [
	"common", "appearance", "proxy", "dev", "im", "pet", "storage", "usage", "process", "vision",
];

/**
 * 读取上次打开的设置 tab；localStorage 不可用、无记录或值已失效时回退默认值 "common"。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
function loadLastSettingsTab(): SettingsTabId {
	try {
		const raw = localStorage.getItem(SETTINGS_LAST_TAB_KEY);
		if (raw && (SETTINGS_TAB_IDS as readonly string[]).includes(raw)) return raw as SettingsTabId;
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败 */
	}
	return "common";
}

/** 代理相关字段：用于判断代理 tab 是否有未保存变更。 */
const PROXY_FIELDS: (keyof AppSettings)[] = [
	"piProxyEnabled",
	"piProxyUrl",
	"piProxyBypass",
	"desktopProxyEnabled",
	"desktopProxyUrl",
	"desktopProxyBypass",
];

/** 已修改但未保存的字段标记：在标签右侧显示一个黄色圆点 */
function DirtyMarker(props: { dirty: boolean; label: string }) {
	if (!props.dirty) return null;
	return (
		<span
			className="setting-dirty-marker"
			title={t("settings.dirtyTooltip")}
			aria-label={props.label}
		/>
	);
}

type SettingsModalProps = {
	settings: AppSettings;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	piProxyChecking: boolean;
	piProxyNotice: string;
	piProxyNoticeTone: "info" | "success" | "error";
	webServiceChanging: boolean;
	onRestartWebService: () => void;
	appInfo: AppInfo;
	customPiPath: string;
	customPathValidating: boolean;
	customPathResult: PiInstallStatus | null;
	updateChecking: boolean;
	piUpdating: boolean;
	piUpdateChecking: boolean;
	piUpdateCheck: PiUpdateCheckResult | null;
	piUpdateResult: PiCliUpdateResult | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	onCheckPiUpdate: () => void;
	onUpdatePi: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	onClearCheckFlag?: () => void;
	onOpenWebService: (port: string) => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * 设置弹框错误边界：渲染异常时保留可关闭的错误面板，避免整页白屏无法退出。
 */
// 小窗口保留外边距，避免设置页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const settingsModalSizeClass = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";

class SettingsModalErrorBoundary extends Component<
	{ onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override render() {
		if (!this.state.error) return this.props.children;
		// #115：错误兜底直接走 shadcn Dialog 外壳
		return (
			<Dialog open onOpenChange={(next) => !next && this.props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.loadFailed")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="settings-layout">
					<div className="settings-content" style={{ padding: "var(--space-5)" }}>
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("settings.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>{t("settings.renderCrashedHelp")}</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
				</div>
			</DialogContent>
			</Dialog>
		);
	}
}

/** 对外导出：包一层错误边界，内部渲染异常时仍可关闭弹框。 */
export function SettingsModal(props: SettingsModalProps) {
	return (
		<SettingsModalErrorBoundary onClose={props.onClose}>
			<SettingsModalContent {...props} />
		</SettingsModalErrorBoundary>
	);
}

function SettingsModalContent(props: SettingsModalProps) {
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容），
	// 用 lazy initializer 在挂载时读一次 localStorage，恢复到上次所在 tab。
	const [activeTab, setActiveTab] = useState<SettingsTabId>(loadLastSettingsTab);
	// ── 全局设置草稿：进入弹框时快照 props.settings，所有修改在 draft 上操作，保存时统一提交 ──
	const [draftSettings, setDraftSettings] = useState<AppSettings>(() => ({ ...props.settings }));
	const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
	/** 打开弹框时的原始设置快照，用于取消时回退 */
	const baseSnapshotRef = useRef<AppSettings>({ ...props.settings });
	/** 标记是否为首次挂载（跳过外部 props.settings 同步） */
	const initialMountRef = useRef(true);
	// ── 视觉桥草稿：独立于全局设置（写 pi-deck-vision.json，走独立 IPC），脏标记/保存/取消由弹框统一管理 ──
	const visionDraft = useVisionBridgeDraft();

	/** 更新草稿并标记对应字段为已修改。调用方传入的 patch 中的每个 key 都会追加到 dirtyFields。 */
	const updateDraft = (patch: Partial<AppSettings>) => {
		setDraftSettings((prev) => ({ ...prev, ...patch }));
		setDirtyFields((prev) => {
			const next = new Set(prev);
			for (const key of Object.keys(patch)) {
				next.add(key);
			}
			return next;
		});
	};

	/** 检查指定字段在草稿中是否已被修改（与初始快照比较） */
	const isDirty = (field: keyof AppSettings): boolean => {
		return dirtyFields.has(field);
	};

	/** 保存全部已修改内容：全局设置差异提交 + 视觉桥草稿（若有改动）；返回是否全部成功 */
	const saveAll = async (): Promise<boolean> => {
		let ok = true;
		if (dirtyFields.size > 0) {
			const patch: Partial<AppSettings> = {};
			for (const key of dirtyFields) {
				(patch as Record<string, unknown>)[key] = (draftSettings as Record<string, unknown>)[key];
			}
			props.onChange(patch);
			// 更新快照基准为当前草稿值，并清除修改标记
			baseSnapshotRef.current = { ...baseSnapshotRef.current, ...patch };
			setDirtyFields(new Set());
		}
		if (visionDraft.dirty) {
			// 视觉桥保存失败（如 API Key 缺失/接口不可达）时保留脏标记，头部按钮可重试
			ok = await visionDraft.save();
		}
		return ok;
	};

	/** 取消全部修改：将草稿回退到初始快照，丢弃所有未保存变更（含视觉桥草稿） */
	const cancelAll = () => {
		setDraftSettings({ ...baseSnapshotRef.current });
		setDirtyFields(new Set());
		visionDraft.reset();
		setPetPreviewMode("__auto");
		void window.piDesktop.pet.setPreviewMode("");
		setWslValidation(null);
		setWslUserInput(baseSnapshotRef.current.wslUser);
		setPerAreaFontSize(
			baseSnapshotRef.current.uiFontSize !== null ||
				baseSnapshotRef.current.chatFontSize !== null ||
				baseSnapshotRef.current.inputFontSize !== null,
		);
		setWebPortDraft(String(baseSnapshotRef.current.webServicePort));
	};

	/** 关闭弹框：有未保存变更（全局设置或视觉桥草稿）时弹出确认对话框，无变更时直接关闭 */
	const handleClose = () => {
		if (dirtyFields.size > 0 || visionDraft.dirty) {
			setCloseConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择保存并关闭：视觉桥保存失败则留在弹框内（脏标记保留，可重试） */
	const handleSaveAndClose = async () => {
		setCloseConfirmOpen(false);
		const ok = await saveAll();
		if (ok) {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择放弃更改 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		props.onClose();
	};

	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

	const [perAreaFontSize, setPerAreaFontSize] = useState(
		draftSettings.uiFontSize !== null ||
			draftSettings.chatFontSize !== null ||
			draftSettings.inputFontSize !== null,
	);
	const [webPortDraft, setWebPortDraft] = useState(String(draftSettings.webServicePort));
	const [webNetworkAddresses, setWebNetworkAddresses] = useState<WebNetworkAddress[]>([]);
	const [selectedWebAddress, setSelectedWebAddress] = useState("");
	const [webQrDataUrl, setWebQrDataUrl] = useState("");
	const [webNetworkLoading, setWebNetworkLoading] = useState(false);
	const piPath = props.settings.customPiPath || props.piStatus?.command || "";
	const changeZoomFactor = (delta: number) => {
		const next = Math.min(
			ZOOM_FACTOR_MAX,
			Math.max(
				ZOOM_FACTOR_MIN,
				Math.round((draftSettings.zoomFactor + delta) * 100) / 100,
			),
		);
		updateDraft({ zoomFactor: next });
	};
	const fontSizeOptions = [
		{ value: "compact", label: t("settings.fontSizeCompact") },
		{ value: "default", label: t("settings.fontSizeDefault") },
		{ value: "medium", label: t("settings.fontSizeMedium") },
		{ value: "large", label: t("settings.fontSizeLarge") },
		{ value: "xlarge", label: t("settings.fontSizeXlarge") },
	];
	const fontBaseOptions = [
		{ value: "system", label: t("settings.fontFamilyBaseSystem") },
		{ value: "sans", label: t("settings.fontFamilyBaseSans") },
		{ value: "serif", label: t("settings.fontFamilyBaseSerif") },
		{ value: "custom", label: t("settings.fontCustomOption") },
	];
	const fontMonoOptions = [
		{ value: "system-mono", label: t("settings.fontFamilyMonoSystemMono") },
		{ value: "custom", label: t("settings.fontCustomOption") },
	];

	// ── WSL 相关状态 ──
	const [wslUserInput, setWslUserInput] = useState(draftSettings.wslUser);
	const [wslDistros, setWslDistros] = useState<string[]>([]);
	const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
	const [wslDistrosAttempted, setWslDistrosAttempted] = useState(false);
	const [wslValidating, setWslValidating] = useState(false);
	const [wslValidation, setWslValidation] = useState<{
		ok: boolean;
		whoami: string;
		piVersion: string;
		error: string;
	} | null>(null);
	// WSL 发行版列表懒加载（仅 Windows + WSL 开启时拉取，无论成败只拉一次）
	useEffect(() => {
		const isWin = props.appInfo.platform === "win32";
		if (isWin && draftSettings.wslEnabled && !wslDistrosAttempted && !wslDistrosLoading && window.piDesktop.wsl) {
			setWslDistrosLoading(true);
			window.piDesktop.wsl
				.listDistros()
				.then((list) => { setWslDistros(list); setWslDistrosAttempted(true); })
				.catch(() => { setWslDistros([]); setWslDistrosAttempted(true); })
				.finally(() => setWslDistrosLoading(false));
		}
	}, [draftSettings.wslEnabled, wslDistrosAttempted, wslDistrosLoading, props.appInfo.platform]);

	const distroOptions = wslDistros.length > 0
		? wslDistros.map((d) => ({ value: d, label: d }))
		: [{ value: draftSettings.wslDistro, label: draftSettings.wslDistro }];

	const handleValidateWslUser = async () => {
		if (!window.piDesktop.wsl) {
			setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.apiUnavailable") });
			return;
		}
		setWslValidating(true);
		setWslValidation(null);
		try {
			const result = await window.piDesktop.wsl.validateConnection(draftSettings.wslDistro, wslUserInput);
			setWslValidation(result);
			if (result.ok) {
				// 验证通过后，将用户输入写入 draft
				updateDraft({ wslUser: wslUserInput });
			}
		} catch (err) {
			console.error("[Settings] WSL validation failed", err);
			setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.validationFailed") });
		} finally {
			setWslValidating(false);
		}
	};

	// Git 摘要模型列表与会话 Command 选择器共用 pi --list-models 数据源。
	const [gitModels, setGitModels] = useState<AvailableModel[]>([]);
	const [gitModelPickerOpen, setGitModelPickerOpen] = useState(false);
	useEffect(() => {
		let active = true;
		void desktopApi.projects.listModels()
			.then((models) => {
				if (active) setGitModels(models);
			})
			.catch(() => {
				if (active) setGitModels([]);
			});
		return () => {
			active = false;
		};
	}, []);

	// 宠物包列表
	const [petOptions, setPetOptions] = useState<{ value: string; label: string }[]>([]);
	const [petList, setPetList] = useState<PetManifest[]>([]);
	useEffect(() => {
		window.piDesktop.pet
			.list()
			.then((pets) => { setPetList(pets); setPetOptions(pets.map((p) => ({ value: p.id, label: p.displayName }))); })
			.catch(() => undefined);
	}, []);
	// 开发设置 tab 不自动检测 pi：检测结果缓存在 settings.piInstall（打开时直接显示），
	// 只有用户手动点「检测环境」才重新 spawn 探测（曾因自动检测在打开设置时触发双弹窗）。
	const [petPreviewMode, setPetPreviewMode] = useState("__auto");
	// 预览只属于设置弹框生命周期；关闭后必须让真实 Agent 状态重新接管宠物。
	useEffect(() => () => {
		void window.piDesktop.pet.setPreviewMode("");
	}, []);

	const applyWebPortDraft = () => {
		const port = Number(webPortDraft);
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== draftSettings.webServicePort) {
			updateDraft({ webServicePort: port });
		} else {
			setWebPortDraft(String(draftSettings.webServicePort));
		}
	};

	// 网卡地址只在设置弹框内展示；优先局域网 IPv4，VPN/虚拟网卡仍保留为可选入口。
	useEffect(() => {
		const loadAddresses = desktopApi.app.networkAddresses;
		if (typeof loadAddresses !== "function") return;
		let active = true;
		setWebNetworkLoading(true);
		void loadAddresses()
			.then((addresses) => {
				if (!active) return;
				setWebNetworkAddresses(addresses);
				setSelectedWebAddress((current) =>
					addresses.some((item) => item.address === current)
						? current
						: addresses.find((item) => item.isPrivate)?.address ?? addresses[0]?.address ?? "",
				);
			})
			.catch(() => {
				if (active) setWebNetworkAddresses([]);
			})
			.finally(() => {
				if (active) setWebNetworkLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	const webAccessUrl = selectedWebAddress
		? `http://${selectedWebAddress}:${webPortDraft || draftSettings.webServicePort}`
		: "";

	// URL 或开关变化时重新编码，二维码只保存 data URL，不把主进程能力暴露给页面。
	useEffect(() => {
		if (!draftSettings.webServiceEnabled || !webAccessUrl) {
			setWebQrDataUrl("");
			return;
		}
		let active = true;
		void QRCode.toDataURL(webAccessUrl, {
			width: 192,
			margin: 1,
			color: { dark: "#111827", light: "#ffffff" },
		})
			.then((dataUrl) => {
				if (active) setWebQrDataUrl(dataUrl);
			})
			.catch(() => {
				if (active) setWebQrDataUrl("");
			});
		return () => {
			active = false;
		};
	}, [draftSettings.webServiceEnabled, webAccessUrl]);

	const tabs: Array<{
		id: SettingsTabId;
		label: string;
		icon: ReactNode;
	}> = [
		{
			id: "common",
			label: t("settings.tabs.common"),
			icon: <Settings2 size={16} />,
		},
		{
			id: "appearance",
			label: t("settings.tabs.appearance"),
			icon: <Brush size={16} />,
		},
		{
			id: "proxy",
			label: t("settings.tabs.proxy"),
			icon: <Network size={16} />,
		},
		{
			id: "dev",
			label: t("settings.tabs.dev"),
			icon: <Wrench size={16} />,
		},
		{
			id: "im",
			label: t("settings.tabs.im"),
			icon: <MessageSquare size={16} />,
		},
		{
			id: "pet",
			label: t("settings.tabs.pet"),
			icon: <PawPrint size={16} />,
		},
		{
			id: "storage",
			label: t("settings.tabs.storage"),
			icon: <Trash2 size={16} />,
		},
		{
			id: "usage",
			label: t("settings.tabs.usage"),
			icon: <ChartColumnBig size={16} />,
		},
		{
			id: "process",
			label: t("settings.tabs.process"),
			icon: <Activity size={16} />,
		},
		{
			id: "vision",
			label: t("settings.tabs.vision"),
			icon: <Eye size={16} />,
		},
	];
	const themeOptions = [
		{ value: "system", label: t("settings.themeSystem") },
		{ value: "light", label: t("settings.themeLight") },
		{ value: "dark", label: t("settings.themeDark") },
	];
	// 主题色预设来自 themePresets.ts；新增自定义主题 = 扩展色板后这里自动出现
	const accentOptions = ACCENT_PRESETS.map((preset) => ({
		value: preset.id,
		label: t(preset.labelKey),
	}));
	const startupWindowModeOptions = [
		{ value: "last", label: t("settings.startupWindow.last") },
		{ value: "maximized", label: t("settings.startupWindow.maximized") },
		{ value: "normal-large", label: t("settings.startupWindow.large") },
		{ value: "normal-medium", label: t("settings.startupWindow.medium") },
		{ value: "normal-compact", label: t("settings.startupWindow.compact") },
		{ value: "fullscreen", label: t("settings.startupWindow.fullscreen") },
	];
	const languageOptions = [
		{ value: "system", label: t("settings.languageSystem") },
		{ value: "zh-CN", label: t("settings.languageZh") },
		{ value: "en-US", label: t("settings.languageEn") },
		{ value: "pseudo", label: t("settings.languagePseudo") },
	];
	const sendShortcutOptions = [
		{ value: "enter-send", label: t("settings.sendShortcut.enter") },
		{ value: "ctrl-enter-send", label: t("settings.sendShortcut.ctrl") },
		{ value: "shift-enter-send", label: t("settings.sendShortcut.shift") },
	];
	const linkOpenModeOptions = [
		{ value: "external", label: t("settings.linkOpenMode.external") },
		{ value: "internal", label: t("settings.linkOpenMode.internal") },
	];
	const workspaceContentOpenModeOptions = [
		{ value: "split", label: t("settings.workspaceContentOpenMode.split") },
		{ value: "maximize", label: t("settings.workspaceContentOpenMode.maximize") },
	];

	const hasDirtyChanges = dirtyFields.size > 0;
	// 视觉桥草稿有未保存改动时，头部保存/取消按钮同样点亮（与全局设置脏标记合并判定）
	const hasAnyDirtyChanges = hasDirtyChanges || visionDraft.dirty;
	// 代理 tab 仍展示未保存提示；实际保存/取消统一走全局草稿，避免旧 proxyDirty 局部状态残留。
	const proxyDirty = PROXY_FIELDS.some((field) => dirtyFields.has(field));

		return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} stagger className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.title")}</DialogTitle>
					<div className="flex items-center gap-2">
						{/* 保存按钮常驻：无未保存改动时禁用，避免用户改完直接关窗丢改动；视觉桥保存中禁用防重复提交 */}
						<Button variant="default" size="sm" onClick={saveAll} disabled={!hasAnyDirtyChanges || visionDraft.saving}>
							{t("common.save")}
						</Button>
						{hasAnyDirtyChanges ? (
							/* 放弃更改用 outline（白底描边）而非灰底 secondary：与黑色主按钮形成
							    清晰的主次层级（shadcn dialog 的 confirm/cancel 惯例），避免一对按钮
							    都是灰色填充分不出哪个是提交。 */
							<Button variant="outline" size="sm" onClick={cancelAll}>
								{t("common.cancel")}
							</Button>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			<Tabs orientation="vertical" value={activeTab} onValueChange={(v) => { const match = tabs.find((t) => t.id === v); if (match) setActiveTab(match.id); try { localStorage.setItem(SETTINGS_LAST_TAB_KEY, match.id); } catch { /* localStorage 不可用时静默失败，仅本次会话内不记忆 */ } }} className="settings-layout flex min-h-0 flex-1 flex-row gap-0 bg-transparent">
					<TabsList className="settings-tabs flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[196px]" aria-label={t("settings.title")}>
						{tabs.map((tab) => (
							<TabsTrigger key={tab.id} value={tab.id} className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
								<span className="settings-tab-icon">{tab.icon}</span>
								<strong>{tab.label}</strong>
							</TabsTrigger>
						))}
					</TabsList>
					{/* ── 常用设置 tab ── */}
												<TabsContent value="common" className="settings-panel min-w-0">
							<>
								{/* 语言（单行分区：行标题即一级标题，内容行入淡色框） */}
								<SettingBox>
								<SettingRow
									level={1}
									title={
										<>
											<span>{t("settings.language")}</span>
											<DirtyMarker dirty={isDirty("language")} label={t("settings.language")} />
										</>
									}
									alignEnd={false}
								>
									<Select value={draftSettings.language} onValueChange={(value) =>
											updateDraft({ language: value as AppSettings["language"] })
										}>
										<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
										<SelectContent>
											{languageOptions.map((option) => (
												<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
								</SettingBox>

								{/* 会话 */}
								<SettingsSection title={t("settings.sectionSession")}>
									<SettingRow
										title={
											<>
												<span>{t("settings.sessionTabOpenMode")}</span>
												<DirtyMarker dirty={isDirty("sessionTabOpenMode")} label={t("settings.sessionTabOpenMode")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.sessionTabOpenMode} onValueChange={(value) =>
												updateDraft({ sessionTabOpenMode: value as AppSettings["sessionTabOpenMode"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												<SelectItem value="preview">{t("settings.sessionTabOpenModePreview")}</SelectItem>
												<SelectItem value="permanent">{t("settings.sessionTabOpenModePermanent")}</SelectItem>
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingRow
										title={
											<>
												<span>{t("settings.inputShortcut")}</span>
												<DirtyMarker dirty={isDirty("sendShortcut")} label={t("settings.inputShortcut")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.sendShortcut} onValueChange={(value) =>
												updateDraft({ sendShortcut: value as AppSettings["sendShortcut"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{sendShortcutOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingRow
										title={
											<>
												<span>{t("settings.linkOpenMode")}</span>
												<DirtyMarker dirty={isDirty("linkOpenMode")} label={t("settings.linkOpenMode")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.linkOpenMode} onValueChange={(value) =>
												updateDraft({ linkOpenMode: value as AppSettings["linkOpenMode"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{linkOpenModeOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingRow
										title={
											<>
												<span>{t("settings.workspaceContentOpenMode")}</span>
												<DirtyMarker dirty={isDirty("workspaceContentOpenMode")} label={t("settings.workspaceContentOpenMode")} />
											</>
										}
										description={t("settings.workspaceContentOpenModeDesc")}
										alignEnd={false}
									>
										<Select
											value={draftSettings.workspaceContentOpenMode ?? "split"}
											onValueChange={(value) =>
												updateDraft({
													workspaceContentOpenMode: value as AppSettings["workspaceContentOpenMode"],
												})
											}
										>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{workspaceContentOpenModeOptions.map((option) => (
													<SelectItem key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									{/* 流式对话设置：省渲染资源的两个行为开关（默认值见 SettingsStore）。 */}
									<SettingSwitchRow
										title={t("settings.expandInterimDuringStream")}
										description={t("settings.expandInterimDuringStreamDesc")}
										checked={draftSettings.expandInterimDuringStream}
										onChange={(checked) => updateDraft({ expandInterimDuringStream: checked })}
									/>
									<SettingSwitchRow
										title={t("settings.collapsePrevRunsOnNewTurn")}
										description={t("settings.collapsePrevRunsOnNewTurnDesc")}
										checked={draftSettings.collapsePrevRunsOnNewTurn}
										onChange={(checked) => updateDraft({ collapsePrevRunsOnNewTurn: checked })}
									/>
								</SettingsSection>

								{/* 通知 */}
								<SettingsSection title={t("settings.notificationSection")}>
									<SettingSwitchRow
										title={t("settings.enableNotifications")}
										checked={draftSettings.enableNotifications}
										onChange={(checked) =>
											updateDraft({ enableNotifications: checked })
										}
									/>
									<SettingSwitchRow
										title={t("settings.agentCountReminder")}
										description={t("settings.agentCountReminderDesc")}
										checked={draftSettings.agentCountReminderEnabled}
										onChange={(checked) =>
											updateDraft({ agentCountReminderEnabled: checked })
										}
									/>
								</SettingsSection>

								{/* 窗口 */}
								<SettingsSection title={t("settings.sectionWindow")}>
									<SettingRow
										title={
											<>
												<span>{t("settings.startupWindowMode")}</span>
												<DirtyMarker
													dirty={isDirty("startupWindowMode")}
													label={t("settings.startupWindowMode")}
												/>
											</>
										}
										description={t("settings.startupWindowModeDesc")}
										alignEnd={false}
									>
										<Select value={draftSettings.startupWindowMode} onValueChange={(value) =>
												updateDraft({
													startupWindowMode: value as AppSettings["startupWindowMode"],
												})
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{startupWindowModeOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingSwitchRow
										title={t("settings.closeToTray")}
										checked={draftSettings.closeToTray}
										onChange={(checked) =>
											updateDraft({ closeToTray: checked })
										}
									/>
									<SettingSwitchRow
										title={t("settings.singleInstance")}
										description={t("settings.singleInstanceDesc")}
										checked={draftSettings.singleInstance}
										onChange={(checked) =>
											updateDraft({ singleInstance: checked })
										}
									/>
								</SettingsSection>

								{/* Git */}
								<SettingsSection title={t("settings.git")}>
									<SettingSwitchRow
										title={t("settings.gitManagement")}
										description={t("settings.gitManagementDesc")}
										checked={draftSettings.enableGitManagement}
										onChange={(checked) =>
											updateDraft({ enableGitManagement: checked })
										}
									/>
									{draftSettings.enableGitManagement && (
										<>
											<SettingRow
												title={
													<>
														<span>{t("settings.gitCommitMessageModel")}</span>
														<DirtyMarker dirty={isDirty("gitCommitMessageProvider") || isDirty("gitCommitMessageModel")} label={t("settings.gitCommitMessageModel")} />
													</>
												}
												description={t("settings.gitCommitMessageModelDesc")}
											>
												<Button
													variant="outline"
													className="w-full justify-start font-mono text-xs"
													onClick={() => setGitModelPickerOpen(true)}
												>
													{draftSettings.gitCommitMessageProvider && draftSettings.gitCommitMessageModel
														? `${draftSettings.gitCommitMessageProvider}/${draftSettings.gitCommitMessageModel}`
														: t("settings.gitCommitMessageModelUnset")}
												</Button>
											</SettingRow>
											<SettingTextarea
												title={t("settings.gitCommitMessagePrompt")}
												description={t("settings.gitCommitMessagePromptDesc")}
												value={draftSettings.gitCommitMessagePrompt}
												onChange={(value) => updateDraft({ gitCommitMessagePrompt: value })}
											/>
											{gitModelPickerOpen && (
												<ModelPicker
													models={gitModels}
													current={{
														provider: draftSettings.gitCommitMessageProvider,
														modelId: draftSettings.gitCommitMessageModel,
													}}
													favoriteModels={draftSettings.favoriteModels ?? []}
													onClose={() => setGitModelPickerOpen(false)}
													onPick={(model) => {
														updateDraft({
															gitCommitMessageProvider: model.provider,
															gitCommitMessageModel: model.id,
														});
														setGitModelPickerOpen(false);
													}}
													onToggleFavorite={(provider, modelId) => {
														const key = `${provider}/${modelId}`;
														const favorites = draftSettings.favoriteModels ?? [];
														updateDraft({
															favoriteModels: favorites.includes(key)
																? favorites.filter((item) => item !== key)
																: [...favorites, key],
														});
													}}
												/>
											)}
										</>
									)}
								</SettingsSection>
							</>
						</TabsContent>

						{/* ── 外观设置 tab ── */}
												<TabsContent value="appearance" className="settings-panel min-w-0">
							<>
								{/* 主题与背景 */}
								<SettingsSection title={t("settings.sectionThemeBackground")}>
									<SettingRow
										title={
											<>
												<span>{t("settings.theme")}</span>
												<DirtyMarker dirty={isDirty("theme")} label={t("settings.theme")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.theme} onValueChange={(value) =>
												updateDraft({ theme: value as AppSettings["theme"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{themeOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingRow
										title={
											<>
												<span>{t("settings.accent")}</span>
												<DirtyMarker dirty={isDirty("accent")} label={t("settings.accent")} />
											</>
										}
										description={t("settings.accentDesc")}
										alignEnd={false}
									>
										<Select value={draftSettings.accent} onValueChange={(value) =>
												updateDraft({ accent: value as AppSettings["accent"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{accentOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									{/* 背景图片：pideck-bg:// 协议加载 userData/backgrounds/ 下文件 */}
									<SettingRow
										title={
											<>
												<span>{t("settings.backgroundImage")}</span>
												<DirtyMarker dirty={isDirty("backgroundImage") || isDirty("backgroundImageOpacity")} label={t("settings.backgroundImage")} />
											</>
										}
										description={t("settings.backgroundImageDesc")}
									>
										<div className="flex items-center gap-2">
											{draftSettings.backgroundImage ? (
												<img
													src={`pideck-bg://local/${encodeURIComponent(draftSettings.backgroundImage)}`}
													alt=""
													className="h-12 w-20 shrink-0 rounded-sm border border-border object-cover"
												/>
											) : (
												<div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[11px] text-muted-foreground">—</div>
											)}
											<Button
												variant="outline"
												size="sm"
												onClick={async () => {
													const name = await desktopApi.dialog.pickBackgroundImage();
													if (name) updateDraft({ backgroundImage: name });
												}}
											>
												{t("settings.backgroundImageChoose")}
											</Button>
											{draftSettings.backgroundImage ? (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														const name = draftSettings.backgroundImage;
														updateDraft({ backgroundImage: "" });
														if (name) void desktopApi.dialog.removeBackgroundImage(name);
													}}
												>
													{t("settings.backgroundImageClear")}
												</Button>
											) : null}
										</div>
									</SettingRow>
									<SettingRow
										title={<span>{t("settings.backgroundImageOpacity")}</span>}
									>
										<div className="flex w-full items-center gap-2">
											<input
												type="range"
												min={0}
												max={100}
												// 滑块与存储同语义=图片可见度（100%=图全显，0%=全遮罩），不再反转
												value={Math.round((draftSettings.backgroundImageOpacity ?? 0.8) * 100)}
												onChange={(event) =>
													updateDraft({ backgroundImageOpacity: Number(event.target.value) / 100 })
												}
												className="h-4 min-w-0 flex-1 accent-[var(--color-accent)]"
												aria-label={t("settings.backgroundImageOpacity")}
											/>
											<span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{Math.round((draftSettings.backgroundImageOpacity ?? 0.8) * 100)}%</span>
										</div>
									</SettingRow>
								</SettingsSection>

								{/* 字体 */}
								<SettingsSection title={t("settings.sectionFonts")}>
									{/* 窗口缩放：与字号设置同分组，避免「字变大」两个入口分散在不同分组；
									   提示文案说明其与字号档位的区别（缩放=整体，字号=仅文字）。 */}
									<SettingRow
										title={
											<>
												<span>{t("settings.zoomFactor")}</span>
												<DirtyMarker dirty={isDirty("zoomFactor")} label={t("settings.zoomFactor")} />
											</>
										}
										description={t("settings.zoomFactorHint")}
									>
										<div className="flex items-center gap-2">
											<Button
												variant="ghost"
												size="icon"
												className="size-8 rounded-[6px] border border-border-subtle bg-bg-panel text-text-secondary hover:border-[var(--color-accent)] hover:bg-bg-active hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
												disabled={draftSettings.zoomFactor <= ZOOM_FACTOR_MIN}
												onClick={() => changeZoomFactor(-ZOOM_FACTOR_STEP)}
												aria-label={t("settings.zoomOut")}
												title={t("settings.zoomOut")}
											>
												<Minus size={16} strokeWidth={2.2} aria-hidden="true" />
											</Button>
											<output
												className="min-w-8 text-center font-brand text-control font-semibold text-foreground"
												aria-live="polite"
											>
												{Math.round(draftSettings.zoomFactor * 100)}%
											</output>
											<Button
												variant="ghost"
												size="icon"
												className="size-8 rounded-[6px] border border-border-subtle bg-bg-panel text-text-secondary hover:border-[var(--color-accent)] hover:bg-bg-active hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
												disabled={draftSettings.zoomFactor >= ZOOM_FACTOR_MAX}
												aria-label={t("settings.zoomIn")}
												title={t("settings.zoomIn")}
												onClick={() => changeZoomFactor(ZOOM_FACTOR_STEP)}
											>
												<Plus size={16} strokeWidth={2.2} aria-hidden="true" />
											</Button>
										</div>
									</SettingRow>
									<SettingRow
										title={
											<>
												<span>{t("settings.fontSize")}</span>
												<DirtyMarker dirty={isDirty("fontSize")} label={t("settings.fontSize")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.fontSize} onValueChange={(value) =>
												updateDraft({ fontSize: value as AppSettings["fontSize"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{fontSizeOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingSwitchRow
										title={t("settings.fontSizePerArea")}
										description={t("settings.fontSizePerAreaDesc")}
										checked={perAreaFontSize}
										onChange={(checked) => {
											setPerAreaFontSize(checked);
											if (!checked) {
												updateDraft({ uiFontSize: null, chatFontSize: null, inputFontSize: null });
											}
										}}
									/>
									{perAreaFontSize && (
										<>
											<SettingRow
												title={
													<>
														<span>{t("settings.uiFontSize")}</span>
														<DirtyMarker dirty={isDirty("uiFontSize")} label={t("settings.uiFontSize")} />
													</>
												}
												alignEnd={false}
											>
												<Select value={draftSettings.uiFontSize ?? draftSettings.fontSize} onValueChange={(value) =>
														updateDraft({ uiFontSize: value as AppSettings["uiFontSize"] })
													}>
													<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
													<SelectContent>
														{fontSizeOptions.map((option) => (
															<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
																{option.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</SettingRow>
											<SettingRow
												title={
													<>
														<span>{t("settings.chatFontSize")}</span>
														<DirtyMarker dirty={isDirty("chatFontSize")} label={t("settings.chatFontSize")} />
													</>
												}
												alignEnd={false}
											>
												<Select value={draftSettings.chatFontSize ?? draftSettings.fontSize} onValueChange={(value) =>
														updateDraft({ chatFontSize: value as AppSettings["chatFontSize"] })
													}>
													<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
													<SelectContent>
														{fontSizeOptions.map((option) => (
															<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
																{option.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</SettingRow>
											<SettingRow
												title={
													<>
														<span>{t("settings.inputFontSize")}</span>
														<DirtyMarker dirty={isDirty("inputFontSize")} label={t("settings.inputFontSize")} />
													</>
												}
												alignEnd={false}
											>
												<Select value={draftSettings.inputFontSize ?? draftSettings.fontSize} onValueChange={(value) =>
														updateDraft({ inputFontSize: value as AppSettings["inputFontSize"] })
													}>
													<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
													<SelectContent>
														{fontSizeOptions.map((option) => (
															<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
																{option.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</SettingRow>
										</>
									)}
									<SettingRow
										title={
											<>
												<span>{t("settings.fontFamilyBase")}</span>
												<DirtyMarker dirty={isDirty("fontFamilyBase")} label={t("settings.fontFamilyBase")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.fontFamilyBase} onValueChange={(value) =>
												updateDraft({ fontFamilyBase: value as AppSettings["fontFamilyBase"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{fontBaseOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									{draftSettings.fontFamilyBase === "custom" && (
										<SettingRow
											title={<span>{t("settings.fontFamilyBaseCustomField")}</span>}
											stacked
										>
											<Input type="text" value={draftSettings.fontFamilyBaseCustom} placeholder={t("settings.fontFamilyBaseCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyBaseCustom: event.target.value })} />
										</SettingRow>
									)}
									<SettingRow
										title={
											<>
												<span>{t("settings.fontFamilyMono")}</span>
												<DirtyMarker dirty={isDirty("fontFamilyMono")} label={t("settings.fontFamilyMono")} />
											</>
										}
										alignEnd={false}
									>
										<Select value={draftSettings.fontFamilyMono} onValueChange={(value) =>
												updateDraft({ fontFamilyMono: value as AppSettings["fontFamilyMono"] })
											}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{fontMonoOptions.map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									{draftSettings.fontFamilyMono === "custom" && (
										<SettingRow
											title={<span>{t("settings.fontFamilyMonoCustomField")}</span>}
											stacked
										>
											<Input type="text" value={draftSettings.fontFamilyMonoCustom} placeholder={t("settings.fontFamilyMonoCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyMonoCustom: event.target.value })} />
										</SettingRow>
									)}
								</SettingsSection>

								{/* 聊天排版 */}
								<SettingsSection title={t("settings.sectionChatLayout")}>
									<SettingRow
										title={<span>{t("settings.contentWidthPct")}</span>}
										description={t("settings.contentWidthPctDesc")}
									>
										<div className="flex w-full items-center gap-2">
											<input
												type="range"
												min="60"
												max="100"
												step="1"
												value={draftSettings.chatContentWidthPct}
												onChange={(event) => updateDraft({ chatContentWidthPct: parseInt(event.target.value) })}
												className="min-w-0 flex-1 accent-[var(--color-accent)]"
												aria-label={t("settings.contentWidthPct")}
											/>
											<span className="min-w-8 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">
												{draftSettings.chatContentWidthPct}%
											</span>
										</div>
									</SettingRow>
								</SettingsSection>

								{/* 窗口样式 */}
								<SettingsSection title={t("settings.sectionWindowStyle")}>
									<SettingSwitchRow
										title={t("settings.nativeTitleBar")}
										checked={draftSettings.useNativeTitleBar}
										onChange={(checked) =>
											updateDraft({ useNativeTitleBar: checked })
										}
									/>
									<SettingSwitchRow
										title={t("settings.nativeMenu")}
										checked={draftSettings.showNativeMenu}
										onChange={(checked) =>
											updateDraft({ showNativeMenu: checked })
										}
									/>
								</SettingsSection>
							</>
						</TabsContent>

						{/* ── 代理设置 tab ── */}
												<TabsContent value="proxy" className="settings-panel min-w-0">
							<>
								{/* 未保存更改的提示横幅 */}
								{proxyDirty && (
									<div className="setting-proxy-unsaved-bar">
										<span className="setting-proxy-unsaved-dot" />
										<span>{t("settings.proxyUnsaved")}</span>
										<small>{t("settings.proxyApplyHint")}</small>
									</div>
								)}
								<SettingsSection
									title={t("settings.piProxy")}
									description={t("settings.piProxyDesc")}
								>
									<SettingSwitchRow
										title={t("settings.enablePiProxy")}
										description={t("settings.settingTakesEffectAfterRestart")}
										checked={draftSettings.piProxyEnabled}
										onChange={(checked) =>
											updateDraft({ piProxyEnabled: checked })
										}
									/>
									{draftSettings.piProxyEnabled && (
										<div className="setting-proxy-panel">
											<SettingRow
												title={<span>{t("settings.proxyUrl")}</span>}
												stacked
											>
												<Input type="text" value={draftSettings.piProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ piProxyUrl: event.target.value })} />
											</SettingRow>
											<SettingRow
												title={<span>{t("settings.proxyBypass")}</span>}
												description={t("settings.noProxyHint")}
												stacked
											>
												<Input type="text" value={draftSettings.piProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ piProxyBypass: event.target.value })} />
											</SettingRow>
											<SettingRow
												title={<span>{t("settings.proxyTest")}</span>}
												description={
													<>
														{t("settings.proxyNoApiKey")}
														{props.piProxyNotice && (
															<span className={`setting-status ${props.piProxyNoticeTone}`}>
																{props.piProxyNotice}
															</span>
														)}
													</>
												}
											>
												<Button variant="secondary"
													onClick={props.onTestPiProxy}
													disabled={props.piProxyChecking}
												>
													{props.piProxyChecking
														? t("settings.testingProxy")
														: t("settings.testProxy")}
												</Button>
											</SettingRow>
										</div>
									)}
								</SettingsSection>
								<SettingsSection
									title={t("settings.desktopProxy")}
									description={t("settings.desktopProxyDesc")}
								>
									<SettingSwitchRow
										title={t("settings.enableDesktopProxy")}
										description={t("settings.desktopProxyDesc")}
										checked={draftSettings.desktopProxyEnabled}
										onChange={(checked) =>
											updateDraft({ desktopProxyEnabled: checked })
										}
									/>
									{draftSettings.desktopProxyEnabled && (
										<div className="setting-proxy-panel">
											<SettingRow
												title={<span>{t("settings.proxyUrl")}</span>}
												stacked
											>
												<Input type="text" value={draftSettings.desktopProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ desktopProxyUrl: event.target.value })} />
											</SettingRow>
											<SettingRow
												title={<span>{t("settings.proxyBypass")}</span>}
												description={t("settings.electronProxyHint")}
												stacked
											>
												<Input type="text" value={draftSettings.desktopProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ desktopProxyBypass: event.target.value })} />
											</SettingRow>
										</div>
									)}
								</SettingsSection>
								{/* 代理变更走全局草稿：顶部统一保存/取消，不再在 tab 底部重复放按钮 */}
							</>
						</TabsContent>

							{/* ── 开发设置 tab（含 Web 服务） ── */}
												<TabsContent value="dev" className="settings-panel min-w-0">
							<>
								{/* 环境 */}
								<SettingsSection title={t("settings.environment")}>
									{/* Pi CLI 状态：安装检测 + 路径信息 + 重新检测 */}
									<div className="setting-pi-status">
										<div className="setting-pi-status-indicator">
											<span
												className={"pi-status-dot " + (props.piStatus?.installed ? "online" : "offline")}
											/>
											<div className="setting-pi-status-text">
												<strong>Pi CLI</strong>
												<span>
													{props.piStatus
														? props.piStatus.installed
															? t("settings.foundPi", {
																	version: props.piStatus.version ?? "pi",
																})
															: t("settings.piMissing")
																				: t("settings.piCliAvailable")}
																		</span>
																		{props.piStatus?.installed && props.piStatus.runtimeKind && props.piStatus.runtimeKind !== "unknown" && (
																			<small className="setting-status info">
																				{props.piStatus.runtimeKind === "rust" ? t("settings.piRuntimeDetectedRust") : t("settings.piRuntimeDetectedTypescript")}
																			</small>
																		)}
												{piPath && (
													<span className="setting-path">
														{piPath}
													</span>
												)}
												{props.piStatus && !props.piStatus.installed && props.piStatus.error && (
													<span className="setting-status error">
														{props.piStatus.error}
													</span>
												)}
											</div>
										</div>
										<div className="setting-inline-actions">
											<Button variant="secondary" onClick={props.onCheckPi} disabled={props.piChecking}>
												{props.piChecking
													? t("settings.detecting")
													: t("settings.detectEnvironment")}
											</Button>
											{props.onClearCheckFlag && (
												<Button variant="secondary"
													onClick={props.onClearCheckFlag}
												>
													{t("environment.clearCheckFlag")}
												</Button>
											)}
											<Button variant="secondary"
												onClick={props.onCheckPiUpdate}
												loading={props.piUpdateChecking}
												disabled={draftSettings.disableUpdateCheck}
											>
												{t("settings.checkPiUpdate")}
											</Button>
											<Button variant="secondary"
												onClick={props.onUpdatePi}
												loading={props.piUpdating}
												disabled={
													draftSettings.disableUpdateCheck ||
													!props.piUpdateCheck?.hasUpdate
												}
											>
												{t("settings.updatePi")}
											</Button>
										</div>
									</div>
									{props.piUpdateResult && (
										<pre className="setting-update-output">
											{props.piUpdateResult.command}
											{"\n"}
											{props.piUpdateResult.output}
										</pre>
									)}

									<div className="my-3 border-0 border-t border-border-subtle" />

									{/* Pi 来源：Windows 原生 / WSL（仅 Windows 可见） */}
									{props.appInfo.platform === "win32" && (
									<div className="setting-pi-source-block">
										<div className="setting-pi-source-row">
											<span>{t("settings.piSource.label")}</span>
											<div className="grid gap-1.5">
												<Select value={draftSettings.wslEnabled ? "wsl" : "windows"} onValueChange={(value) => {
													updateDraft({ wslEnabled: value === "wsl" });
													setWslValidation(null);
												}}>
													<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
													<SelectContent>
														{[
															{ value: "windows", label: t("settings.piSource.windows") },
															{ value: "wsl", label: t("settings.piSource.wsl") },
														].map((option) => (
															<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
																{option.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</div>
										</div>
										{draftSettings.wslEnabled && (
											<div className="setting-pi-wsl-config">
												<div className="setting-wsl-fields">
													{wslDistros.length > 0 ? (
														<div className="grid min-w-[160px] flex-1 gap-1.5">
															<span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
															<Select value={draftSettings.wslDistro} onValueChange={(value) => {
																updateDraft({ wslDistro: value });
																setWslValidation(null);
															}}>
																<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
																<SelectContent>
																	{distroOptions.map((option) => (
																		<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
																			{option.label}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
														</div>
													) : (
														<div className="grid min-w-[160px] flex-1 gap-1.5">
															<span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
															<Input type="text" value={draftSettings.wslDistro} placeholder={"Ubuntu"} onChange={(event) => {
																updateDraft({ wslDistro: event.target.value });
																setWslValidation(null);
															}} />
														</div>
													)}
													{wslDistrosLoading && (
														<small className="setting-status info">{t("settings.wsl.detectingDistros")}</small>
													)}
													<div className="setting-wsl-user-row">
														<div className="grid min-w-[160px] flex-1 gap-1.5">
															<span className="text-control font-medium text-foreground">{t("settings.wsl.user")}</span>
															<Input type="text" value={wslUserInput} placeholder={"root"} onChange={(event) => {
																setWslUserInput(event.target.value);
																setWslValidation(null);
															}} />
														</div>
														<Button variant="secondary"
															size="sm"
															disabled={!wslUserInput.trim() || wslValidating}
															loading={wslValidating}
															onClick={handleValidateWslUser}
														>
															{t("settings.wsl.validateUser")}
														</Button>
													</div>
												</div>
												{wslValidation && (
													<div className={`setting-wsl-validation ${wslValidation.ok ? "success" : "error"}`}>
														{wslValidation.ok ? (
															<>
																<small className="setting-status success">
																	{t("settings.wsl.validationOk", {
																		user: wslValidation.whoami,
																		distro: draftSettings.wslDistro,
																	})}
																</small>
																{wslValidation.piVersion ? (
																	<small className="setting-status success">
																		{t("settings.wsl.piDetected", { version: wslValidation.piVersion })}
																	</small>
																) : (
																	<small className="setting-status warning">
																		{wslValidation.error || t("settings.wsl.piNotInstalled")}
																	</small>
																)}
															</>
														) : (
															<small className="setting-status error">{wslValidation.error}</small>
														)}
													</div>
												)}
											</div>
										)}
									</div>
									)}

									<div className="my-3 border-0 border-t border-border-subtle" />

									<div className="setting-pi-runtime-panel">
										<SettingRow title={<span>{t("settings.piRuntimePreference")}</span>} description={t("settings.piRuntimePreferenceHint")}>
											<Select value={draftSettings.piRuntimePreference} onValueChange={(value) => updateDraft({ piRuntimePreference: value as AppSettings["piRuntimePreference"] })}>
												<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
												<SelectContent>
													<SelectItem value="auto">{t("settings.piRuntimePreferenceAuto")}</SelectItem>
													<SelectItem value="typescript">{t("settings.piRuntimePreferenceTypescript")}</SelectItem>
													<SelectItem value="rust">{t("settings.piRuntimePreferenceRust")}</SelectItem>
												</SelectContent>
											</Select>
										</SettingRow>
										<SettingRow title={<span>{t("settings.piTypescriptPath")}</span>} description={t("settings.piTypescriptPathHint")} stacked>
											<Input type="text" value={draftSettings.piTypescriptPath} placeholder={t("settings.piTypescriptPathPlaceholder")} onChange={(event) => updateDraft({ piTypescriptPath: event.target.value })} />
										</SettingRow>
										<SettingRow title={<span>{t("settings.piRustPath")}</span>} description={t("settings.piRustPathHint")} stacked>
											<Input type="text" value={draftSettings.piRustPath} placeholder={t("settings.piRustPathPlaceholder")} onChange={(event) => updateDraft({ piRustPath: event.target.value })} />
										</SettingRow>
									</div>

									<div className="my-3 border-0 border-t border-border-subtle" />

									{/* 自定义 Pi 路径 */}
									<div className="setting-pi-path-panel">
										<SettingRow
											title={<span>{t("settings.customPiPath")}</span>}
											description={t("settings.customPiPathHint")}
											stacked
										>
											<Input type="text" value={props.customPiPath} placeholder={
												piPath ||
												"D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
											} disabled={props.customPathValidating} onChange={(event) => props.onCustomPathChange(event.target.value)} />
										</SettingRow>
										<div className="setting-pi-path-actions">
											<Button variant="secondary"
												onClick={props.onValidateCustomPath}
												disabled={!props.customPiPath.trim() || props.customPathValidating}
											>
												{props.customPathValidating
													? t("settings.validating")
													: t("settings.validatePiPath")}
											</Button>
											<Button variant="secondary"
												onClick={props.onClearCustomPath}
												disabled={!props.settings.customPiPath || props.customPathValidating}
											>
												{t("settings.clearCustomPiPath")}
											</Button>
										</div>
										{props.customPathResult && (
											<small className={`setting-status ${props.customPathResult.installed ? "success" : "error"}`}>
												{props.customPathResult.installed
													? t("settings.validatePassed", {
															value:
																props.customPathResult.command ??
																props.customPathResult.version ??
																"pi",
														})
													: t("settings.validateFailed", {
															error:
																props.customPathResult.error ??
																t("environment.unableToRun"),
														})}
											</small>
										)}
									</div>
								</SettingsSection>

								{/* 版本与更新 */}
								<SettingsSection title={t("settings.sectionUpdates")}>
									<SettingRow
										title={
											<>
												<span>PiDeck</span>
												<span className="text-caption font-normal text-muted-foreground">v{props.appInfo.version}</span>
											</>
										}
									>
										<Button variant="secondary"
											onClick={draftSettings.disableUpdateCheck ? undefined : props.onCheckUpdate}
											loading={props.updateChecking}
											disabled={draftSettings.disableUpdateCheck}
										>
											{draftSettings.disableUpdateCheck
												? t("settings.updateCheckDisabled")
												: t("settings.checkUpdate")}
										</Button>
									</SettingRow>
									<SettingSwitchRow
										title={t("settings.disableUpdateCheck")}
										description={t("settings.disableUpdateCheckDesc")}
										checked={draftSettings.disableUpdateCheck}
										onChange={(checked) =>
											updateDraft({ disableUpdateCheck: checked })
										}
									/>
								</SettingsSection>

								{/* 运行 */}
								<SettingsSection title={t("settings.sectionRuntime")}>
									<SettingRow
										title={
											<>
												<span>{t("settings.rpcTimeout")}</span>
												<DirtyMarker dirty={isDirty("rpcTimeout")} label={t("settings.rpcTimeout")} />
											</>
										}
										description={t("settings.rpcTimeoutDesc")}
										stacked
									>
										<Input
											type="number"
											className="max-w-80"
											value={String(Math.round(draftSettings.rpcTimeout / 1000))}
											onChange={(e) => {
												const seconds = Math.max(600, parseInt(e.target.value) || 600);
												updateDraft({ rpcTimeout: seconds * 1000 });
											}}
										/>
									</SettingRow>
									<SettingRow
										title={
											<>
												<span>{t("settings.maxEditorFileSize")}</span>
												<DirtyMarker dirty={isDirty("maxEditorFileSizeMB")} label={t("settings.maxEditorFileSize")} />
											</>
										}
										description={t("settings.maxEditorFileSizeDesc")}
										stacked
									>
										<Input
											type="number"
											className="max-w-80"
											value={String(draftSettings.maxEditorFileSizeMB)}
											onChange={(e) => {
												const mb = Math.max(1, parseInt(e.target.value) || 5);
												updateDraft({ maxEditorFileSizeMB: mb });
											}}
										/>
									</SettingRow>
									<SettingSwitchRow
										title={t("settings.electronSandbox")}
										description={t("settings.electronSandboxDesc")}
										checked={draftSettings.electronChromiumSandbox}
										onChange={(checked) =>
											updateDraft({ electronChromiumSandbox: checked })
										}
									/>
									<div className="px-0.5 pb-1 pt-3">
										<span className="text-caption font-semibold tracking-[0.06em] text-muted-foreground">{t("settings.piRpcStartup")}</span>
										<p className="mt-0.5 text-caption text-muted-foreground">{t("settings.piRpcStartupDesc")}</p>
									</div>
									<SettingSwitchRow
										title={t("settings.piRpcOffline")}
										description={t("settings.piRpcOfflineDesc")}
										checked={draftSettings.piRpcOffline}
										onChange={(checked) => updateDraft({ piRpcOffline: checked })}
									/>
									<SettingSwitchRow
										title={t("settings.piRpcNoExtensions")}
										description={t("settings.piRpcNoExtensionsDesc")}
										checked={draftSettings.piRpcNoExtensions}
										onChange={(checked) => updateDraft({ piRpcNoExtensions: checked })}
									/>
									<SettingSwitchRow
										title={t("settings.piRpcNoSkills")}
										description={t("settings.piRpcNoSkillsDesc")}
										checked={draftSettings.piRpcNoSkills}
										onChange={(checked) => updateDraft({ piRpcNoSkills: checked })}
									/>
								</SettingsSection>

								{/* Web 本地服务 */}
								<SettingsSection title={t("settings.webLocalService")} description={t("settings.webLocalServiceDesc")}>
									<SettingSwitchRow
										title={t("settings.enableWebService")}
										description={
											props.webServiceChanging
												? t("settings.webOpening")
												: t("settings.webOffDesc")
										}
										checked={draftSettings.webServiceEnabled}
										disabled={props.webServiceChanging}
										onChange={(checked) =>
											updateDraft({ webServiceEnabled: checked })
										}
									/>
									<div className="mt-2.5 grid gap-2.5">
										{/* Web 服务地址：主机（只读）+ 端口（可编辑）；shadcn Input + Label，
										    两列均分不再有主机列挤压/过宽问题，主机超长时 Input 内滚动 */}
										<div className="grid grid-cols-2 gap-2">
											<div className="min-w-0">
												<Label className="text-xs font-bold text-text-tertiary">{t("common.host")}</Label>
												<Input
													value={draftSettings.webServiceHost}
													readOnly
													className="mt-1 font-mono text-sm tabular-nums"
												/>
											</div>
											<div className="min-w-0">
												<Label className="text-xs font-bold text-text-tertiary">{t("common.port")}</Label>
												<Input
													type="number"
													min={1}
													max={65535}
													value={webPortDraft}
													disabled={props.webServiceChanging}
													className="mt-1 font-mono text-sm tabular-nums"
													onChange={(event) => setWebPortDraft(event.target.value)}
													onBlur={applyWebPortDraft}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															applyWebPortDraft();
															event.currentTarget.blur();
														}
													}}
												/>
											</div>
										</div>
										<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-border-subtle/70 bg-bg-muted/30 px-3 py-2.5">
											{/* 服务状态点：开启时 accent 色 + 光晕，关闭时灰 */}
											<span
												className={cn(
													"size-2 shrink-0 rounded-full",
													draftSettings.webServiceEnabled
														? "bg-[var(--color-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
														: "bg-text-tertiary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-text-tertiary)_12%,transparent)]",
												)}
											/>
											<div className="min-w-0">
												<strong className="block truncate text-caption font-semibold text-text-primary">
													http://127.0.0.1:{webPortDraft || draftSettings.webServicePort}
												</strong>
												<small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.localWebHint")}</small>
											</div>
											<Button variant="secondary"
												size="sm"
												disabled={!draftSettings.webServiceEnabled}
												onClick={() =>
													props.onOpenWebService(webPortDraft || String(draftSettings.webServicePort))
												}
											>
												{t("common.open")}
											</Button>
										</div>
										<div className="flex justify-end">
											<Button
												variant="outline"
												size="sm"
												disabled={!draftSettings.webServiceEnabled || props.webServiceChanging}
												onClick={props.onRestartWebService}
											>
												<RotateCw className="mr-1.5 size-3.5" aria-hidden="true" />
												{props.webServiceChanging ? t("settings.webRestarting") : t("settings.webRestartService")}
											</Button>
										</div>
										<div className="grid gap-2 rounded-lg border border-border-subtle/70 bg-bg-muted/20 p-3">
											<div className="flex items-center justify-between gap-2">
												<div className="min-w-0">
													<strong className="block text-caption font-semibold text-text-primary">{t("settings.webQrTitle")}</strong>
													<small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.webQrDesc")}</small>
												</div>
												{webNetworkLoading && <span className="text-micro text-text-tertiary">{t("settings.webNetworkLoading")}</span>}
											</div>
											{webNetworkAddresses.length > 0 ? (
												<div className="grid gap-1.5">
													<Label className="text-xs font-bold text-text-tertiary">{t("settings.webQrAddress")}</Label>
													<Select value={selectedWebAddress} onValueChange={setSelectedWebAddress}>
														<SelectTrigger className="font-mono text-sm tabular-nums">
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{webNetworkAddresses.map((item) => (
																<SelectItem key={item.address} value={item.address}>
																	<span className="font-mono">{item.address}</span>
																	<span className="ml-2 text-xs text-muted-foreground">{item.interfaceName}{item.cidr ? ` · /${item.cidr.split("/")[1]}` : ""}{item.isPrivate ? ` · ${t("settings.webLanAddress")}` : ""}</span>
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</div>
											) : (
												<p className="text-caption text-text-tertiary">{t("settings.webNoNetworkAddress")}</p>
											)}
											{webQrDataUrl ? (
												<div className="flex flex-wrap items-center gap-3 pt-1">
													<img src={webQrDataUrl} alt={t("settings.webQrAlt")} className="size-44 rounded-md bg-white p-2" />
													<div className="min-w-0 flex-1">
														<code className="block break-all text-caption text-text-primary">{webAccessUrl}</code>
														<small className="mt-1 block text-micro text-text-tertiary">{t("settings.webQrScanHint")}</small>
													</div>
												</div>
											) : (
												<p className="text-caption text-text-tertiary">{draftSettings.webServiceEnabled ? t("settings.webQrUnavailable") : t("settings.webQrEnableHint")}</p>
											)}
										</div>
										</div>
									</SettingsSection>

								{/* 外部编辑器（由 Pi 管理界面迁入） */}
								<SettingsSection
									title={
										<>
											<span>{t("settings.sectionEditors")}</span>
											<DirtyMarker dirty={isDirty("externalEditors")} label={t("settings.sectionEditors")} />
										</>
									}
								>
									<ExternalEditorsSection
										editors={draftSettings.externalEditors}
										onChange={updateDraft}
									/>
								</SettingsSection>

								{/* 调试 */}
								<SettingsSection title={t("settings.debug")}>
									<SettingRow
										title={<span>{t("settings.restartApp")}</span>}
										description={t("settings.restartAppDesc")}
									>
										<Button variant="secondary" onClick={props.onRestartApp}>
											{t("settings.restartAppButton")}
										</Button>
									</SettingRow>
									<SettingRow
										title={<span>{t("settings.devTools")}</span>}
										description={t("settings.devToolsDesc")}
									>
										<Button variant="secondary" onClick={props.onToggleDevTools}>
											{t("settings.toggle")}
										</Button>
									</SettingRow>
								</SettingsSection>

							</>
						</TabsContent>

						{/* ── 外部连接 tab（飞书机器人，由 Pi 管理界面迁入） ── */}
						<TabsContent value="im" className="settings-panel min-w-0">
							<ImTab />
						</TabsContent>
						{/* ── 桌面宠物 tab ── */}
																		<TabsContent value="pet" className="settings-panel min-w-0">
							<>
								<SettingsSection title={t("settings.pet.title")} description={t("settings.pet.sectionDesc")}>
									<SettingSwitchRow
										title={t("settings.pet.enable")}
										description={t("settings.pet.enableDesc")}
										checked={draftSettings.petEnabled}
										onChange={(value) => updateDraft({ petEnabled: value })}
									/>
									<SettingSwitchRow
										title={t("settings.pet.alwaysOnTop")}
										description={t("settings.pet.alwaysOnTopDesc")}
										checked={draftSettings.petAlwaysOnTop}
										onChange={(value) => updateDraft({ petAlwaysOnTop: value })}
									/>
									<SettingSwitchRow
										title={t("settings.pet.patrol")}
										description={t("settings.pet.patrolDesc")}
										checked={draftSettings.petPatrolEnabled ?? true}
										onChange={(value) => updateDraft({ petPatrolEnabled: value })}
									/>
									<SettingRow
										title={<span>{t("settings.pet.patrolPause")}</span>}
										description={t("settings.pet.patrolPauseDesc")}
									>
										<div className="flex w-full items-center gap-3">
											<input
												type="range"
												min="1"
												max="30"
												step="1"
												value={draftSettings.petPatrolPauseMin ?? 5}
												onChange={(event) => updateDraft({ petPatrolPauseMin: parseInt(event.target.value) })}
												className="min-w-0 flex-1 accent-[var(--color-accent)]"
												aria-label={t("settings.pet.patrolPause")}
											/>
											<span className="min-w-12 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">
												{draftSettings.petPatrolPauseMin ?? 5} min
											</span>
										</div>
									</SettingRow>
									<SettingRow
										title={<span>{t("settings.pet.scale")}</span>}
										description={t("settings.pet.scaleDesc")}
									>
										<div className="flex w-full items-center gap-3">
											<input
												type="range"
												min="0.3"
												max="2.0"
												step="0.05"
												value={draftSettings.petScale ?? 1}
												onChange={(event) => updateDraft({ petScale: parseFloat(event.target.value) })}
												className="min-w-0 flex-1 accent-[var(--color-accent)]"
												aria-label={t("settings.pet.scale")}
											/>
											<span className="min-w-12 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">
												{((draftSettings.petScale ?? 1) * 100).toFixed(0)}%
											</span>
										</div>
									</SettingRow>
								</SettingsSection>
								{/* 选择宠物（单行分区：行标题即一级标题，内容行入淡色框） */}
								<SettingBox>
								<SettingRow
									level={1}
									title={<span>{t("settings.pet.choose")}</span>}
									alignEnd={false}
								>
									<Select value={draftSettings.petId} onValueChange={(value) => {
										setPetPreviewMode("__auto");
										void window.piDesktop.pet.setPreviewMode("");
										updateDraft({ petId: value });
									}}>
										<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
										<SelectContent>
											{petOptions.map((option) => (
												<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
								<small className="setting-status">{t("settings.pet.petdexHint")}</small>
								{(() => {
									const selected = petList.find((pet) => pet.id === draftSettings.petId);
									return (
										<>
											{selected && (
												<div className="pet-chooser-preview-row" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: 8 }}>
													<PetChooserPreview pet={selected} mode={petPreviewMode} />
													<div style={{ minWidth: 0, flex: 1 }}>
														<strong style={{ display: "block", fontSize: "var(--font-size-control)", color: "var(--color-text-primary)" }}>{selected.displayName}</strong>
														{selected.description && (
															<small className="setting-status" style={{ display: "block", marginTop: 2 }}>{selected.description}</small>
														)}
													</div>
												</div>
											)}
										</>
									);
								})()}
								</SettingBox>
								<SettingsSection title={t("settings.pet.preview")} description={t("settings.pet.previewDesc")}>
									<SettingRow
										title={<span>{t("settings.pet.previewMode")}</span>}
										alignEnd={false}
									>
										<Select value={petPreviewMode} onValueChange={(value) => {
											setPetPreviewMode(value);
											void window.piDesktop.pet.setPreviewMode(value === "__auto" ? "" : value);
										}}>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{[
													{ value: "__auto", label: t("settings.pet.previewAuto") },
													{ value: "idle", label: "idle (row 0)" },
													{ value: "running", label: "running (row 7)" },
													{ value: "failed", label: "failed (row 5)" },
													{ value: "waiting", label: "waiting (row 6)" },
													{ value: "waving", label: "waving (row 3)" },
													{ value: "running-right", label: "running-right (row 1)" },
													{ value: "running-left", label: "running-left (row 2)" },
													{ value: "jumping", label: "jumping (row 4)" },
													{ value: "review", label: "review (row 8)" },
												].map((option) => (
													<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									<div className="flex justify-end gap-2 px-0.5 py-1.5">
										<Button
											size="sm"
											variant="destructive"
											onClick={() => void window.piDesktop.pet.testNotify("error")}
										>
											{t("settings.pet.testError")}
										</Button>
										<Button variant="secondary"
											size="sm"
											onClick={() => void window.piDesktop.pet.testNotify("done")}
										>
											{t("settings.pet.testDone")}
										</Button>
									</div>
								</SettingsSection>
							</>
						</TabsContent>


						{/* ── 进程监控 tab（由 Pi 管理界面迁入） ── */}
						<TabsContent value="process" className="settings-panel min-w-0">
							<ProcessMetricsTab />
						</TabsContent>
						{/* ── 存储与日志 tab ── */}
						<TabsContent value="storage" className="settings-panel min-w-0">
							<StorageTab
								settings={draftSettings}
								onChange={updateDraft}
							/>
						</TabsContent>
						{/* ── 用量统计 tab ── */}
						<TabsContent value="usage" className="settings-panel min-w-0">
							<UsageStatsTab />
						</TabsContent>
						{/* ── 视觉桥 tab：草稿/脏标记/保存由弹框统一管理，本组件只呈现表单 */}
						<TabsContent value="vision" className="settings-panel min-w-0">
							<VisionBridgeSettingsTab
								draft={visionDraft.draft}
								saving={visionDraft.saving}
								configDir={visionDraft.configDir}
								notice={visionDraft.notice}
								onChange={visionDraft.updateDraft}
							/>
						</TabsContent>
					</Tabs>
			{/* 未保存变更确认对话框 */}
			{closeConfirmOpen && (
				<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("settings.unsavedTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{t("settings.unsavedMessage")}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={handleDiscardAndClose}>
								{t("settings.discardChanges")}
							</AlertDialogAction>
							<AlertDialogAction onClick={handleSaveAndClose}>
								{t("settings.saveAndClose")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
			</DialogContent>
		</Dialog>
	);
}

function PetChooserPreview(props: {
	pet?: PetManifest;
	mode?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const pet = props.pet;
		if (!pet || !pet.spritesheetUrl || !canvas) {
			const ctx = canvas?.getContext("2d");
			if (canvas) ctx?.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}

		const mode = props.mode && props.mode !== "__auto" ? props.mode : "idle";
		const row = MODE_ROW[mode] ?? 0;
		const frameCount = MODE_FRAMES[mode] ?? 6;
		const img = new Image();
		img.src = pet.spritesheetUrl;
		let disposed = false;

		const start = () => {
			if (disposed) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			const startedAt = performance.now();
			const draw = (now: number) => {
				if (disposed) return;
				const frame = Math.floor((now - startedAt) / 140) % frameCount;
				ctx.clearRect(0, 0, CELL_W, CELL_H);
				ctx.drawImage(
					img,
					(frame % GRID_COLS) * CELL_W,
					row * CELL_H,
					CELL_W,
					CELL_H,
					0,
					0,
					CELL_W,
					CELL_H,
				);
				rafRef.current = requestAnimationFrame(draw);
			};
			rafRef.current = requestAnimationFrame(draw);
		};

		img.onload = start;
		imgRef.current = img;
		return () => {
			disposed = true;
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			imgRef.current = null;
		};
	}, [props.pet, props.mode]);

	return (
		<div className="pet-chooser-preview">
			<canvas ref={canvasRef} width={CELL_W} height={CELL_H} aria-hidden="true" />
		</div>
	);
}
