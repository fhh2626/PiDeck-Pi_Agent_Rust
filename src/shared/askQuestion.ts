/**
 * ask_question 已完成问答结果的共享规范化（纯函数，零运行时依赖）。
 *
 * 主进程两条投影路径（实时 AgentManager / 历史 AgentMessageProjector）负责把
 * pi 的原始工具结果构建成 AskQuestionResultSummary（见 main/pi/askQuestionResult.ts）；
 * 本模块负责把可能来自旧版本/损坏数据的未知结构收窄为规范类型，
 * 供桌面 TurnRow 与 Web WebTimeline 共用，避免两侧各写一套解析。
 *
 * 原则：
 * - 不抛异常：任何非法输入都安全降级（返回 undefined 或更保守的结构）；
 * - 不用 as 强转绕过类型：全部用 typeof / Array.isArray 收窄；
 * - cancelled 时强制 answered=false / answer=null，避免「取消却显示默认选项」。
 */
import type {
	AgentUiBatchQuestion,
	AskQuestionResultItem,
	AskQuestionResultOption,
	AskQuestionResultSummary,
	ChatMessage,
} from "./types";

const ASK_TYPE_MAP: Record<string, AskQuestionResultItem["type"]> = {
	select: "select",
	confirm: "confirm",
	input: "input",
	editor: "editor",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeType(value: unknown): AskQuestionResultItem["type"] | undefined {
	return typeof value === "string" ? ASK_TYPE_MAP[value] : undefined;
}

function normalizeOption(value: unknown): AskQuestionResultOption | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (isRecord(value) && typeof value.label === "string" && value.label.length > 0) {
		const option: AskQuestionResultOption = { label: value.label };
		if (value.value !== undefined) option.value = value.value;
		if (typeof value.description === "string" && value.description) {
			option.description = value.description;
		}
		return option;
	}
	return undefined;
}

function normalizeOptions(value: unknown): AskQuestionResultOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const options: AskQuestionResultOption[] = [];
	for (const entry of value) {
		const option = normalizeOption(entry);
		if (option) options.push(option);
	}
	return options.length > 0 ? options : undefined;
}

/** 把单个问题的原始结构收窄为 AskQuestionResultItem；无有效问题文本返回 undefined。 */
export function normalizeAskQuestionResultItem(
	raw: unknown,
): AskQuestionResultItem | undefined {
	if (!isRecord(raw)) return undefined;
	const question = typeof raw.question === "string" ? raw.question : "";
	if (!question.trim()) return undefined;
	// answered 缺失时按 answer 是否有效回退（旧数据没有 answered 字段）。
	const answer = "answer" in raw ? raw.answer : undefined;
	const answered =
		typeof raw.answered === "boolean"
			? raw.answered
			: answer !== null && answer !== undefined;
	const item: AskQuestionResultItem = {
		question,
		answered,
		answer: answer === undefined ? null : answer,
	};
	const type = normalizeType(raw.type);
	if (type) item.type = type;
	const answerLabel =
		typeof raw.answerLabel === "string" && raw.answerLabel
			? raw.answerLabel
			: undefined;
	if (answerLabel) item.answerLabel = answerLabel;
	const options = normalizeOptions(raw.options);
	if (options) item.options = options;
	return item;
}

/** 批量 items：遍历 questions（问题定义）与 answers（回答），取最大长度对齐。 */
function normalizeBatchItems(
	questionsRaw: unknown,
	answersRaw: unknown,
): AskQuestionResultItem[] | undefined {
	const questions = Array.isArray(questionsRaw) ? questionsRaw : [];
	const answers = Array.isArray(answersRaw) ? answersRaw : [];
	const length = Math.max(questions.length, answers.length);
	if (length === 0) return undefined;
	const items: AskQuestionResultItem[] = [];
	for (let index = 0; index < length; index += 1) {
		const questionRaw = questions[index];
		const answerRaw = answers[index];
		// 问题定义优先；缺失时用 answer 自身回退；再缺失时用 id 合成最小问题文本，
		// 保证 answers-only 批量每题都有可展示标题。
		let base = isRecord(questionRaw)
			? normalizeAskQuestionResultItem(questionRaw)
			: isRecord(answerRaw)
				? normalizeAskQuestionResultItem(answerRaw)
				: undefined;
		if (!base && isRecord(answerRaw)) {
			const id =
				typeof answerRaw.id === "string"
					? answerRaw.id
					: answerRaw.id != null
						? String(answerRaw.id)
						: "";
			base = normalizeAskQuestionResultItem({ question: id });
		}
		if (!base) continue;
		// answer 侧的 value/label 覆盖问题侧（answers[].value 才是真实回答）。
		if (isRecord(answerRaw)) {
			if ("value" in answerRaw) base.answer = answerRaw.value ?? null;
			const label = answerRaw.label;
			if (typeof label === "string" && label) base.answerLabel = label;
			base.answered =
				"answered" in answerRaw && typeof answerRaw.answered === "boolean"
					? answerRaw.answered
					: base.answer !== null && base.answer !== undefined;
		} else if (
			typeof answerRaw === "string" ||
			typeof answerRaw === "boolean" ||
			(typeof answerRaw === "number" && Number.isFinite(answerRaw))
		) {
			// 旧版本/第三方 ask 实现可能直接返回标量 answers；false/0 都是有效回答，
			// 不能用 truthy 判断，否则批量确认题会被误显示为未回答。
			base.answer = answerRaw;
			base.answered = true;
		}
		items.push(base);
	}
	return items.length > 0 ? items : undefined;
}

