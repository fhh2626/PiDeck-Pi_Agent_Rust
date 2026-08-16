import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Terminal, Wrench } from "lucide-react";
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
	toolContent: boolean;
	toolHistory: boolean;
};

const DEFAULT_SWITCH_STATE: ContextSwitchState = {
	toolContent: true,
	toolHistory: true,
};

/**
 * 从 CTX widget 文本行解析当前开/关状态。
 * 行契约：
 *   "Tool content ON" | "Tool content OFF"
 *   "Tool history ON" | "Tool history OFF"
 */
export function parseSwitchStateFromWidgetLines(lines?: readonly string[]): ContextSwitchState | null {
	if (!lines || lines.length === 0) return null;
	let toolContent: boolean | null = null;
	let toolHistory: boolean | null = null;

	for (const line of lines) {
		const trimmed = line.trim().toUpperCase();
		if (trimmed === "TOOL CONTENT ON") toolContent = true;
		else if (trimmed === "TOOL CONTENT OFF") toolContent = false;
		else if (trimmed === "TOOL HISTORY ON") toolHistory = true;
		else if (trimmed === "TOOL HISTORY OFF") toolHistory = false;
	}

	if (toolContent != null && toolHistory != null) {
		return { toolContent, toolHistory };
	}
	return null;
}

/**
 * 会话头部右上角的上下文控制器开关组。
 * 挂载在官方上下文统计（SessionStatus）的左侧。
 *
 * 交互契约：
 * 1. 默认双 ON（新会话全部保留进上下文）。
 * 2. 历史会话：进入时优先读实时 widget；未启动时从会话 JSONL 解析上次 customEntry 快照。
 * 3. 拨动开关时静默下发 `/context-tools on|off` 或 `/context-tool-content on|off`（不向时间线添加气泡）。
 * 4. 互锁规则：关 history 则 content 联动关；开 content 则 history 联动开。
 * 5. 忙碌/生成中：禁用并提示「生成中不可改上下文」。
 * 6. 插件未启用：设置中关扩展或移除内置插件时禁用并提示「上下文控制器未启用」。
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

	// 插件可用性判断：设置层全局禁用或内置列表移除本插件
	const isPluginDisabled =
		extSettings.piRpcNoExtensions ||
		extSettings.removedBuiltInExtensions.includes("pi-deck-context-controller.ts");

	// 忙碌状态检测：运行中或用户正在启动发送时不可改上下文（Rust 协议限制）
	const isBusy = runtime?.status === "running" || isUserFacingSessionStart(sendState?.status);

	const widgetLines = runtimeUi?.widgets?.["pi-deck-context-controller"];
	const widgetState = useMemo(() => parseSwitchStateFromWidgetLines(widgetLines), [widgetLines]);

	// 本地乐观状态（未收到 widget 事件时回退历史 IPC 查询结果或默认值）
	const [persistedState, setPersistedState] = useState<ContextSwitchState>(DEFAULT_SWITCH_STATE);
	// 拨动后短暂覆盖旧 widget，避免「先翻回去再等插件刷新」的闪烁。
	const [pendingState, setPendingState] = useState<ContextSwitchState | null>(null);

	// 会话切换时异步预拉取历史快照
	useEffect(() => {
		let cancelled = false;
		if (!sessionId) return;
		setPersistedState(DEFAULT_SWITCH_STATE);
		setPendingState(null);

		void desktopApi.sessions.getContextControllerState(sessionId)
			.then((res) => {
				if (cancelled || !res) return;
				setPersistedState({
					toolContent: !res.clearToolContent,
					toolHistory: !res.clearToolHistory,
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
			widgetState.toolContent === pendingState.toolContent &&
			widgetState.toolHistory === pendingState.toolHistory
		) {
			setPendingState(null);
		}
	}, [pendingState, widgetState]);

	// 权威状态：进行中的乐观更新 > 实时 widget > 历史快照
	const currentState = pendingState ?? widgetState ?? persistedState;

	const handleToggleHistory = useCallback(async (nextHistory: boolean) => {
		if (isBusy || isPluginDisabled || !sessionId) return;
		const prev = currentState;
		const next = { toolHistory: nextHistory, toolContent: nextHistory ? prev.toolContent : false };
		setPendingState(next);
		setPersistedState(next);

		try {
			const command = `/context-tools ${nextHistory ? "on" : "off"}`;
			const result = await desktopApi.sessions.sendPrompt({
				sessionId,
				requestId: crypto.randomUUID(),
				message: "",
				agentMessage: command,
				silent: true,
			});
			if (!result.accepted) {
				setPendingState(null);
				setPersistedState(prev);
				showNotice(result.error || t("ctx.switches.allToolsTooltip"), 3000, "error");
			}
		} catch (error) {
			setPendingState(null);
			setPersistedState(prev);
			const message = error instanceof Error ? error.message : String(error);
			showNotice(message, 3000, "error");
		}
	}, [currentState, isBusy, isPluginDisabled, sessionId]);

	const handleToggleContent = useCallback(async (nextContent: boolean) => {
		if (isBusy || isPluginDisabled || !sessionId) return;
		const prev = currentState;
		const next = { toolHistory: nextContent ? true : prev.toolHistory, toolContent: nextContent };
		setPendingState(next);
		setPersistedState(next);

		try {
			const command = `/context-tool-content ${nextContent ? "on" : "off"}`;
			const result = await desktopApi.sessions.sendPrompt({
				sessionId,
				requestId: crypto.randomUUID(),
				message: "",
				agentMessage: command,
				silent: true,
			});
			if (!result.accepted) {
				setPendingState(null);
				setPersistedState(prev);
				showNotice(result.error || t("ctx.switches.toolOutputTooltip"), 3000, "error");
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
			{/* 开关 1：全部工具 */}
			<Tooltip>
				<TooltipTrigger asChild>
					<label
						className={`flex items-center gap-1 text-xs text-muted-foreground select-none ${
							disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
						}`}
					>
						<Wrench size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="text-caption font-medium">{t("ctx.switches.allTools")}</span>
						<Switch
							size="sm"
							disabled={disabled}
							checked={currentState.toolHistory}
							onCheckedChange={handleToggleHistory}
							aria-label={t("ctx.switches.allToolsTooltip")}
						/>
					</label>
				</TooltipTrigger>
				<TooltipContent side="bottom" align="end">
					{disabledReason ?? t("ctx.switches.allToolsTooltip")}
				</TooltipContent>
			</Tooltip>

			{/* 开关 2：工具输出 */}
			<Tooltip>
				<TooltipTrigger asChild>
					<label
						className={`flex items-center gap-1 text-xs text-muted-foreground select-none ${
							disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
						}`}
					>
						<Terminal size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="text-caption font-medium">{t("ctx.switches.toolOutput")}</span>
						<Switch
							size="sm"
							disabled={disabled}
							checked={currentState.toolContent}
							onCheckedChange={handleToggleContent}
							aria-label={t("ctx.switches.toolOutputTooltip")}
						/>
					</label>
				</TooltipTrigger>
				<TooltipContent side="bottom" align="end">
					{disabledReason ?? t("ctx.switches.toolOutputTooltip")}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
