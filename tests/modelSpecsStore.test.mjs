/**
 * 模型规格存储测试（ModelSpecsStore / modelSpecsIndex / 内置 db 集成）。
 *
 * 覆盖：
 * - modelSpecsIndex 纯函数：stripProviderPrefix、lookupModelSpec 的匹配链
 *   （openrouter 前缀/完整 id/尾段、models.dev 裸 id、双源合并、未命中）
 * - entriesFromRows：db 行 → 双源条目（JSON 模态解析、损坏行跳过）
 * - 集成：真实 resources/model-specs.db（sync-model-specs.mjs 产物，随 repo 提交）
 *   → sql.js 读库 → 索引 → 真实模型命中（不绑定具体数值，发版同步会更新数据）
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function compileModule(filePath, imports = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
	vm.runInNewContext(
		output,
		{ module, exports: module.exports, require: localRequire, console },
		{ filename: filePath },
	);
	return module.exports;
}

/** modelSpecsIndex：无外部依赖的纯函数模块 */
const indexMod = compileModule("src/main/pi/modelSpecsIndex.ts");

/** 构造测试用双源数据（与 sync 脚本裁剪口径一致） */
function makeFixture() {
	const openrouter = [
		{ id: "openai/gpt-4o", contextWindow: 128000, maxTokens: 16384, inputModalities: ["text", "image"] },
		{ id: "anthropic/claude-sonnet-4.5", contextWindow: 1000000, maxTokens: 64000, inputModalities: ["text", "image"] },
		{ id: "deepseek/deepseek-chat", contextWindow: 163840, maxTokens: 16000, inputModalities: ["text"] },
		// 与裸 id 少数派附件场景配套：openrouter 有完整行（纯文本 1M），models.dev 裸 id 被 frogbot 污染
		{ id: "deepseek/deepseek-v4-pro", contextWindow: 1048576, maxTokens: 393216, inputModalities: ["text"] },
		// OpenRouter 源全小写；models.dev 官方卡为驼峰（moonshotai/Kimi-K3）
		{ id: "moonshotai/kimi-k3", contextWindow: 1048576, maxTokens: undefined, inputModalities: ["text", "image", "video"] },
	];
	const modelsDev = [
		{ provider: "zhipuai", id: "glm-5", reasoning: true, toolCall: true, attachment: false, inputModalities: ["text"] },
		{ provider: "deepseek", id: "deepseek-r1", reasoning: true, toolCall: true, attachment: false, inputModalities: ["text"] },
		// 跨厂商同名：reasoning OR 合并、attachment 保守（全 true 才 true）——
		// sakana 声明不支持图片，huggingface 的图片能力不应污染合并条目
		{ provider: "sakana", id: "llama-3.3-70b", reasoning: false, toolCall: true, attachment: false, inputModalities: ["text"] },
		{ provider: "huggingface", id: "llama-3.3-70b", reasoning: true, toolCall: false, attachment: true, inputModalities: ["text", "image"] },
		// 裸 id 少数派附件（frogbot 式）：主流纯文本 + 一家图片 → 合并后应无图片
		{ provider: "opencode-go", id: "deepseek-v4-pro", reasoning: true, toolCall: true, attachment: false, inputModalities: ["text"] },
		{ provider: "frogbot", id: "deepseek-v4-pro", reasoning: null, toolCall: true, attachment: true, inputModalities: ["text", "image"] },
		// Kimi K3：OpenRouter 源小写、models.dev 官方卡驼峰（无 context）——大小写变体场景
		{ provider: "moonshotai-cn", id: "moonshotai/Kimi-K3", reasoning: true, toolCall: true, attachment: true, inputModalities: ["text", "image", "video"] },
		{ provider: "kimi-for-coding", id: "k3-256k", reasoning: true, toolCall: true, attachment: true, inputModalities: ["text", "image"] },
	];
	return { openrouter, modelsDev };
}

