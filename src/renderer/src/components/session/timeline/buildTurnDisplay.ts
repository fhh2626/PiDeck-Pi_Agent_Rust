/**
 * 把一轮 agent-run 展开为扁平展示序列（纯函数，可单测）。
 *
 * 语义（与用户确认）：
 * - 中间回答：本轮「不是最后一条」的 assistant 文本（思考/工具之间的阶段性输出）。
 * - 最终回答：本轮「最后一条且为收尾条目」的 assistant 文本，常驻、永不折叠。
 *   仅当 run 的最后一条条目就是该 assistant 时才提升：工具调用前的阶段性文本
 *   （后随 tool/thinking 条目）即使暂时是最后一条 assistant，也只是中间回答，
 *   防止 steer 打断/工具回合中「中间回复被提升为最终回答、随 run 追加又降级」。
 *   真正的最终回答必然是 run 的收尾条目，因此一旦提升即稳定，不会反复。
 *   例外：提问说明（当前轮 pending ask，或后面紧跟 ask_question/_askCard）
 *   即使 stopReason=toolUse、后面还有提问工具，也提升为 final-answer，避免被折进执行过程。
 * - 思考/工具步骤：原位出现，不打包进同一 DOM 容器（避免折叠容器被回答文本打断），
 *   由外层 run 级折叠开关统一控制显隐。
 * - assistant 消息自带的 thinking 作为思考步骤插到该回答之前（保持「思考→回答」时序）。
 * - 严格按 run.items 原始时序输出，不做任何重排。
 *
 * 设计说明：旧 buildTurnSegments 把「不连续的思考/工具」拆成多个 process 段，
 * 导致一轮回答出现多个「执行过程」折叠汇总。此处改为扁平序列 + 单一折叠控制，
 * 由 turn/TurnRow 渲染成「一个汇总按钮 + 步骤原位穿插 + 回答常驻」。
 */
import type { AgentRunItem, ThinkingGroupItem } from "../../app/AppUtils";
import type { TurnDisplayItem } from "./types";

/* 内联 strip 工具：本模块零运行时依赖（node 单测直接加载 .ts，
 * 无扩展名相对 import 在 node ESM 下不可解析；与 TimelineFormat.ts 同逻辑，改动需同步）。 */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

function isAskQuestionToolGroup(item: AgentRunItem["items"][number]): boolean {
	if (item.kind !== "tool-group") return false;
	return item.messages.some((message) => {
		const toolName = String(message.meta?.toolName ?? "").toLowerCase();
		if (toolName === "ask_question") return true;
		const askCard = message.meta?._askCard;
		return Boolean(askCard && typeof askCard === "object");
	});
}

/** 本轮是否已经出现 ask_question / _askCard 工具组（历史回放与 sticky 解除都靠它）。 */
export function hasAskQuestionTool(run: AgentRunItem): boolean {
	return run.items.some(isAskQuestionToolGroup);
}

/**
 * 提问说明的会话级钉住状态。
 * 用户提交后 pending UI 会立刻变成 completed，但 ask_question 工具结果往往还没进 run。
 * 若此时立刻把 hasPendingAsk 降为 false，说明文字会从 final-answer 掉回折叠栏再被提回去。
 * 因此：本轮曾经出现过 pending ask，且还没看到提问工具组时，继续钉住。
 */
export function resolveAskLeadInPin(input: {
	isLastAgentRun: boolean;
	livePendingAsk: boolean;
	wasPinned: boolean;
	hasAskQuestionTool: boolean;
}): { pin: boolean; nextPinned: boolean } {
	if (!input.isLastAgentRun) return { pin: false, nextPinned: false };
	if (input.hasAskQuestionTool) return { pin: false, nextPinned: false };
	const nextPinned = input.wasPinned || input.livePendingAsk;
	return { pin: nextPinned, nextPinned };
}

function shouldPinAskLeadIn(
	run: AgentRunItem,
	messageIndex: number,
	options: { hasPendingAsk?: boolean },
): boolean {
	const item = run.items[messageIndex];
	if (item.kind !== "message" || item.message.role !== "assistant") return false;
	const text = stripThinkingTags(stripAnsi(item.message.text)).trim();
	if (!text) return false;

	// 只允许提升“最后一条有正文的 assistant”
	for (let i = messageIndex + 1; i < run.items.length; i += 1) {
		const later = run.items[i];
		if (later.kind === "message" && later.message.role === "assistant") {
			const laterText = stripThinkingTags(stripAnsi(later.message.text)).trim();
			if (laterText) return false;
		}
	}

	const laterItems = run.items.slice(messageIndex + 1);
	const laterAsk = laterItems.some(isAskQuestionToolGroup);
	if (laterAsk) return true;

	if (!options.hasPendingAsk) return false;

	// 提问当下：后面还没有 ask_question 工具组。
	// 如果后面已经出现普通工具，说明这不是提问说明，而是普通 toolUse 中间回复。
	const laterNonAskTool = laterItems.some(
		(later) => later.kind === "tool-group" && !isAskQuestionToolGroup(later),
	);
	return !laterNonAskTool;
}

