import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronUp, Clock, Share, SquarePen, Trash } from "lucide-react";
import { atom, useAtomValue } from "jotai";
import type { ImageContent } from "../../../../../shared/types";
import { liveTextStreamingBySessionAtom, newTurnCollapseTickBySessionIdAtomFamily } from "../../../atoms/session-atoms";
import { turnFlowSettingsAtom } from "../../../atoms/app-ui-atoms";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../../ui-shadcn/collapsible";
import { formatDuration, formatTime, stripAnsi, stripThinkingTags } from "../TimelineFormat";
import { LiveDuration } from "../LiveDuration";
import { CopyMenu, stripMarkdown } from "../SurfaceComponents";
import { buildTurnDisplay, hasFoldableContent } from "../timeline/buildTurnDisplay";
import { resolveLiveInterimId } from "../timeline/liveMount";
import { buildProcessSummary } from "../timeline/segmentSummary";
import type {
	AgentRunItem,
	MessageItem,
} from "../timeline/types";
import { sameAgentRunForRender } from "../../app/AppUtils";
import { FinalAnswer } from "./FinalAnswer";
import { InterimAnswer } from "./InterimAnswer";
import { ProcessSummaryToggle } from "./ProcessSummaryToggle";
import { ThinkingStep } from "./ThinkingStep";
import { ToolStep } from "./ToolStep";
import { TurnFileChanges } from "./TurnFileChanges";
import { useTurnExecution } from "./useTurnExecution";
import type { DiffFileHandler } from "../ToolCallComponents";

/** sessionId 为空时的占位 atom：恒 false（无会话不挂 live）。 */
const NO_LIVE_TEXT_ATOM = atom(false);
/** sessionId 为空时的占位 atom：恒 0（无会话不订阅新一轮信号）。 */
const NO_TURN_TICK_ATOM = atom(0);

/**
 * 一轮 AI 回答的扁平容器：左侧竖线聚合，内含思考/工具/回答。
 *
 * 展示语义（与用户确认）：
 * - 唯一「执行过程」折叠汇总按钮（run 开头，纯数字）；
 * - 思考/工具/中间回答原位穿插，共用一个 run 级折叠开关；
 * - 最终回答常驻、永不折叠；
 * - 流式中自动展开（实时滚出），run 结束后 1.5s 自动收起。
 *
 * Live 正文由 InterimAnswer(mode=live) → AnswerOutput 订阅 atom，本组件不订 streaming store。
 */
export type TurnRowProps = {
	run: AgentRunItem;
	/** 所属会话 id（转交给 live InterimAnswer） */
	sessionId?: string;
	/** 新消息入场动画：仅发送后尾部新增的消息播放一次 */
	fresh?: boolean;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	isStreaming?: boolean;
	/** 当前 live 思考段稳定 id（msg-thinking-*），交给 buildTurnDisplay 同身份挂载 */
	liveThinkingId?: string;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	onResendUserMessage?: (message: never) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	/** Agent 正在处理请求或流式输出中时禁用编辑/删除等操作按钮 */
	agentRunning?: boolean;
	/** 是否时间线最新一轮（非最新不自动收起） */
	isLatestRun?: boolean;
	/** 是否为时间线上最后一个 agent-run（live 正文挂载门：仅它可挂会话级流式槽） */
	isLastAgentRun?: boolean;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
};