test("stripProviderPrefix: 已知厂商前缀剥除，自定义前缀保留", () => {
	const known = new Set(["openai", "deepseek"]);
	assert.equal(indexMod.stripProviderPrefix("openai/gpt-4o", known), "gpt-4o");
	assert.equal(indexMod.stripProviderPrefix("deepseek/deepseek-chat", known), "deepseek-chat");
	// 自定义中转站前缀不在已知集合 → 不剥（防误剥 "myrelay/model"）
	assert.equal(indexMod.stripProviderPrefix("myrelay/gpt-4o", known), "myrelay/gpt-4o");
	assert.equal(indexMod.stripProviderPrefix("gpt-4o", known), "gpt-4o");
});

test("lookupModelSpec: openrouter 完整 id / provider 前缀 / 尾段三种命中路径", () => {
	const { openrouter, modelsDev } = makeFixture();
	const index = indexMod.buildSpecIndex(openrouter, modelsDev);
	// 1. 完整 id（用户直接填 openai/gpt-4o）
	let spec = indexMod.lookupModelSpec(index, "anything", "openai/gpt-4o");
	assert.equal(spec?.source, "openrouter");
	assert.equal(spec?.contextWindow, 128000);
	assert.equal(spec?.maxTokens, 16384);
	// 2. provider 名恰好是厂商名
	spec = indexMod.lookupModelSpec(index, "deepseek", "deepseek-chat");
	assert.equal(spec?.contextWindow, 163840);
	// 3. 中转站场景：自定义 provider 名 + 裸 id → 尾段匹配
	spec = indexMod.lookupModelSpec(index, "myrelay", "gpt-4o");
	assert.equal(spec?.source, "openrouter");
	assert.equal(spec?.matchedId, "openai/gpt-4o");
	assert.equal(spec?.contextWindow, 128000);
});

test("lookupModelSpec: models.dev 裸 id 命中（中转站 + 官方厂商名都行）", () => {
	const { openrouter, modelsDev } = makeFixture();
	const index = indexMod.buildSpecIndex(openrouter, modelsDev);
	// 中转站 provider + 裸 id（glm-5 在 openrouter 无对应 → 走 models.dev）
	const spec = indexMod.lookupModelSpec(index, "myrelay", "glm-5");
	assert.equal(spec?.source, "models-dev");
	assert.equal(spec?.matchedId, "glm-5");
	assert.equal(spec?.reasoning, true);
});

test("lookupModelSpec: 双源合并（openrouter 补 context，models.dev 补能力）", () => {
	const { openrouter, modelsDev } = makeFixture();
	const index = indexMod.buildSpecIndex(openrouter, modelsDev);
	// gpt-4o 只在 openrouter：images 来自 openrouter 模态
	const spec = indexMod.lookupModelSpec(index, "myrelay", "gpt-4o");
	assert.equal(spec?.images, true);
	// 跨厂商同名（llama-3.3-70b）：reasoning OR、attachment 保守 AND（sakana 不支持图片 → 无图片）
	const llama = indexMod.lookupModelSpec(index, "myrelay", "llama-3.3-70b");
	assert.equal(llama?.source, "models-dev");
	assert.equal(llama?.reasoning, true);
	assert.equal(llama?.images, undefined); // sakana 显式 false 一票否决，图片未声明（undefined=不支持）
	// 裸 id 少数派附件（frogbot 式）：主流纯文本 + 一家图片 → 合并后无图片（undefined=未声明）
	const v4pro = indexMod.lookupModelSpec(index, "myrelay", "deepseek-v4-pro");
	assert.equal(v4pro?.reasoning, true);
	assert.equal(v4pro?.images, undefined); // 少数派 frogbot 的图片能力不污染主流纯文本
});

test("lookupModelSpec: builtin 补充模型（sensenova-6.7-flash-lite）裸 id 命中且能力齐全", () => {
	const { openrouter, modelsDev } = storeMod.entriesFromRows([
		{ source: "builtin", provider: "sensenova", id: "sensenova-6.7-flash-lite", contextWindow: null, maxTokens: null, reasoning: 1, toolCall: 1, attachment: 1, inputModalities: '["text","image"]' },
	]);
	const index = indexMod.buildSpecIndex(openrouter, modelsDev);
	// 官方 provider 名直接命中
	const direct = indexMod.lookupModelSpec(index, "sensenova", "sensenova-6.7-flash-lite");
	assert.ok(direct, "sensenova 官方 provider 应命中");
	assert.equal(direct.reasoning, true);
	assert.equal(direct.images, true);
	// 自定义中转站 provider + 裸 id 同样命中
	const viaRelay = indexMod.lookupModelSpec(index, "myrelay", "sensenova-6.7-flash-lite");
	assert.ok(viaRelay, "中转站 provider 应命中");
	assert.equal(viaRelay.images, true);
	// context 未公开 → 不填，避免误导
	assert.equal(direct.contextWindow, undefined);
});

