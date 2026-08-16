import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, Terminal, Wrench } from "lucide-react";
import {
	contextControllerSettingsAtom,
	sessionRuntimeBySessionIdAtomFamily,
	sessionRuntimeUiBySessionIdAtomFamily,
	sessionSendStateByIdAtom,
} from "../../atoms";
import { isUserFacingSessionStart } from "../../hooks/useSessionTimelineController";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Switch } from "../ui-shadcn/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

export type ContextSwitchState = {
	toolHistory: boolean;
	fileContent: boolean;
	commandOutput: boolean;
};

const DEFAULT_SWITCH_STATE: ContextSwitchState = {
	toolHistory: true,
	fileContent: true,
	commandOutput: true,
};

/**
 * 从 CTX widget 文本行解析当前开/关状态。
 * 行契约：
 *   "Tool history ON" | "Tool history OFF"
 *   "File content ON" | "File content OFF"
 *   "Command output ON" | "Command output OFF"
 */
export function parseSwitchStateFromWidgetLines(lines?: readonly string[]): ContextSwitchState | null {
	if (!lines || lines.length === 0) return null;
	let toolHistory: boolean | null = null;
	let fileContent: boolean | null = null;
	let commandOutput: boolean | null = null;

	for (const line of lines) {
		const trimmed = line.trim().toUpperCase();
		if (trimmed === "TOOL HISTORY ON") toolHistory = true;
		else if (trimmed === "TOOL HISTORY OFF") toolHistory = false;
		else if (trimmed === "FILE CONTENT ON") fileContent = true;
		else if (trimmed === "FILE CONTENT OFF") fileContent = false;
		else if (trimmed === "COMMAND OUTPUT ON") commandOutput = true;
		else if (trimmed === "COMMAND OUTPUT OFF") commandOutput = false;
	}

	if (toolHistory != null && fileContent != null && commandOutput != null) {
		return { toolHistory, fileContent, commandOutput };
	}
	return null;
}

/**
 * 从 CTX widget 文本行解析当前估算的节省量。
 * 行契约：
 *   "Saved ~10k (83%)"
 */
export function parseSavedEstimateFromWidgetLines(lines?: readonly string[]): string | null {
	if (!lines || lines.length === 0) return null;
	for (const line of lines) {
		const match = line.trim().match(/^Saved\s+(.+)$/i);
		if (match && match[1]) {
			return match[1].trim();
		}
	}
	return null;
}

/** 与插件 applyIncludeSwitch 同一张联动表：关总闸三项全关；开文件/命令则打开总闸。 */
export function applyLocalSwitch(
	state: ContextSwitchState,
	key: keyof ContextSwitchState,
	include: boolean,
): ContextSwitchState {
	if (key === "toolHistory") {
		return include
			? { ...state, toolHistory: true }
			: { toolHistory: false, fileContent: false, commandOutput: false };
	}
	if (include) {
		return { ...state, [key]: true, toolHistory: true };
	}
	return { ...state, [key]: false };
}

function commandForKey(key: keyof ContextSwitchState, include: boolean): string {
	const flag = include ? "on" : "off";
	if (key === "toolHistory") return `/context-tools ${flag}`;
	if (key === "fileContent") return `/context-files ${flag}`;
	return `/context-commands ${flag}`;
}

function tooltipKeyFor(key: keyof ContextSwitchState): "ctx.switches.allToolsTooltip" | "ctx.switches.fileContentTooltip" | "ctx.switches.commandOutputTooltip" {
	if (key === "toolHistory") return "ctx.switches.allToolsTooltip";
	if (key === "fileContent") return "ctx.switches.fileContentTooltip";
	return "ctx.switches.commandOutputTooltip";
}