export const TurnRow = memo(
	function TurnRow(props: TurnRowProps) {
	const { run } = props;
	const rowRef = useRef<HTMLElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区（避免 textarea 超出可视区域）
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);

	const isComplete = run.endedAt > 0;
	// 结束判定不能依赖 isComplete：groupToolMessages 里 endedAt 永远是最后一条消息时间戳，
	// 流式 run 也有空骨架消息（message_start/thinking 时创建），因此流式中 isComplete 恒为 true。
	// 真实语义：agentRunning 期间（仅末轮）由 LiveDuration 实时计时，agent 空闲后才显示固定值。
	const isRunLive = Boolean(props.agentRunning);
	const duration = isComplete && run.startedAt > 0 ? run.endedAt - run.startedAt : 0;
	// 耗时：结束后固定（endedAt - startedAt）；流式中（isRunLive）由 LiveDuration 实时增长
	const showDuration =
		(isComplete && !isRunLive && duration > 0) || (isRunLive && run.startedAt > 0);

	// 扁平展示序列：Live 与 History 共用 msg-thinking-* 身份（liveThinkingId 命中即挂步）。
	const displayItems = useMemo(
		() =>
			buildTurnDisplay(run, {
				showThinking: props.showThinking,
				isComplete: !props.agentRunning,
				liveThinkingId: props.liveThinkingId,
			}),
		[run, props.showThinking, props.agentRunning, props.liveThinkingId],
	);

	const processSummary = useMemo(() => buildProcessSummary(displayItems), [displayItems]);
	const showProcessToggle = hasFoldableContent(displayItems);

	// 流式中最后一条中间回答 id（Live 挂载锚点）。
	const lastInterimId = useMemo(() => {
		let last: string | undefined;
		for (const item of displayItems) {
			if (item.kind === "interim-answer") last = item.id;
		}
		return last;
	}, [displayItems]);

	// 末条 Live 正文：挂在折叠容器外常显（避免 Radix Collapsible 卸载/收起导致无 DOM）。
	// 要求「存在活动正文流」且「本轮是最后一个 agent-run」才挂 live：
	// - 中间回复 message_end 后槽删（streaming=false）立即落回容器内 settled，
	//   消除双失明消失窗口（live 读空 + 容器内被跳过）；
	// - 被 steer 打断的旧轮尾部是空文本 interim（骨架挂载点），若允许旧轮挂 live，
	//   新一轮流式时旧轮会把会话槽里的新一轮正文再打印一遍——同一中间回复前后双份
	//   （2026-08 回归：判定逻辑见 resolveLiveInterimId，按轮级门控）。
	// 流式期间 content 每 50ms 变化但 streaming 不变 → 派生 boolean 引用稳定 → 零额外重渲染。
	const liveTextActive = useAtomValue(
		props.sessionId ? liveTextStreamingBySessionAtom(props.sessionId) : NO_LIVE_TEXT_ATOM,
	);
	const liveInterimId = useMemo(() => {
		const last = displayItems.find(
			(item) => item.kind === "interim-answer" && item.id === lastInterimId,
		);
		if (!last || last.kind !== "interim-answer") return undefined;
		return resolveLiveInterimId({
			sessionId: props.sessionId,
			lastInterimId,
			liveTextActive,
			lastMessageText: last.message.text,
			agentRunning: props.agentRunning,
			isStreaming: props.isStreaming,
			isLastAgentRun: props.isLastAgentRun,
		});
	}, [
		props.sessionId,
		props.agentRunning,
		props.isStreaming,
		props.isLastAgentRun,
		lastInterimId,
		displayItems,
		liveTextActive,
	]);

	// live plain 卸下 → settled Markdown 挂上：只给刚卸下的那条 id 打一次 settle 淡入。
	const prevLiveIdRef = useRef<string | undefined>(undefined);
	const [settleId, setSettleId] = useState<string | undefined>(undefined);
	useEffect(() => {
		const prev = prevLiveIdRef.current;
		const next = liveInterimId;
		if (prev && !next) {
			setSettleId(prev);
			const timer = window.setTimeout(() => setSettleId(undefined), 320);
			prevLiveIdRef.current = next;
			return () => window.clearTimeout(timer);
		}
		prevLiveIdRef.current = next;
		return undefined;
	}, [liveInterimId]);

	// run 级折叠状态（一个开关控制全部思考/工具/中间回答步骤）
	// hasFinalAnswer：无最终回答的 run 不自动收起（中间回答是唯一输出，不能被折叠隐藏）
	const hasFinalAnswer = displayItems.some((item) => item.kind === "final-answer");
	// 流式对话行为设置（App 同步写入）+ 新一轮信号（composer 发送成功后 bump）。
	// 设置变化低频；tick 经 atomFamily selectAtom 隔离，跨会话 bump 不触发本行重渲染。
	const flowSettings = useAtomValue(turnFlowSettingsAtom);
	const newTurnCollapseTick = useAtomValue(
		props.sessionId
			? newTurnCollapseTickBySessionIdAtomFamily(props.sessionId)
			: NO_TURN_TICK_ATOM,
	);
	const { stepsVisible, setStepsVisibleFromUser, toggleSteps } =
		useTurnExecution({
			agentRunning: props.agentRunning,
			isComplete,
			hasFinalAnswer,
			isLatestRun: props.isLatestRun,
			expandInterimDuringStream: flowSettings.expandInterimDuringStream,
			collapsePrevRunsOnNewTurn: flowSettings.collapsePrevRunsOnNewTurn,
			newTurnCollapseTick,
		});

	// 中间内容（思考/工具/中间回答）与最终回答分组：
	// 中间内容统一收进执行过程折叠容器（stepsVisible 整体控制显隐），
	// 最终回答留在容器外常驻、永不折叠。
	const foldableItems = useMemo(
		() => displayItems.filter((item) => item.kind !== "final-answer"),
		[displayItems],
	);
	const finalItems = useMemo(
		() => displayItems.filter((item) => item.kind === "final-answer"),
		[displayItems],
	);
	// 收集本轮所有 assistant 消息（按 run.items 的时序保持原始顺序）
	const assistantMessages = run.items.filter(
		(item): item is MessageItem =>
			item.kind === "message" && item.message.role === "assistant",
	);
	const allImages: ImageContent[] = [];
	for (const item of assistantMessages) {
		if (item.message.images) allImages.push(...item.message.images);
	}
	// 合并后的完整文本仅用于编辑/复制/删除等操作栏，不用于展示
	const mergedText = assistantMessages
		.map((item) => stripThinkingTags(stripAnsi(item.message.text)).trim())
		.filter(Boolean)
		.join("\n\n");

	// 本轮没有任何可渲染内容时不输出空容器
	if (displayItems.length === 0 && allImages.length === 0) return null;

	const startEditing = () => {
		setEditText(mergedText);
		setEditing(true);
	};
	const saveEdit = () => {
		const targetId = assistantMessages.at(-1)?.message.id;
		if (targetId && props.onEditMessage) {
			props.onEditMessage(targetId, editText);
			setEditing(false);
		}
	};
	const deleteMessage = () => {
		const targetId = assistantMessages.at(-1)?.message.id;
		if (targetId) props.onDeleteMessage?.(targetId);
	};

	return (
		<article
			ref={rowRef}
			className={`turn-row mb-6 w-full min-w-0 max-w-full ${
				props.agentRunning && !isComplete
					? "turn-row--running"
					: isComplete
						? "turn-row--complete"
						: "turn-row--pending"
			} ${props.fresh ? "turn-row--fresh" : ""}`}
			data-message-id={run.id}
		>
			<div className="flex min-w-0 flex-col gap-3">
				{/* 行头：logo 用字号 token（text-brand 18px），随 data-ui-font-size 整体缩放；
				    时间用 text-body（14px）。耗时不放行头——回复生成时用户视线在底部，
				    统一显示在 turn 尾部（见底部耗时行），不用翻回开头看跑了多久。 */}
				<div className="mb-1 inline-flex items-center gap-2 text-muted-foreground tabular-nums">
					<span className="shrink-0 font-mono text-brand font-semibold leading-none text-foreground/80">pi</span>
					<time className="shrink-0 font-mono text-body leading-none">{formatTime(run.endedAt)}</time>
				</div>

				{/* 执行过程折叠栏：中间内容（思考/工具/中间回答）统一收进容器，
				    由 stepsVisible 整体控制显隐；最终回答在容器外常驻。
				    学 Proma ProcessBlockGroup：CollapsibleContent 自带高度过渡动画，
				    折叠/展开是 scrollHeight 高度渐变而非 display:none 突变。 */}
				{showProcessToggle && (
					<Collapsible
						className="execution-summary"
						open={stepsVisible}
						// Radix 传入目标 open；必须 set 而非 toggle，否则受控更新会把状态打反。
						onOpenChange={setStepsVisibleFromUser}
					>
						<ProcessSummaryToggle
							summary={processSummary}
							expanded={stepsVisible}
							onToggle={toggleSteps}
						/>
						<CollapsibleContent className="execution-summary-details">
							{foldableItems.map((item) => {
								let content: ReactNode;
								let itemKey: string;
								if (item.kind === "process-entry") {
									itemKey = item.entry.id;
									if (item.entry.kind === "thinking-entry") {
										content = (
											<ThinkingStep
												group={item.entry.group}
												hidden={!stepsVisible}
												showThinking={props.showThinking}
												onOpenExternal={props.onOpenExternal}
												onOpenFile={props.onOpenFile}
											/>
										);
									} else {
										content = (
											<ToolStep
												group={item.entry.group}
												hidden={!stepsVisible}
												stopped={props.agentRunning !== true}
												sessionId={props.sessionId}
											/>
										);
									}
								} else if (item.kind === "interim-answer") {
									itemKey = item.id;
									// Live 末条在折叠容器外渲染，此处跳过以免双份。
									if (item.id === liveInterimId) return null;
									content = (
										<InterimAnswer
											mode="settled"
											text={item.message.text}
											hidden={!stepsVisible}
											isStreaming={false}
											settle={settleId === item.id}
											onOpenExternal={props.onOpenExternal}
											onOpenFile={props.onOpenFile}
										/>
									);
								} else {
									// final-answer 不在此容器内（见下方常驻区），此处仅兜底跳过
									return null;
								}
								return <Fragment key={itemKey}>{content}</Fragment>;
							})}
							{/* 收起按钮：固定在折叠容器末尾（不再是动态跟随） */}
							{stepsVisible && (
								<button
									type="button"
									className="execution-summary-collapse"
									onClick={toggleSteps}
									title={t("common.collapse")}
								>
									<ChevronUp size={12} aria-hidden="true" />
									<span>{t("common.collapse")}</span>
								</button>
							)}
						</CollapsibleContent>
					</Collapsible>
				)}

				{/* Live 正文：折叠容器外常显，确保流式 DOM 可采样、不被 Collapsible 卸载 */}
				{liveInterimId && props.sessionId && (
					<InterimAnswer
						mode="live"
						sessionId={props.sessionId}
						hidden={false}
						isStreaming={Boolean(props.isStreaming || props.agentRunning || liveInterimId)}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
					/>
				)}

				{/* 最终回答：本轮最后一条 assistant 文本，常驻、永不折叠 */}
				{finalItems.map((item) => (
					<div key={item.id} data-final-answer={run.id} data-message-id={item.id}>
						<FinalAnswer
							message={item.message}
							images={allImages}
							isStreaming={props.isStreaming ?? false}
							settle={settleId === item.id}
							editing={editing}
							editText={editText}
							editAreaRef={editAreaRef}
							onEditTextChange={setEditText}
							onStartEdit={startEditing}
							onCancelEdit={() => setEditing(false)}
							onSaveEdit={saveEdit}
							onPreviewImage={props.onPreviewImage}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					</div>
				))}

				{/* 操作栏 */}
				{mergedText && !editing && (
					<div className="flex min-h-6 items-center gap-1 opacity-55 transition-opacity hover:opacity-100 focus-within:opacity-100">
						<CopyMenu
							text={stripMarkdown(mergedText)}
							markdown={mergedText}
							targetRef={rowRef}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={props.onEnterMultiSelect}
							title={t("app.multiSelectEnter")}
						>
							<Share size={14} />
						</Button>
						{!props.isStreaming &&
							!props.agentRunning &&
							assistantMessages.at(-1)?.message.id && (
								<>
									{props.onEditMessage && (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
											onClick={startEditing}
											title={t("common.edit")}
										>
											<SquarePen size={14} />
										</Button>
									)}
									{props.onDeleteMessage && (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
											onClick={deleteMessage}
											title={t("common.delete")}
										>
											<Trash size={14} />
										</Button>
									)}
								</>
							)}
					</div>
				)}

				{/* 尾部耗时：回复生成中由 LiveDuration 实时计时（100ms 连续跳动，用户视线在底部），
				    回复结束后固定为总耗时。全轮只有一个耗时显示点（行头只留时间戳），
				    避免开头结尾重复；无最终回答的轮（纯工具/思考）同样可见。 */}
				{showDuration && (
					<div className="flex items-center gap-1.5 text-muted-foreground">
						<Clock size={12} className="shrink-0" aria-hidden="true" />
						<span className="font-mono text-body leading-none tabular-nums">
							{isRunLive ? (
								<LiveDuration startedAt={run.startedAt} isStreaming />
							) : (
								formatDuration(duration)
							)}
						</span>
					</div>
				)}

				{/* 本轮文件修改：固定显示在本轮底部（后续发送新消息不清除），
				    点击行展开内联 diff，行尾按钮打开右侧差异查看器 */}
				<TurnFileChanges
					run={run}
					streaming={props.isStreaming}
					onDiffFile={props.onDiffFile}
				/>
			</div>
		</article>
	);
},
turnRowPropsEqual,
);