test("lookupModelSpec: 未命中返回 undefined（空 id / 未知模型）", () => {
	const { openrouter, modelsDev } = makeFixture();
	const index = indexMod.buildSpecIndex(openrouter, modelsDev);
	assert.equal(indexMod.lookupModelSpec(index, "myrelay", "gpt-9999"), undefined);
	assert.equal(indexMod.lookupModelSpec(index, "myrelay", "  "), undefined);
	assert.equal(indexMod.lookupModelSpec(index, "myrelay", ""), undefined);
});

test("lookupModelSpec: models.dev 条目缺能力字段时不下发 false（保持 undefined）", () => {
	const index = indexMod.buildSpecIndex([], [
		{ provider: "foo", id: "plain-model", reasoning: false, toolCall: false, attachment: false, inputModalities: ["text"] },
	]);
	// 能力「不支持」≠「已设置」：reasoning/images 都应保持 undefined，避免误填覆盖用户配置
	const spec = indexMod.lookupModelSpec(index, "myrelay", "plain-model");
	assert.equal(spec?.reasoning, undefined);
	assert.equal(spec?.images, undefined);
});

	test("lookupModelSpec: 大小写不敏感兜底（官方驼峰卡命中 openrouter 上下文）", () => {
		const { openrouter, modelsDev } = makeFixture();
		const index = indexMod.buildSpecIndex(openrouter, modelsDev);
		// 官方大写完整 id（moonshotai/Kimi-K3）：openrouter 只有小写 → lower 兜底命中 1M 上下文
		const spec = indexMod.lookupModelSpec(index, "moonshotai", "moonshotai/Kimi-K3");
		assert.equal(spec?.source, "openrouter");
		assert.equal(spec?.contextWindow, 1048576);
		assert.equal(spec?.reasoning, true);
		// 裸大写 id（Kimi-K3）：tail 小写兜底同样命中
		const bare = indexMod.lookupModelSpec(index, "myrelay", "Kimi-K3");
		assert.equal(bare?.source, "openrouter");
		assert.equal(bare?.contextWindow, 1048576);
	});

	test("lookupModelSpec: 自定义模型名（k3-256k）裸 id 命中 models.dev 能力位", () => {
		const { openrouter, modelsDev } = makeFixture();
		const index = indexMod.buildSpecIndex(openrouter, modelsDev);
		// k3-256k 无 openrouter 条目 → models.dev 命中（能力位），context 留空不误导
		const spec = indexMod.lookupModelSpec(index, "kimi-for-coding", "k3-256k");
		assert.equal(spec?.source, "models-dev");
		assert.equal(spec?.reasoning, true);
		assert.equal(spec?.images, true);
		assert.equal(spec?.contextWindow, undefined);
	});

	test("lookupModelSpec: contains 兜底（字符串包含即匹配，大小写忽略）", () => {
		const { openrouter, modelsDev } = makeFixture();
		const index = indexMod.buildSpecIndex(openrouter, modelsDev);
		// 带版本后缀变体：kimi-k3-2025 包含 kimi-k3 → 最长命中 openrouter 1M
		const suffixed = indexMod.lookupModelSpec(index, "myrelay", "moonshotai/kimi-k3-2025");
		assert.equal(suffixed?.source, "openrouter");
		assert.equal(suffixed?.contextWindow, 1048576);
		// 前缀变体：x-moonshotai/kimi-k3 包含完整 id（needle 包含 id 方向）
		const prefixed = indexMod.lookupModelSpec(index, "myrelay", "x-moonshotai/kimi-k3");
		assert.equal(prefixed?.contextWindow, 1048576);
		// 大小写混合的 contains：KIMI-K3 变体忽略大小写命中
		const mixedCase = indexMod.lookupModelSpec(index, "myrelay", "MOONSHOTAI/KIMI-K3");
		assert.equal(mixedCase?.contextWindow, 1048576);
		// models.dev contains 兜底：k3-256k-xxx 命中 k3-256k（能力位）
		const mdContained = indexMod.lookupModelSpec(index, "kimi-for-coding", "k3-256k-xxx");
		assert.equal(mdContained?.source, "models-dev");
		assert.equal(mdContained?.reasoning, true);
	});