/**
 * 把任意 _askCard 原始结构收窄为 AskQuestionResultSummary。
 * 无有效问题文本（单题/批量都没有）时返回 undefined，调用方退化为普通工具卡。
 */
export function normalizeAskQuestionResultSummary(
	value: unknown,
	/** 显式取消覆写（主进程 abort 时传 true）：即使 details 没带 cancelled 也按取消处理。 */
	aborted = false,
): AskQuestionResultSummary | undefined {
	if (!isRecord(value)) return undefined;
	const cancelled = value.cancelled === true || aborted;

	// 批量：questions 数组优先；否则 answers 数组（无 questions 定义时逐 answer 反推）。
	let items: AskQuestionResultItem[] | undefined;
	if (Array.isArray(value.questions) || Array.isArray(value.answers)) {
		items = normalizeBatchItems(value.questions, value.answers);
	}
	if (!items) items = [normalizeAskQuestionResultItem(value)].filter(
		(item): item is AskQuestionResultItem => item !== undefined,
	);
	if (!items || items.length === 0) return undefined;

	// cancelled 时强制未回答：pi 取消后会返回 undefined，扩展默认选第一项，
	// 若保留 answer 会把「默认第一项」误显示成用户选择。
	const normalized = items.map((item) =>
		cancelled
			? { ...item, answered: false, answer: null, answerLabel: undefined }
			: item,
	);
	const [first] = normalized;
	const summary: AskQuestionResultSummary = {
		...first,
		cancelled,
	};
	// 输入是批量（有 questions/answers 数组）时始终暴露 questions，
	// 单题批量也走同一渲染分支，避免「单题时 questions 缺省」的渲染分叉。
	const wasBatch = Array.isArray(value.questions) || Array.isArray(value.answers);
	if (wasBatch || normalized.length > 1) summary.questions = normalized;
	return summary;
}

/** 从 ChatMessage 读取已规范化的问答结果；无 _askCard 或损坏时返回 undefined。 */
export function getAskQuestionResultFromMessage(
	message: Pick<ChatMessage, "meta">,
): AskQuestionResultSummary | undefined {
	const meta = message.meta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	return normalizeAskQuestionResultSummary(Reflect.get(meta, "_askCard"));
}

/* ────────────────────────────────────────────────────────────────
 * 待回答的 batch_ask 表单（AgentUiBatchQuestion）规范化
 *
 * 实时链路里 batchQuestions 由 pi 扩展（PiDeck-Q-Ask-Question）构造，
 * 但 Web/飞书轮询路径上它们是跨进程 JSON（SessionRuntimeCoordinator 收到
 * 的 event.payload 是 unknown），坏数据会一路传到渲染层。渲染层
 * （SessionRuntimeUiOverlay）直接读 option.label / option.description，
 * options: [null] 这类脏数据就会崩掉整张批量卡。
 * 这里在 coordinator 边界统一收窄：非法条目丢弃，选项里非法项过滤。
 * ──────────────────────────────────────────────────────────────── */

/** batch 选项：字符串或 { label, value?, description? }；label 必须非空。 */
function normalizeBatchOption(value: unknown): string | { label: string; value?: string; description?: string } | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (isRecord(value)) {
		const label = value.label;
		if (typeof label !== "string" || label.length === 0) return undefined;
		const option: { label: string; value?: string; description?: string } = { label };
		if (typeof value.value === "string" && value.value) option.value = value.value;
		if (typeof value.description === "string" && value.description) {
			option.description = value.description;
		}
		return option;
	}
	return undefined;
}

/**
 * 把一条 unknown 的批量问题收窄为 AgentUiBatchQuestion。
 * id / question / type 是渲染硬依赖（选项定位、页码、控件形态），
 * 缺任一即整题丢弃；options 等次要字段过滤到合法子集。
 * @returns undefined 表示「不是有效问题」，调用方直接过滤掉。
 */
export function normalizeAgentUiBatchQuestion(raw: unknown): AgentUiBatchQuestion | undefined {
	if (!isRecord(raw)) return undefined;
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : "";
	const question = typeof raw.question === "string" && raw.question.trim() ? raw.question : "";
	const type = normalizeType(raw.type);
	if (!id || !question || !type) return undefined;
	const batchQuestion: AgentUiBatchQuestion = { id, type, question };
	if (Array.isArray(raw.options)) {
		const options: AgentUiBatchQuestion["options"] = [];
		for (const entry of raw.options) {
			const option = normalizeBatchOption(entry);
			if (option !== undefined) options.push(option);
		}
		if (options.length > 0) batchQuestion.options = options;
	}
	if (raw.allowOther === true) batchQuestion.allowOther = true;
	if (typeof raw.placeholder === "string" && raw.placeholder) batchQuestion.placeholder = raw.placeholder;
	if (typeof raw.prefill === "string" && raw.prefill) batchQuestion.prefill = raw.prefill;
	return batchQuestion;
}
