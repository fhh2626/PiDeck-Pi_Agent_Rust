/**
 * 模型规格索引与匹配（纯函数，无 IO，可单测）。
 *
 * 匹配语义：按「模型 id」匹配，与用户走什么中转站 baseUrl 无关。
 * 两源互补：OpenRouter 提供 context window / max tokens；models.dev 提供
 * 推理 / 工具调用 / 视觉等能力（models.dev 无 context window）。
 */

import type { ModelSpec } from "../../shared/types/modelSpecs";

/** 内置已知厂商前缀：剥离 model id 的厂商前缀时只认这些名字，防止误剥用户自定义 id */
const KNOWN_PROVIDER_ALIASES = new Set([
	"anthropic", "openai", "google", "deepseek", "zhipuai", "moonshotai", "moonshot",
	"minimax", "alibaba", "qwen", "meta", "mistralai", "mistral", "xai", "grok",
	"groq", "cerebras", "togetherai", "together", "cohere", "perplexity", "amazon",
	"bedrock", "azure", "baidu", "ernie", "tencent", "doubao", "volcengine",
	"kimi", "glm", "01-ai", "deepinfra", "fireworks", "novita", "siliconflow",
	"huggingface", "ollama", "lmstudio", "openrouter", "nvidia", "sakana",
	"upstage", "yi", "stepfun", "lingyi", "internlm", "baichuan", "spark",
]);

/** OpenRouter 条目（裁剪后的最小字段集） */
export type OpenRouterSpecEntry = {
	id: string;
	contextWindow: number;
	maxTokens?: number;
	inputModalities: string[];
};

/** models.dev 条目（按 provider 展开）；builtin 补充表同构，可携带 context/maxTokens（models.dev 本身无此数据） */
export type ModelsDevSpecEntry = {
	provider: string;
	id: string;
	/** 数据源：builtin 为官方手工补充表（权威），合并能力位时直接覆盖 */
	source?: "models-dev" | "builtin";
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	toolCall?: boolean;
	attachment?: boolean;
	inputModalities: string[];
};

export type ModelSpecIndex = {
	openrouterById: Map<string, OpenRouterSpecEntry>;
	/** openrouter id 尾段（去厂商前缀，如 gpt-4o）→ 条目列表 */
	openrouterByTail: Map<string, OpenRouterSpecEntry[]>;
	/** openrouter id 小写别名：官方模型卡常为驼峰（moonshotai/Kimi-K3），OpenRouter 源全小写，
	 *  查询时大小写不敏感兜底，避免大写完整 id 只命中 models.dev（无 context）导致上下文丢失 */
	openrouterByIdLower: Map<string, OpenRouterSpecEntry>;
	openrouterByTailLower: Map<string, OpenRouterSpecEntry[]>;
	/** models.dev 模型 id → 合并条目（跨厂商同名 OR 合并能力） */
	modelsDevById: Map<string, ModelsDevSpecEntry>;
	/** models.dev id 小写别名（与 openrouterByIdLower 同理） */
	modelsDevByIdLower: Map<string, ModelsDevSpecEntry>;
	/** contains 匹配列表：按 id 长度降序（openrouter），查询兜底用 */
	openrouterContains: OpenRouterSpecEntry[];
	/** contains 匹配列表：按 id 长度降序（models.dev + builtin），查询兜底用 */
	modelsDevContains: ModelsDevSpecEntry[];
	/** 已知厂商名（内置别名 ∪ models.dev providers ∪ openrouter 前缀），剥前缀用 */
	knownProviders: Set<string>;
};

/** 小写别名写入：大小写变体同源（如 moonshotai/kimi-k3 与 moonshotai/Kimi-K3），
 *  优先保留带 contextWindow 的条目（能力位通常两变体一致） */
function putLowerEntry<T extends { contextWindow?: number }>(
	map: Map<string, T>,
	key: string,
	entry: T,
) {
	const existing = map.get(key);
	if (!existing || (existing.contextWindow == null && entry.contextWindow != null)) {
		map.set(key, entry);
	}
}