// ── entriesFromRows（db 行 → 双源条目）──────────────────────────────

const storeMod = compileModule("src/main/pi/modelSpecsStore.ts", {
	electron: { app: { isPackaged: false, getAppPath: () => ROOT } },
	"./modelSpecsIndex": indexMod,
});

test("entriesFromRows: 行映射 + JSON 模态解析 + 损坏行跳过", () => {
	const { openrouter, modelsDev } = storeMod.entriesFromRows([
		{ source: "openrouter", provider: "openai", id: "openai/gpt-4o", contextWindow: 128000, maxTokens: 16384, reasoning: null, toolCall: null, attachment: null, inputModalities: '["text","image"]' },
		{ source: "openrouter", provider: "x", id: "broken/ctx", contextWindow: null, maxTokens: null, reasoning: null, toolCall: null, attachment: null, inputModalities: null },
		{ source: "models-dev", provider: "zhipuai", id: "glm-5", contextWindow: null, maxTokens: null, reasoning: 1, toolCall: 1, attachment: 0, inputModalities: "{bad json" },
		{ source: "unknown-source", provider: "x", id: "skip-me", contextWindow: 1, maxTokens: null, reasoning: null, toolCall: null, attachment: null, inputModalities: null },
	]);
	assert.equal(openrouter.length, 1);
	assert.equal(openrouter[0].contextWindow, 128000);
	// vm 跨 realm 数组 deepEqual 会因原型不同失败，逐元素断言
	assert.equal(openrouter[0].inputModalities.length, 2);
	assert.equal(openrouter[0].inputModalities[0], "text");
	assert.equal(openrouter[0].inputModalities[1], "image");
	assert.equal(modelsDev.length, 1);
	assert.equal(modelsDev[0].reasoning, true);
	// 损坏的 input_modalities JSON 降级为空数组（不抛错、不丢行）
	assert.equal(modelsDev[0].inputModalities.length, 0);
});

// ── 集成：真实 resources/model-specs.db（sync 脚本产物，随 repo 提交）──────

