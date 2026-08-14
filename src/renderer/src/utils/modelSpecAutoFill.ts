/**
 * 模型规格自动补全（issue 需求：获取模型列表后保存即补全，无需逐个失焦）。
 *
 * computeModelSpecPatches：单模型 × 规格 → 补丁列表（纯函数，可单测）。
 * collectModelSpecPatches：整个 ModelsFile 批量补全（并行查询，返回新 providers 快照）。
 *
 * 规则（与内置表 lookupModelSpec 语义对齐）：
 * - 只填空字段：contextWindow/maxTokens 为空才填、reasoning 仅在「未设置」时填 true、
 *   input 未配置且规格声明图片才填——用户手填/明确关掉的一律不覆盖。
 * - 兜底：contextWindow/maxTokens 匹配不到或官方未公开（undefined/null）时，
 *   填保守默认值（128000 / 8192），保证字段始终有值，用户可再手动改。
 */

import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { ModelItem, ModelsFile, ProviderConfig } from "../config/configTypes";

/** 兜底默认值：模型匹配不到或规格未公开时使用（与主流长上下文模型对齐，用户可手动改） */
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 8192;

/** 单模型补全 patch：返回 [字段, 值] 列表，无空字段可补时返回空数组 */
export function computeModelSpecPatches(
	model: ModelItem,
	spec: ModelSpec,
): Array<[string, unknown]> {
	const updates: Array<[string, unknown]> = [];
	// 兜底逻辑：contextWindow/maxTokens 为空一律填——优先规格值，规格缺失（未匹配/官方未公开）
	// 时用保守默认值，避免空字段导致上游（如 Web 端模型下拉）显示/校验异常
	if (model.contextWindow == null) {
		updates.push(["contextWindow", spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW]);
	}
	if (model.maxTokens == null) {
		updates.push(["maxTokens", spec.maxTokens ?? DEFAULT_MAX_TOKENS]);
	}
	// reasoning 只在「未设置」时填 true；用户明确关掉的 false 不覆盖
	if (model.reasoning === undefined && spec.reasoning === true) {
		updates.push(["reasoning", true]);
	}
	// 多模态：未配置 input 且规格声明图片输入时才填
	if (model.input == null && spec.images === true) {
		updates.push(["input", ["text", "image"]]);
	}
	return updates;
}

export type ModelSpecLookup = (providerName: string, modelId: string) => Promise<ModelSpec | null>;

/**
 * 批量补全整个 ModelsFile：遍历所有 provider 的模型，并行查规格表，
 * 有补丁的模型写回新快照。返回 { providers, filledCount }。
 * 不修改入参（补全数据由调用方决定何时写回 state / 落盘）。
 */
export async function collectModelSpecPatches(
	models: ModelsFile,
	lookup: ModelSpecLookup,
): Promise<{ providers: Record<string, ProviderConfig>; filledCount: number }> {
	const providers: Record<string, ProviderConfig> = {};
	let filledCount = 0;
	// 并行查询全部模型（规格表是本地 sql.js 内存索引，数量级为几十个 provider × 个位数模型）
	const entries = Object.entries(models.providers).flatMap(([providerName, provider]) =>
		provider.models.map((model, index) => ({ providerName, provider, model, index })),
	);
	const results = await Promise.all(
		entries.map(({ providerName, model }) =>
			model.id ? lookup(providerName, model.id).catch(() => null) : Promise.resolve(null),
		),
	);
	for (let i = 0; i < entries.length; i++) {
		const { providerName, provider, model, index } = entries[i];
		const spec = results[i];
		const existing = providers[providerName];
		if (!existing) {
			// 浅拷贝 provider，仅 models 数组会被替换，其余字段共享引用
			providers[providerName] = { ...provider, models: [...provider.models] };
		}
		// 空 id 模型无意义，跳过（不发查询、不填默认值）
		if (!model.id) continue;
		// 未匹配（null）时用空规格兜底：computeModelSpecPatches 会填保守默认值
		const fallback: ModelSpec = { source: "models-dev", matchedId: model.id };
		const updates = computeModelSpecPatches(model, spec ?? fallback);
		if (updates.length === 0) continue;
		filledCount++;
		const next = { ...model };
		for (const [field, value] of updates) next[field] = value;
		providers[providerName].models[index] = next;
	}
	return { providers, filledCount };
}
