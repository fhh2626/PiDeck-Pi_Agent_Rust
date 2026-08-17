/**
 * Web 顶栏上下文控制：三个 Checkbox，规则与桌面三开关相同。
 * 状态以会话 JSONL 快照为准；乐观更新期间不让轮询盖掉本地选择。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { Checkbox } from "@/components/ui-shadcn/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui-shadcn/tooltip";
import {
	applyLocalSwitch,
	type ContextSwitchState,
} from "../components/session/ContextControllerSwitches";
import { fetchContextControllerState, sendContextControllerCommand } from "./webApi";
import type { WebHeaderStatus } from "./WebHeader";

const DEFAULT_SWITCH_STATE: ContextSwitchState = {
	toolHistory: true,
	fileContent: true,
	commandOutput: true,
};

const POLL_MS = 4000;

function commandForKey(key: keyof ContextSwitchState, include: boolean): string {
	const flag = include ? "on" : "off";
	if (key === "toolHistory") return `/context-tools ${flag}`;
	if (key === "fileContent") return `/context-files ${flag}`;
	return `/context-commands ${flag}`;
}

function toSwitchState(res: {
	clearToolHistory: boolean;
	clearReadContent: boolean;
	clearCommandContent: boolean;
}): ContextSwitchState {
	return {
		toolHistory: !res.clearToolHistory,
		fileContent: !res.clearReadContent,
		commandOutput: !res.clearCommandContent,
	};
}

export function WebContextChecks(props: {
	sessionId: string;
	status: WebHeaderStatus;
}) {
	const { sessionId, status } = props;
	const [state, setState] = useState<ContextSwitchState>(DEFAULT_SWITCH_STATE);
	const [error, setError] = useState<string | null>(null);
	const pendingRef = useRef(false);
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;

	const busy = status === "running" || status === "starting";
	const disabled = !sessionId || busy;

	const loadState = useCallback(async (id: string) => {
		if (!id || pendingRef.current) return;
		try {
			const snapshot = await fetchContextControllerState(id);
			if (sessionIdRef.current !== id || pendingRef.current) return;
			setState(toSwitchState(snapshot));
		} catch {
			// 读失败保持当前本地态，避免把用户刚拨的开关弹回去
		}
	}, []);

	useEffect(() => {
		pendingRef.current = false;
		setError(null);
		if (!sessionId) {
			setState(DEFAULT_SWITCH_STATE);
			return;
		}
		setState(DEFAULT_SWITCH_STATE);
		void loadState(sessionId);
	}, [sessionId, loadState]);

	// 桌面端改开关后，Web 靠 JSONL 轮询跟上；本地乐观更新期间跳过，防止闪回。
	useEffect(() => {
		if (!sessionId) return;
		const timer = window.setInterval(() => {
			void loadState(sessionId);
		}, POLL_MS);
		return () => window.clearInterval(timer);
	}, [sessionId, loadState]);

	const toggle = useCallback(async (key: keyof ContextSwitchState, include: boolean) => {
		if (disabled || !sessionId) return;
		const prev = state;
		const next = applyLocalSwitch(prev, key, include);
		setState(next);
		setError(null);
		pendingRef.current = true;
		try {
			const result = await sendContextControllerCommand(sessionId, commandForKey(key, include));
			if (sessionIdRef.current !== sessionId) return;
			if (!result.accepted) {
				setState(prev);
				setError(result.error || t("ctx.switches.pluginDisabled"));
			}
		} catch (cause) {
			if (sessionIdRef.current !== sessionId) return;
			setState(prev);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (sessionIdRef.current === sessionId) pendingRef.current = false;
		}
	}, [disabled, sessionId, state]);

	const disabledReason = !sessionId
		? t("web.chooseSession")
		: busy
			? t("ctx.switches.busyDisabled")
			: undefined;

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			<ContextCheck
				label={t("ctx.switches.webAllTools")}
				tooltip={t("ctx.switches.allToolsTooltip")}
				checked={state.toolHistory}
				disabled={disabled}
				disabledReason={disabledReason}
				onToggle={(next) => void toggle("toolHistory", next)}
			/>
			<ContextCheck
				label={t("ctx.switches.webFileContent")}
				tooltip={t("ctx.switches.fileContentTooltip")}
				checked={state.fileContent}
				disabled={disabled}
				disabledReason={disabledReason}
				onToggle={(next) => void toggle("fileContent", next)}
			/>
			<ContextCheck
				label={t("ctx.switches.webCommandOutput")}
				tooltip={t("ctx.switches.commandOutputTooltip")}
				checked={state.commandOutput}
				disabled={disabled}
				disabledReason={disabledReason}
				onToggle={(next) => void toggle("commandOutput", next)}
			/>
			{error ? (
				<span className="max-w-40 truncate text-micro text-destructive" title={error}>
					{error}
				</span>
			) : null}
		</div>
	);
}

function ContextCheck(props: {
	label: string;
	tooltip: string;
	checked: boolean;
	disabled: boolean;
	disabledReason?: string;
	onToggle: (next: boolean) => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					className={`flex items-center gap-1 text-caption text-muted-foreground select-none ${
						props.disabled ? "cursor-not-allowed" : "cursor-pointer"
					}`}
					onClick={() => {
						if (!props.disabled) props.onToggle(!props.checked);
					}}
				>
					<Checkbox
						checked={props.checked}
						disabled={props.disabled}
						onCheckedChange={(value) => {
							if (props.disabled) return;
							props.onToggle(value === true);
						}}
						onClick={(event) => event.stopPropagation()}
						className="size-3.5 min-w-3.5"
						aria-label={props.tooltip}
					/>
					<span className={props.disabled ? "opacity-50" : undefined}>{props.label}</span>
				</div>
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" className="max-w-72">
				{props.disabledReason ?? (
					<div className="grid gap-1">
						<div>{props.tooltip}</div>
						{!props.checked && (
							<div className="border-t border-border/60 pt-1 text-micro text-muted-foreground">
								{t("ctx.switches.nextTurnNote")}
							</div>
						)}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}