/** contains 匹配列表：按 id 长度降序；查询时取第一个命中即最长 id（歧义最小） */
function buildContainsList<T extends { id: string }>(entries: T[]): T[] {
	return [...entries].sort((a, b) => b.id.length - a.id.length);
}

/** 包含匹配：needle 与 id 双向 contains（大小写不敏感）。
 *  语义：用户手填的字符串只要包含某已知 id（或反之），即视为匹配，
 *  用于带版本后缀/前缀变体（如 kimi-k3-2025）或厂商拼写差异时的兜底 */
function findLongestContains<T extends { id: string }>(
	list: T[],
	needleLower: string,
): T | undefined {
	if (!needleLower) return undefined;
	for (const entry of list) {
		const idLower = entry.id.toLowerCase();
		if (idLower.includes(needleLower) || needleLower.includes(idLower)) return entry;
	}
	return undefined;
}

/** 构建查询索引（纯函数，可单测） */
export function buildSpecIndex(
	openrouter: OpenRouterSpecEntry[],
	modelsDev: ModelsDevSpecEntry[],
): ModelSpecIndex {
	const openrouterById = new Map<string, OpenRouterSpecEntry>();
	const openrouterByTail = new Map<string, OpenRouterSpecEntry[]>();
	const openrouterByIdLower = new Map<string, OpenRouterSpecEntry>();
	const openrouterByTailLower = new Map<string, OpenRouterSpecEntry[]>();
	for (const entry of openrouter) {
		openrouterById.set(entry.id, entry);
		putLowerEntry(openrouterByIdLower, entry.id.toLowerCase(), entry);
		const slash = entry.id.lastIndexOf("/");
		const tail = slash >= 0 ? entry.id.slice(slash + 1) : entry.id;
		const list = openrouterByTail.get(tail) ?? [];
		list.push(entry);
		openrouterByTail.set(tail, list);
		const listLower = openrouterByTailLower.get(tail.toLowerCase()) ?? [];
		listLower.push(entry);
		openrouterByTailLower.set(tail.toLowerCase(), listLower);
	}
	const modelsDevById = new Map<string, ModelsDevSpecEntry>();
	const modelsDevByIdLower = new Map<string, ModelsDevSpecEntry>();
	// 附件能力共识统计：跨厂商同名时「图片支持」需要共识——显式 false 一票否决；
	// true 需 ≥2 家声明才成立（frogbot 式单家声明不可信）；builtin 官方卡为权威直接覆盖。
	// 同时按原始 id 与小写 id 计数，供大小写变体合并分支共用
	const attachmentTrueCount = new Map<string, number>();
	const attachmentFalseCount = new Map<string, number>();
	const countAttachment = (key: string, entry: ModelsDevSpecEntry) => {
		if (entry.attachment === true) {
			attachmentTrueCount.set(key, (attachmentTrueCount.get(key) ?? 0) + 1);
		} else if (entry.attachment === false) {
			attachmentFalseCount.set(key, (attachmentFalseCount.get(key) ?? 0) + 1);
		}
	};
	for (const entry of modelsDev) {
		countAttachment(entry.id, entry);
		countAttachment(entry.id.toLowerCase(), entry);
	}
	for (const entry of modelsDev) {
		const merged = modelsDevById.get(entry.id);
		if (!merged) {
			modelsDevById.set(entry.id, { ...entry });
		} else {
			// 跨厂商同名（如多家托管 deepseek-r1）：reasoning/toolCall 取 OR；
			// 附件能力：builtin 官方卡权威覆盖；否则 false 一票否决 / true 需 ≥2 家共识，
			// 单家声明（frogbot 式）不采信——避免少数派厂商把纯文本模型带成图片模型；
			// context/maxTokens 非空优先——builtin 补充表与 models.dev 同名（如 k3-256k）时，
			// 后者无上下文，必须保留 builtin 的官方值，否则补全时上下文丢失
			merged.contextWindow = merged.contextWindow ?? entry.contextWindow;
			merged.maxTokens = merged.maxTokens ?? entry.maxTokens;
			merged.reasoning = merged.reasoning || entry.reasoning;
			merged.toolCall = merged.toolCall || entry.toolCall;
			merged.attachment =
				entry.source === "builtin"
					? entry.attachment
					: (attachmentFalseCount.get(entry.id) ?? 0) > 0
						? false
						: (attachmentTrueCount.get(entry.id) ?? 0) >= 2
							? true
							: undefined;
			merged.inputModalities = [
				...new Set([...merged.inputModalities, ...entry.inputModalities]),
			];
			// 模态与附件能力保持一致：attachment 非 true（保守合并）时剔除 image/video，
			// 避免输入模态悄悄声明图片但能力位不支持（或反之被少数派带偏）
			if (merged.attachment !== true) {
				merged.inputModalities = merged.inputModalities.filter(
					(m) => m !== "image" && m !== "video",
				);
			}
		}
		// 小写别名：大小写变体（官方驼峰卡 vs 厂商小写）合并能力，context 取非空者
		const lower = entry.id.toLowerCase();
		const lowerMerged = modelsDevByIdLower.get(lower);
		if (!lowerMerged) {
			modelsDevByIdLower.set(lower, { ...entry });
		} else {
			lowerMerged.contextWindow = lowerMerged.contextWindow ?? entry.contextWindow;
			lowerMerged.maxTokens = lowerMerged.maxTokens ?? entry.maxTokens;
			lowerMerged.reasoning = lowerMerged.reasoning || entry.reasoning;
			lowerMerged.toolCall = lowerMerged.toolCall || entry.toolCall;
			// 与 modelsDevById 合并一致：builtin 权威覆盖 / false 否决 / true ≥2 家共识
			lowerMerged.attachment =
				entry.source === "builtin"
					? entry.attachment
					: (attachmentFalseCount.get(lower) ?? 0) > 0
						? false
						: (attachmentTrueCount.get(lower) ?? 0) >= 2
							? true
							: undefined;
			lowerMerged.inputModalities = [
				...new Set([...lowerMerged.inputModalities, ...entry.inputModalities]),
			];
			if (lowerMerged.attachment !== true) {
				lowerMerged.inputModalities = lowerMerged.inputModalities.filter(
					(m) => m !== "image" && m !== "video",
				);
			}
		}
	}
	const knownProviders = new Set(KNOWN_PROVIDER_ALIASES);
	for (const entry of modelsDev) knownProviders.add(entry.provider);
	for (const id of openrouterById.keys()) {
		const slash = id.indexOf("/");
		if (slash > 0) knownProviders.add(id.slice(0, slash));
	}
	return {
		openrouterById,
		openrouterByTail,
		openrouterByIdLower,
		openrouterByTailLower,
		modelsDevById,
		modelsDevByIdLower,
		openrouterContains: buildContainsList(openrouter),
		// contains 兜底必须基于合并后的条目：原始 rows 里的少数派行（如 frogbot 的
		// deepseek-v4-pro attachment=true）会按行序不稳定地命中，重新污染图片能力
		modelsDevContains: buildContainsList([...modelsDevById.values()]),
		knownProviders,
	};
}

