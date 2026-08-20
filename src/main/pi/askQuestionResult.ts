/**
 * 主进程 ask_question 工具结果 → AskQuestionResultSummary 构造器（纯函数，可单测）。
 *
 * 实时（AgentManager）与历史（AgentMessageProjector）两条投影路径共用本函数，
 * 保证同一工具结果在「运行中」与「刷新后回放」得到同样形状的 _askCard，
 * 避免实时/历史分叉（历史上批量问答在实时保留全部题、历史只保留第一题）。
 *
 * 解析顺序（与 PiDeck-Q-Ask-Question 扩展的返回结构对齐）：
 * 1. result.details 嵌套（扩展标准格式）；
 * 2. result 顶层 question / questions+answers（无 details 包装）；
 * 3. result 为简单值（选中项字符串/布尔）或结构未识别时，从 args 回退读 question。
 * 最后统一走共享 normalizer 收窄，保证 cancelled/answered 语义一致。
 */
import type { AskQuestionResultSummary } from "../../shared/types";
import { normalizeAskQuestionResultSummary } from "../../shared/askQuestion";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 args：可能是对象，也可能是已被主进程序列化的 JSON 字符串。 */
function parseArgs(args: unknown): Record<string, unknown> | undefined {
	if (isRecord(args)) return args;
	if (typeof args === "string" && args.trim()) {
		try {
			const parsed: unknown = JSON.parse(args);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** 一个 record 是否像「ask 结果」：带 question，或带 questions/answers 数组。 */
function looksLikeAskDetails(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	return (
		(typeof value.question === "string" && value.question.length > 0) ||
		Array.isArray(value.questions) ||
		Array.isArray(value.answers)
	);
}

/**
 * 构造已完成 ask_question 的规范结果。
 * @returns undefined 表示「不是 ask_question 或结构无法识别」，调用方退化为普通工具卡。
 */
export function buildAskQuestionResultSummary(input: {
	toolName: string;
	args: unknown;
	result: unknown;
	aborted: boolean;
	/** 工具调用本身失败（pi 标记 isError）：字符串 result 是错误文案，不是用户回答。 */
	isError?: boolean;
}): AskQuestionResultSummary | undefined {
	if (input.toolName.toLowerCase() !== "ask_question") return undefined;
	const { args, result, aborted } = input;
	// 错误门：ask_question 出错（UI 超时/pi 内部异常）时 result 是错误文案，
	// 不过滤的话格式 3 会把错误文案升格成「已回答」，渲染出看起来答过的常驻问答卡。
	// 降级策略：返回 undefined → 调用方保留普通工具卡（✗ ask_question + detailText）。
	// 显式 abort 优先：部分 pi/runtime 会把用户取消同时标成 isError，此时仍应展示
	// 「已取消」结果，而不是把用户主动取消误报成工具失败。
	if (input.isError === true && !aborted) return undefined;

	// 格式 1：扩展标准 result.details 嵌套（details 必须本身像 ask 结果）。
	let details: Record<string, unknown> | undefined;
	if (isRecord(result) && looksLikeAskDetails(result.details)) {
		details = result.details;
	}
	// 格式 2：result 顶层直接带 question / questions+answers（无 details 包装）。
	if (!details && looksLikeAskDetails(result)) {
		details = result;
	}

	// 格式 3：result 简单值（选中项字符串/布尔）或结构未识别 → 从 args 回退读问题。
	// 关键门：格式 3 只在「result 已到达但形状简单」时启用（result != null）。
	// running 阶段 result === undefined，若不加此门，args.question 存在就会在
	// tool_execution_start 时提前构造出常驻问答卡（与旧实现 !result 门对齐）。
	if (!details && result !== undefined && result !== null) {
		const parsedArgs = parseArgs(args);
		const question = parsedArgs?.question;
		if (typeof question === "string" && question.length > 0) {
			// 简单值直接用 result 作为回答；对象则取 value/answer 字段。
			// 未识别对象没有可用答案时不得硬标 answered=true；非 abort 场景直接
			// 降级为普通工具卡，避免徽标“已回答”但正文“未回答”的矛盾状态。
			const answer =
				typeof result === "string" || typeof result === "boolean"
					? result
					: isRecord(result)
						? (result.value ?? result.answer)
						: result;
			const hasAnswer = answer !== undefined && answer !== null;
			if (hasAnswer || aborted) {
				details = {
					question,
					...(typeof parsedArgs?.type === "string" ? { type: parsedArgs.type } : {}),
					...(Array.isArray(parsedArgs?.options) ? { options: parsedArgs.options } : {}),
					answer: hasAnswer ? answer : null,
					answered: hasAnswer,
					answerLabel: typeof answer === "string" ? answer : undefined,
				};
			}
		} else if (Array.isArray(parsedArgs?.questions)) {
			// 批量但 result 简单：问题定义来自 args，回答来自 result。
			details = {
				questions: parsedArgs.questions,
				answers: Array.isArray(result) ? result : undefined,
			};
		}
	}

	if (!details) return undefined;

	// aborted 作为显式取消覆写：即使 details 没带 cancelled 也强制未回答。
	return normalizeAskQuestionResultSummary(details, aborted);
}