export function buildTurnDisplay(
	run: AgentRunItem,
	options: {
		showThinking?: boolean;
		isComplete?: boolean;
		/** 当前 live 思考段 id（msg-thinking-*）；命中时即使 message.thinking 仍空也挂思考步 */
		liveThinkingId?: string;
		/** 当前会话是否存在等待用户处理的交互提问请求（select/confirm/input 等） */
		hasPendingAsk?: boolean;
	} = {},
): TurnDisplayItem[] {
	const showThinking = Boolean(options.showThinking);
	const liveThinkingId = options.liveThinkingId;
	// run 是否已结束：只有结束时才能确定「最后一条 assistant 是最终回答」。
	// 流式中（isComplete=false）无法预知哪条是最后一条，全部按中间回答处理、
	// 收进执行过程折叠栏；run 结束后才把最后一条提升为常驻的最终回答。
	const isComplete = options.isComplete ?? true;

	const items: TurnDisplayItem[] = [];
	// 已有 thinking-group 始终保留；消息自带 thinking 受 showThinking 控制。
	const pushThinking = (group: ThinkingGroupItem, respectShowThinking: boolean) => {
		if (respectShowThinking && !showThinking) return;
		items.push({
			kind: "process-entry",
			entry: { kind: "thinking-entry", id: group.id, group },
		});
	};

	run.items.forEach((item, index) => {
		if (item.kind === "thinking-group") {
			pushThinking(item, false);
			return;
		}
		if (item.kind === "tool-group") {
			items.push({
				kind: "process-entry",
				entry: { kind: "tool-entry", id: item.id, group: item },
			});
			return;
		}
		if (item.kind !== "message" || item.message.role !== "assistant") return;
		// 消息自带的思考 / live 同 id：插到该回答之前（思考→回答时序）。
		// Live 时 text 可空，叶子 ThinkingStep 从 streamingThinkingByIdAtom 填。
		const thinkingId = `msg-thinking-${item.message.id}`;
		const isLive = Boolean(liveThinkingId && liveThinkingId === thinkingId);
		const thinking =
			showThinking && item.message.thinking?.trim()
				? stripAnsi(item.message.thinking)
				: "";
		if (thinking || (showThinking && isLive)) {
			pushThinking(
				{
					kind: "thinking-group",
					// 稳定 id 与主进程 live 通道相同：Live→History 不 remount。
					id: thinkingId,
					messages: [item.message],
					text: thinking,
					startedAt:
						item.message.thinkingStartedAt ??
						item.message.timestamp ??
						run.startedAt,
					endedAt: isLive
						? 0
						: (item.message.thinkingEndedAt ??
							item.message.timestamp ??
							run.endedAt),
				},
				true,
			);
		}
		// 空文本消息：始终保留 interim 挂载点（Live 正文走独立通道，骨架可为空）。
		// 旧逻辑在 isComplete 时跳过空文本，会导致 agentRunning 判定滞后时整段无挂载、
		// 只能等 message_end 才突然出现最终回答（打字机 E2E 采不到 .execution-interim）。
		const text = stripThinkingTags(stripAnsi(item.message.text)).trim();
		if (!text) {
			items.push({ kind: "interim-answer", id: item.message.id, message: item.message });
			return;
		}
		// 最终回答判定（run 收尾条目 + 协议信号/回退启发式）：
		// - 收尾条目必须是 assistant（后随 tool/thinking 的阶段性文本不具备资格）；
		// - stopReason === "stop"：pi RPC message_end 的 provider 归一化枚举，
		//   message_end 时即确定、永不反复（steer 排队的中间回复恒为 toolUse，不会误提升）；
		// - 无 stopReason / pending（骨架占位残留）：回退启发式（历史旧数据兼容）。
		// - 例外：提问导语（pending ask 或后随 ask_question）即使 stopReason=toolUse 也提升为 final-answer
		// 位置守卫防御异常数据（stop 消息后仍有条目）：保证每 run 至多一个 final-answer。
		const isAskLeadIn = shouldPinAskLeadIn(run, index, { hasPendingAsk: options.hasPendingAsk });
		const isRunTail = isComplete && index === run.items.length - 1;
		const isFinal =
			isAskLeadIn ||
			(isRunTail &&
				(item.message.stopReason === "stop" ||
					!item.message.stopReason ||
					item.message.stopReason === "pending"));
		if (isFinal) {
			items.push({ kind: "final-answer", id: item.message.id, message: item.message });
		} else {
			items.push({ kind: "interim-answer", id: item.message.id, message: item.message });
		}
	});

	return items;
}

/** 本轮是否存在「可折叠」内容（思考/工具/有文本的中间回答之一），决定是否渲染汇总按钮。 */
export function hasFoldableContent(items: TurnDisplayItem[]): boolean {
	return items.some((item) => {
		if (item.kind === "final-answer") return false;
		// 空文本 interim（live 挂载点/错误占位）不是可折叠内容：
		// 全空 run（如连续 error 空消息）不应出现「0 段中间回复」的按钮。
		if (item.kind === "interim-answer") return !!item.message.text.trim();
		return true;
	});
}