test("integration: 内置 db 可读且真实模型可命中（不绑定数值）", async () => {
	const dbPath = join(ROOT, "resources", "model-specs.db");
	const initSqlJs = nodeRequire("sql.js");
	const SQL = await initSqlJs({
		locateFile: (file) => join(ROOT, "node_modules", "sql.js", "dist", file),
	});
	const db = new SQL.Database(readFileSync(dbPath));

	const specRows = db.exec(
		`SELECT source, provider, id, context_window, max_tokens,
		        reasoning, tool_call, attachment, input_modalities
		 FROM model_specs`,
	);
	const rows = (specRows[0]?.values ?? []).map((row) => ({
		source: String(row[0] ?? ""),
		provider: row[1] == null ? null : String(row[1]),
		id: String(row[2] ?? ""),
		contextWindow: row[3] == null ? null : Number(row[3]),
		maxTokens: row[4] == null ? null : Number(row[4]),
		reasoning: row[5] == null ? null : Number(row[5]),
		toolCall: row[6] == null ? null : Number(row[6]),
		attachment: row[7] == null ? null : Number(row[7]),
		inputModalities: row[8] == null ? null : String(row[8]),
	}));
	const metaRows = db.exec(`SELECT key, value FROM model_specs_meta`);
	const meta = Object.fromEntries(
		(metaRows[0]?.values ?? []).map((row) => [String(row[0]), String(row[1] ?? "")]),
	);
	db.close();

	// 同步时间必须存在（发版同步的核心字段）
	assert.ok(meta.synced_at, "model_specs_meta.synced_at 应存在");
	assert.ok(meta.openrouter_count && Number(meta.openrouter_count) > 100, "openrouter 条数应 > 100");
	assert.ok(meta.models_dev_count && Number(meta.models_dev_count) > 1000, "models.dev 条数应 > 1000");

	const { openrouter, modelsDev } = storeMod.entriesFromRows(rows);
	assert.ok(openrouter.length > 100, `openrouter 行数异常: ${openrouter.length}`);
	assert.ok(modelsDev.length > 1000, `models.dev 行数异常: ${modelsDev.length}`);
	const index = indexMod.buildSpecIndex(openrouter, modelsDev);

	// 命中路径（数值会随发版同步变化，只断言类型/来源）
	const gpt4o = indexMod.lookupModelSpec(index, "openai", "gpt-4o");
	assert.ok(gpt4o?.contextWindow > 0, "gpt-4o 应有 contextWindow");
	const viaRelay = indexMod.lookupModelSpec(index, "myrelay", "gpt-4o");
	assert.ok(viaRelay?.contextWindow > 0, "中转站 provider + 裸 id 应命中");
	const deepseek = indexMod.lookupModelSpec(index, "deepseek", "deepseek-chat");
	assert.ok(deepseek?.contextWindow > 0, "deepseek-chat 应命中");
	// 纯 models.dev 模型（openrouter 无对应）
	const glm = indexMod.lookupModelSpec(index, "myrelay", "glm-5");
	assert.ok(glm?.source === "models-dev" || glm?.contextWindow, "glm-5 应命中 models.dev");
	// 内置补充表（双源未收录的国产模型）：能力位齐全，图片/推理可自动填充
	const sensenova = indexMod.lookupModelSpec(index, "sensenova", "sensenova-6.7-flash-lite");
	assert.ok(sensenova?.reasoning, "sensenova-6.7-flash-lite 应命中内置补充表（推理）");
	assert.ok(sensenova?.images, "sensenova-6.7-flash-lite 应命中内置补充表（图片）");
	assert.equal(sensenova?.contextWindow, 262144, "flash-lite 上下文应有值（256K）");
	// 商汤其他型号（V6 系列 / SenseChat 系列）
	const v6Turbo = indexMod.lookupModelSpec(index, "sensenova", "SenseNova-V6-5-Turbo");
	assert.ok(v6Turbo?.images && v6Turbo?.reasoning, "SenseNova-V6-5-Turbo 应命中（多模态推理）");
	assert.equal(v6Turbo?.contextWindow, 131072, "V6-5-Turbo 上下文 128K");
	// 阶跃星辰：主流 step-3.7-flash 走双源（models.dev 能力位），视觉模型走内置补充
	const step37 = indexMod.lookupModelSpec(index, "stepfun", "step-3.7-flash");
	assert.ok(step37?.images, "step-3.7-flash 应命中（官方原生多模态，models.dev 已标 attachment）");
	const step1o = indexMod.lookupModelSpec(index, "stepfun", "step-1o-turbo-vision");
	assert.ok(step1o?.images, "step-1o-turbo-vision 应命中内置补充表（视觉）");
	assert.equal(step1o?.contextWindow, 32768);
	// 未知模型不命中
	assert.equal(indexMod.lookupModelSpec(index, "myrelay", "definitely-not-a-model-xyz"), undefined);

	// Kimi K3：官方驼峰完整 id 应通过大小写兜底命中 openrouter 1M 上下文（不丢 context）
	const kimiCamel = indexMod.lookupModelSpec(index, "moonshotai", "moonshotai/Kimi-K3");
	assert.equal(kimiCamel?.source, "openrouter", "驼峰完整 id 应命中 openrouter（lower 兜底）");
	assert.ok(kimiCamel?.contextWindow && kimiCamel.contextWindow >= 1000000, "Kimi-K3 上下文应为 1M");
	// k3-256k：models.dev 收录能力位，内置补充表补官方 256K 上下文
	const k3 = indexMod.lookupModelSpec(index, "kimi-for-coding", "k3-256k");
	assert.ok(k3?.reasoning && k3?.images, "k3-256k 能力位应齐全");
	assert.equal(k3?.contextWindow, 262144, "k3-256k 上下文应为 256K（builtin 补充）");
	// kimi-for-coding 系列：262144
	const kfc = indexMod.lookupModelSpec(index, "kimi-for-coding", "kimi-for-coding-highspeed");
	assert.equal(kfc?.contextWindow, 262144, "kimi-for-coding-highspeed 上下文应为 256K");
});
