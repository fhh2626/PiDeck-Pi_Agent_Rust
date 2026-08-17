import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FoldVertical } from "lucide-react";
import { t } from "../../i18n";
import type { AgentRuntimeState } from "../../../../shared/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { buildSessionStatusDetail } from "./SurfaceComponents";

/**
 * composer 发送按钮旁的上下文占用圆环（移植自 dsh-web ContextMeter）。
 *
 * 形态：14px 圆环（2px 描边，strokeDasharray 按占用比例填充，从 12 点方向起笔），
 * 28px 圆形点击区；点击弹出占用面板：
 * - 标题「上下文已用 45%」+ ~used/window 数字 + 4px 占用条；
 * - 两段占比图例「对话 / 系统 + 工具」：pi 不返回 prompt 构成，对话按会话文件
 *   消息字符 ÷ 4 估算（contextMessageTokens，主进程算好），系统+工具为反推值
 *   （contextTokens − 对话），缺估算数据时退化单段条（dsh 自身 breakdown 也是
 *   heuristic，缺失时回退成单段 total）；
 * - 完整会话详情：复用会话头部 SessionStatus 的明细构建器（buildSessionStatusDetail），
 *   包含上下文/输入输出/缓存读写/命中率/费用，以及「最近一次回复」的性能组
 *   （TTFT 首字、总耗时、tps）——圆环面板与会话头部共用同一份明细，语义一致；
 * - 压缩上下文按钮：从原右上角紧凑徽章移入面板，保留 urgency 色阶
 *   （≥90 红 / ≥70 黄），压缩中禁用并显示进度态。
 *
 * 边界：
 * - percent 或 window 缺失时不渲染（模型切换瞬间可能短暂无 capacity，此时也关闭
 *   已打开的面板，不保留过期 UI）。
 * - 命中率/输入输出行按数据存在性渲染，缺字段不占位。
 */

/** 圆环几何：14px viewBox、2px 描边（dsh 逐字节移植）。 */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 两段图例色：对话=蓝、系统+工具=紫（dsh ROWS 的 messages/tools 色系）。 */
const COLOR_CONVERSATION = "var(--color-context-conversation, #2563eb)";
const COLOR_SYSTEM_TOOLS = "var(--color-context-system-tools, rgb(167, 139, 250))";

/** token 数紧凑格式化（dsh StatsLine 同款）：<1K 原样，<1M 用 K，之后用 M；
 *  ≥100 取整，其余保留一位小数。 */
export function formatTokens(n: number): string {
	const scaled = (v: number): string =>
		v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
	return `${scaled(n / 1_000_000)}M`;
}

/** 由 runtime 状态计算占用（dsh contextOccupancy 同款语义）：
 *  缺任一字段视为无 capacity（null），percent 封顶 100。 */
export function contextOccupancy(
	state: Pick<AgentRuntimeState, "contextPercent" | "contextTokens" | "contextWindow"> | undefined,
): { percent: number; usedTokens?: number; contextWindow?: number } | null {
	const usedTokens = state?.contextTokens ?? undefined;
	const contextWindow = state?.contextWindow ?? undefined;
	if (state?.contextPercent == null || contextWindow == null) return null;
	return {
		percent: Math.min(100, Math.round(state.contextPercent)),
		usedTokens,
		contextWindow,
	};
}

/** 两段占比：对话 = 消息估算 token（封顶 contextTokens），系统+工具为反推余量。
 *  返回 null 表示无估算数据（渲染单段条）。 */
export function contextSegments(state: Pick<AgentRuntimeState, "contextTokens" | "contextMessageTokens"> | undefined):
	| { conversation: number; systemTools: number }
	| null {
	const total = state?.contextTokens;
	const messageTokens = state?.contextMessageTokens;
	if (total == null || total <= 0 || messageTokens == null || messageTokens <= 0) return null;
	const conversation = Math.min(messageTokens, total);
	return { conversation, systemTools: Math.max(0, total - conversation) };
}