/**
 * TurnRow 自定义 memo 比较（阶段 0：历史 run 跳过重渲染）。
 *
 * 比较项：
 * - run：深度比较内容（sameAgentRunForRender），未变化的 run 不重渲染；
 * - 标量 props（fresh/showThinking/isStreaming/liveThinkingId/agentRunning）：=== 比较；
 * - 回调函数（onPreviewImage/onOpenExternal/onOpenFile/onDiffFile/onEditMessage/onDeleteMessage/
 *   onEnterMultiSelect）：行为稳定（读 ref/setState），引用变化不影响渲染结果，忽略（同 FinalAnswer 惯例）。
 */
function turnRowPropsEqual(prev: TurnRowProps, next: TurnRowProps): boolean {
	// 流式 run：Live AnswerOutput 随 atom 更新；父级仍需在 isStreaming 边沿重渲染折叠态。
	if (prev.isStreaming || next.isStreaming) return false;
	if (!sameAgentRunForRender(prev.run, next.run)) return false;
	return (
		prev.sessionId === next.sessionId &&
		prev.fresh === next.fresh &&
		prev.showThinking === next.showThinking &&
		prev.liveThinkingId === next.liveThinkingId &&
		prev.agentRunning === next.agentRunning &&
		prev.isLatestRun === next.isLatestRun &&
		prev.isLastAgentRun === next.isLastAgentRun
	);
}