/** 剥离厂商前缀：仅当前缀是已知厂商名才剥（防止误剥 "myrelay/model" 这类自定义前缀） */
export function stripProviderPrefix(id: string, knownProviders: Set<string>): string {
	const slash = id.indexOf("/");
	if (slash <= 0) return id;
	const prefix = id.slice(0, slash);
	return knownProviders.has(prefix) ? id.slice(slash + 1) : id;
}

/**
 * 查询模型规格（纯函数）。匹配顺序：
 * 1. openrouter 完整 id（provider/model 或裸 id）
 * 2. openrouter 尾段（用户填 gpt-4o → openai/gpt-4o；中转站场景的核心路径）
 * 3. models.dev 裸 id（先剥已知厂商前缀，再试原样）
 * 两源命中任一即合并返回（openrouter 提供 context/maxTokens，models.dev 补能力）。
 */
export function lookupModelSpec(
	index: ModelSpecIndex,
	providerName: string,
	modelId: string,
): ModelSpec | undefined {
	const trimmed = modelId.trim();
	if (!trimmed) return undefined;
	const orEntry =
		index.openrouterById.get(`${providerName}/${trimmed}`) ??
		index.openrouterById.get(trimmed) ??
		// 大小写不敏感兜底：官方模型卡常为驼峰（moonshotai/Kimi-K3），OpenRouter 源全小写，
		// 精确匹配不到时按小写别名命中，避免上下文/输出上限丢失
		index.openrouterByIdLower.get(trimmed.toLowerCase());
	let orTailEntry: OpenRouterSpecEntry | undefined;
	if (!orEntry && !trimmed.includes("/")) {
		// 尾段匹配取第一个；同尾段多条目通常只是厂商前缀不同，模型相同
		orTailEntry =
			index.openrouterByTail.get(trimmed)?.[0] ??
			index.openrouterByTailLower.get(trimmed.toLowerCase())?.[0];
	}
	const mdId = stripProviderPrefix(trimmed, index.knownProviders);
	const mdEntry =
		index.modelsDevById.get(mdId) ??
		index.modelsDevById.get(trimmed) ??
		// 小写别名：驼峰/小写变体（moonshotai/Kimi-K3 vs kimi-k3）统一命中
		index.modelsDevByIdLower.get(mdId.toLowerCase()) ??
		index.modelsDevByIdLower.get(trimmed.toLowerCase());
	// contains 兜底（放精确匹配之后）：字符串互相包含即匹配、大小写忽略，
	// 覆盖带版本后缀/前缀变体（kimi-k3-2025）等手填场景；列表按 id 长度降序取最长命中
	const trimmedLower = trimmed.toLowerCase();
	const orContains =
		findLongestContains(index.openrouterContains, trimmedLower) ??
		findLongestContains(index.openrouterContains, `${providerName}/${trimmed}`.toLowerCase());
	const mdContains =
		findLongestContains(index.modelsDevContains, mdId.toLowerCase()) ??
		findLongestContains(index.modelsDevContains, trimmedLower);
	const or = orEntry ?? orTailEntry ?? orContains;
	if (!or && !mdEntry && !mdContains) return undefined;
	const spec: ModelSpec = {
		source: or ? "openrouter" : "models-dev",
		matchedId: or?.id ?? mdEntry?.id ?? mdContains?.id ?? "",
	};
	if (or?.contextWindow) spec.contextWindow = or.contextWindow;
	if (or?.maxTokens) spec.maxTokens = or.maxTokens;
	// builtin 补充表自带 context/maxTokens（官方卡来源）时同样生效
	const mdContext = mdEntry?.contextWindow ?? mdContains?.contextWindow;
	const mdMaxTokens = mdEntry?.maxTokens ?? mdContains?.maxTokens;
	if (!spec.contextWindow && mdContext) spec.contextWindow = mdContext;
	if (!spec.maxTokens && mdMaxTokens) spec.maxTokens = mdMaxTokens;
	// 图片能力：任一源声明 image 输入（models.dev 的 attachment 即图片附件）即支持
	const images =
		or?.inputModalities.includes("image") ||
		mdEntry?.inputModalities.includes("image") ||
		mdContains?.inputModalities.includes("image") ||
		mdEntry?.attachment === true ||
		mdContains?.attachment === true;
	if (images) spec.images = true;
	if (mdEntry?.reasoning === true || mdContains?.reasoning === true) spec.reasoning = true;
	return spec;
}