export function SessionContextMeter(props: {
	state?: Pick<
		AgentRuntimeState,
		| "contextPercent" | "contextTokens" | "contextWindow"
		| "contextMessageTokens"
		| "cacheHitPercent" | "cacheHitAveragePercent" | "cacheHitSampleCount"
		| "inputTokens" | "outputTokens" | "isCompacting"
		| "cost" | "ttftMs" | "totalMs" | "tps"
		| "cacheRead" | "cacheWrite" | "cacheTotal"
	>;
	/** 压缩上下文（原右上角紧凑徽章动作，迁入面板底部） */
	onCompact?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement | null>(null);
	/** 面板 fixed 定位：相对 viewport 的 {left, top}；null = 尚未定位（首帧隐藏） */
	const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const context = contextOccupancy(props.state);
	const available = context !== null;
	const segments = contextSegments(props.state);
	const compacting = props.state?.isCompacting === true;
	// 完整详情复用会话头部 SessionStatus 的构建器：平均命中率以主进程
	// 文件统计为准（缓存快照历史均值仅作降级，头部同款语义）
	const detail = buildSessionStatusDetail(
		props.state,
		props.state?.cacheHitAveragePercent ?? undefined,
		props.state?.cacheHitSampleCount ?? 0,
	);

	// 模型切换瞬间 capacity 可能暂时消失：不渲染过期面板
	useEffect(() => {
		if (!available && open) setOpen(false);
	}, [available, open]);

	// 面板定位：fixed 相对 viewport（portal 到 body，脱离 composer 的 overflow 裁剪）。
	// 向上弹出（面板底边贴 trigger 顶），顶部空间不足时翻转到 trigger 下方；
	// 面板内容高度随数据变化，每次打开/内容变化都重新测量（首帧 hidden 定位）。
	// 抽成 useCallback 供打开/数据变化（layout effect）与滚动/resize（scroll 监听）
	// 两条路径复用——滚动时保持面板贴 trigger 而不是关闭。
	const positionPanel = useCallback(() => {
		const trigger = triggerRef.current;
		const panel = panelRef.current;
		if (!trigger || !panel) return;
		const rect = trigger.getBoundingClientRect();
		const panelWidth = panel.offsetWidth || 264;
		const panelHeight = panel.offsetHeight;
		const left = Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8));
		let top = rect.top - 8 - panelHeight;
		if (top < 8) top = rect.bottom + 8; // 上方放不下：翻转到 trigger 下方
		// 位置未变不重复 setState：流式渲染追底滚动期间每帧都有 scroll 事件，
		// trigger 固定在底部栏（不随消息滚动），位置不变时避免每帧 re-render
		setPlacement((prev) =>
			prev !== null && prev.left === left && prev.top === top ? prev : { left, top },
		);
	}, []);

	useLayoutEffect(() => {
		if (!open || !available) return;
		positionPanel();
		// 依赖只用原始值（对象引用每次渲染都变，会导致定位循环）：
		// 数据更新（占用/费用/压缩态变化）或尺寸变化时重新测量定位
	}, [open, available, context?.percent, context?.usedTokens, context?.contextWindow, props.state?.cost, props.state?.cacheHitPercent, props.state?.cacheHitAveragePercent, props.state?.isCompacting, positionPanel]);

	// 外点 / Escape 关闭（open 期间挂一个 document 监听，dsh Menu 同款模式）
	useEffect(() => {
		if (!open || !available) return;
		const onPointerDown = (e: PointerEvent): void => {
			const inside =
				e.target instanceof Node &&
				(rootRef.current?.contains(e.target) === true ||
					panelRef.current?.contains(e.target) === true);
			if (inside) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [available, open]);

	// fixed 面板本身不随滚动移动，滚动/resize 会导致 trigger 相对 viewport 变化：
	// 重新锚定面板到 trigger 当前位置而不是关闭——流式渲染追底滚动（弹簧/instant
	// 跳转）期间面板保持打开且贴 trigger，不再「点开就关」（2026-08 用户反馈）。
	// 外点 / Escape 仍是关闭面板的唯一途径。
	useEffect(() => {
		if (!open || !available) return;
		let raf = 0;
		const reanchor = (): void => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(positionPanel);
		};
		window.addEventListener("scroll", reanchor, true);
		window.addEventListener("resize", reanchor);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", reanchor, true);
			window.removeEventListener("resize", reanchor);
		};
	}, [open, available, positionPanel]);

	if (context === null) return null;
	const percent = context.percent;
	const reading = t("sessionContext.used", { percent });
	const figures = [context.usedTokens, context.contextWindow].every((v) => v != null)
		? `~${formatTokens(context.usedTokens!)} / ${formatTokens(context.contextWindow!)}`
		: undefined;
	const showCompact = props.onCompact !== undefined;
	// 与旧右上角紧凑徽章一致的 urgency 色阶：≥90 红（危险）/ ≥70 黄（警告）/ 其余默认
	const compactUrgency =
		percent >= 90 ? "text-destructive border-destructive/40 hover:bg-destructive/10" :
		percent >= 70 ? "text-amber-500 border-amber-500/40 hover:bg-amber-500/10" :
		"border-border hover:bg-muted/60";

	return (
		<span ref={rootRef} className="relative inline-flex" data-testid="session-context-meter">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						ref={triggerRef}
						type="button"
						className="grid size-7 flex-none place-items-center rounded-full text-text-tertiary transition-colors hover:bg-muted/60"
						aria-label={reading}
						aria-haspopup="dialog"
						aria-expanded={open}
						onClick={() => { setOpen((value) => !value); }}
					>
						<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
							<circle
								className="fill-none stroke-[var(--color-border)]"
								cx="7" cy="7" r={RADIUS} strokeWidth={2}
							/>
							<circle
								className="fill-none stroke-[var(--color-text-tertiary)] [stroke-linecap:round]"
								cx="7" cy="7" r={RADIUS} strokeWidth={2}
								strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
								transform="rotate(-90 7 7)"
							/>
						</svg>
					</button>
				</TooltipTrigger>
				<TooltipContent>{reading}</TooltipContent>
			</Tooltip>
			{open &&
				createPortal(
					<div
						ref={panelRef}
						role="dialog"
						aria-label={reading}
						className="fixed z-[100] w-[264px] cursor-default rounded-xl border border-border bg-popover p-3 text-xs leading-5 text-text-secondary shadow-lg"
						style={{
							left: placement?.left,
							top: placement?.top,
							visibility: placement === null ? "hidden" : "visible",
						}}
					>
					<div className="flex items-center gap-1.5">
						<span className="text-text-tertiary">{t("sessionContext.used", { percent })}</span>
						{figures !== undefined && (
							<span className="ml-auto font-medium tabular-nums text-foreground">
								{figures}
							</span>
						)}
					</div>
					<div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
						{segments === null ? (
							// 无估算数据：单段总占用条（dsh breakdown 缺失时的退化路径）
							<div
								className="h-full rounded-full bg-text-tertiary"
								style={{ width: `${percent}%` }}
							/>
						) : (
							// 两段：对话（蓝）在前、系统+工具（紫）在后，宽度按占 contextTokens 比例
							<div className="flex h-full overflow-hidden rounded-full">
								<div
									className="h-full"
									style={{
										width: `${Math.min(100, (segments.conversation / context.contextWindow!) * 100)}%`,
										backgroundColor: COLOR_CONVERSATION,
									}}
								/>
								<div
									className="h-full"
									style={{
										width: `${Math.min(100, (segments.systemTools / context.contextWindow!) * 100)}%`,
										backgroundColor: COLOR_SYSTEM_TOOLS,
									}}
								/>
							</div>
						)}
					</div>
					{segments !== null && (
						<div className="mt-2 space-y-0.5">
							<div className="flex items-center gap-1.5">
								<span
									className="size-2 flex-none rounded-[2px]"
									style={{ backgroundColor: COLOR_CONVERSATION }}
								/>
								<span>{t("sessionContext.conversation")}</span>
								<span className="ml-auto tabular-nums text-text-tertiary">
									~{formatTokens(segments.conversation)}
								</span>
							</div>
							<div className="flex items-center gap-1.5">
								<span
									className="size-2 flex-none rounded-[2px]"
									style={{ backgroundColor: COLOR_SYSTEM_TOOLS }}
								/>
								<span>{t("sessionContext.systemTools")}</span>
								<span className="ml-auto tabular-nums text-text-tertiary">
									~{formatTokens(segments.systemTools)}
								</span>
							</div>
						</div>
					)}
					{(detail.detailRows.length > 0 || detail.replyPerfRows.length > 0) && (
						<div className="mt-2 space-y-0.5 border-t border-border pt-2">
							{detail.detailRows.map((row) => (
								<div
									key={row.label}
									className={`flex items-baseline justify-between gap-4 px-0.5 py-0.5 text-caption leading-5${row.emphasis ? " mt-1 border-t border-border/70 pt-1.5" : ""}`}
								>
									<span className="shrink-0 text-text-secondary">{row.label}</span>
									<span className="min-w-0 text-right font-mono font-semibold tabular-nums text-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
					{detail.replyPerfRows.length > 0 && (
						<div className="mt-2.5 space-y-0.5 border-t border-border pt-2">
							<div className="px-0.5 text-micro font-semibold uppercase tracking-wide text-text-tertiary">
								{t("ctx.detail.lastReply")}
							</div>
							{detail.replyPerfRows.map((row) => (
								<div
									key={row.label}
									className="flex items-baseline justify-between gap-4 px-0.5 py-0.5 text-caption leading-5"
								>
									<span className="shrink-0 text-text-secondary">{row.label}</span>
									<span className="min-w-0 text-right font-mono font-semibold tabular-nums text-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
					{showCompact && (
						<button
							type="button"
							disabled={compacting}
							onClick={props.onCompact}
							className={`mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border bg-transparent text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-60 ${compactUrgency}`}
						>
							<FoldVertical
								size={13}
								className={compacting ? "animate-spin" : undefined}
							/>
							{compacting ? t("sessionContext.compacting") : t("sessionContext.compact")}
						</button>
					)}
					</div>,
					document.body,
				)}
		</span>
	);
}