function ContextSwitchRow(props: {
	icon: ReactNode;
	label: string;
	tooltip: string;
	checked: boolean;
	disabled: boolean;
	disabledReason?: string;
	savedEstimate: string | null;
	onToggle: (next: boolean) => void;
}) {
	const rowClass = `flex items-center gap-1 text-xs text-muted-foreground select-none ${
		props.disabled ? "cursor-not-allowed" : "cursor-pointer"
	}`;
	const labelClass = `flex items-center gap-1 ${props.disabled ? "opacity-50" : ""}`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					onClick={() => {
						if (!props.disabled) props.onToggle(!props.checked);
					}}
					className={rowClass}
				>
					<span className={labelClass}>
						{props.icon}
						<span className="text-caption font-medium">{props.label}</span>
					</span>
					<Switch
						size="sm"
						disabled={props.disabled}
						checked={props.checked}
						onCheckedChange={props.onToggle}
						onClick={(e) => e.stopPropagation()}
						aria-label={props.tooltip}
					/>
				</div>
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" className="max-w-72">
				{props.disabledReason ? (
					props.disabledReason
				) : (
					<div className="grid gap-1">
						<div>{props.tooltip}</div>
						{!props.checked && (
							<div className="border-t border-border/60 pt-1 text-muted-foreground text-micro">
								{props.savedEstimate ? (
									<div className="font-semibold text-primary">
										{t("ctx.switches.savedEstimate", { saved: props.savedEstimate })}
									</div>
								) : null}
								<div>{t("ctx.switches.nextTurnNote")}</div>
							</div>
						)}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * 会话头部右上角的上下文控制器开关组。
 * 挂载在官方上下文统计（SessionStatus）的左侧。
 */
export function ContextControllerSwitches(props: { sessionId: string }) {
	const { sessionId } = props;
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId));
	const extSettings = useAtomValue(contextControllerSettingsAtom);

	const sendStateSelector = useMemo(
		() => selectAtom(
			sessionSendStateByIdAtom,
			(states) => states[sessionId],
			Object.is,
		),
		[sessionId],
	);
	const sendState = useAtomValue(sendStateSelector);

	const isPluginDisabled =
		extSettings.piRpcNoExtensions ||
		extSettings.removedBuiltInExtensions.includes("pi-deck-context-controller.ts");

	const isBusy = runtime?.status === "running" || isUserFacingSessionStart(sendState?.status);

	const widgetLines = runtimeUi?.widgets?.["pi-deck-context-controller"];
	const widgetState = useMemo(() => parseSwitchStateFromWidgetLines(widgetLines), [widgetLines]);
	const savedEstimate = useMemo(() => parseSavedEstimateFromWidgetLines(widgetLines), [widgetLines]);

	const [persistedState, setPersistedState] = useState<ContextSwitchState>(DEFAULT_SWITCH_STATE);
	const [pendingState, setPendingState] = useState<ContextSwitchState | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!sessionId) return;
		setPersistedState(DEFAULT_SWITCH_STATE);
		setPendingState(null);

		void desktopApi.sessions.getContextControllerState(sessionId)
			.then((res) => {
				if (cancelled || !res) return;
				setPersistedState({
					toolHistory: !res.clearToolHistory,
					fileContent: !res.clearReadContent,
					commandOutput: !res.clearCommandContent,
				});
			})
			.catch(() => {
				// 历史读取失败时保守保持默认值
			});

		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	useEffect(() => {
		if (!pendingState || !widgetState) return;
		if (
			widgetState.toolHistory === pendingState.toolHistory &&
			widgetState.fileContent === pendingState.fileContent &&
			widgetState.commandOutput === pendingState.commandOutput
		) {
			setPendingState(null);
		}
	}, [pendingState, widgetState]);

	const currentState = pendingState ?? widgetState ?? persistedState;

	const sendSilentCommand = useCallback(async (
		key: keyof ContextSwitchState,
		include: boolean,
	) => {
		if (isBusy || isPluginDisabled || !sessionId) return;
		const prev = currentState;
		const next = applyLocalSwitch(prev, key, include);
		setPendingState(next);
		setPersistedState(next);

		try {
			const result = await desktopApi.sessions.sendPrompt({
				sessionId,
				requestId: crypto.randomUUID(),
				message: "",
				agentMessage: commandForKey(key, include),
				silent: true,
			});
			if (!result.accepted) {
				setPendingState(null);
				setPersistedState(prev);
				showNotice(result.error || t(tooltipKeyFor(key)), 3000, "error");
			}
		} catch (error) {
			setPendingState(null);
			setPersistedState(prev);
			const message = error instanceof Error ? error.message : String(error);
			showNotice(message, 3000, "error");
		}
	}, [currentState, isBusy, isPluginDisabled, sessionId]);

	const disabled = isPluginDisabled || isBusy;
	const disabledReason = isPluginDisabled
		? t("ctx.switches.pluginDisabled")
		: isBusy
			? t("ctx.switches.busyDisabled")
			: undefined;

	return (
		<div className="flex shrink-0 items-center gap-2 pr-1">
			<ContextSwitchRow
				icon={<Wrench size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
				label={t("ctx.switches.allTools")}
				tooltip={t("ctx.switches.allToolsTooltip")}
				checked={currentState.toolHistory}
				disabled={disabled}
				disabledReason={disabledReason}
				savedEstimate={savedEstimate}
				onToggle={(next) => void sendSilentCommand("toolHistory", next)}
			/>
			<ContextSwitchRow
				icon={<FileText size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
				label={t("ctx.switches.fileContent")}
				tooltip={t("ctx.switches.fileContentTooltip")}
				checked={currentState.fileContent}
				disabled={disabled}
				disabledReason={disabledReason}
				savedEstimate={savedEstimate}
				onToggle={(next) => void sendSilentCommand("fileContent", next)}
			/>
			<ContextSwitchRow
				icon={<Terminal size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
				label={t("ctx.switches.commandOutput")}
				tooltip={t("ctx.switches.commandOutputTooltip")}
				checked={currentState.commandOutput}
				disabled={disabled}
				disabledReason={disabledReason}
				savedEstimate={savedEstimate}
				onToggle={(next) => void sendSilentCommand("commandOutput", next)}
			/>
		</div>
	);
}
