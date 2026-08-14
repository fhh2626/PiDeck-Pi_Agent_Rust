/**
 * 模型规格自动补全纯函数测试（utils/modelSpecAutoFill.ts）。
 *
 * 覆盖：computeModelSpecPatches 只填空字段语义（手填不覆盖、false 不覆盖、
 * 规格缺 context 填默认值、input 已配不填）；collectModelSpecPatches 批量补全
 * （并行查询、计数、不修改入参、新快照语义）。
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

/** compileModule：ts.transpileModule → vm 沙箱（与既有 harness 一致）。 */
function compileModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: nodeRequire, console }, { filename: filePath });
	return module.exports;
}

const mod = compileModule("src/renderer/src/utils/modelSpecAutoFill.ts");
const { computeModelSpecPatches, collectModelSpecPatches } = mod;

/** vm 沙箱数组原型与测试 realm 不同，deepEqual 会因引用不等失败——逐项断言 */
function assertUpdates(updates, expected) {
	assert.equal(updates.length, expected.length);
	for (let i = 0; i < expected.length; i++) {
		assert.equal(updates[i][0], expected[i][0], `字段 ${expected[i][0]}`);
		const value = updates[i][1];
		const want = expected[i][1];
		if (Array.isArray(want)) {
			assert.ok(Array.isArray(value), `${expected[i][0]} 应为数组`);
			assert.equal(value.length, want.length);
			for (let j = 0; j < want.length; j++) assert.equal(value[j], want[j]);
		} else {
			assert.equal(value, want);
		}
	}
}

function fullSpec(overrides = {}) {
	return {
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: true,
		images: true,
		source: "openrouter",
		matchedId: "openai/gpt-4o",
		...overrides,
	};
}

test("computeModelSpecPatches: 全空字段填满", () => {
	const updates = computeModelSpecPatches({ id: "gpt-4o" }, fullSpec());
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["reasoning", true],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 手填值不覆盖", () => {
	const updates = computeModelSpecPatches(
		{ id: "gpt-4o", contextWindow: 999, maxTokens: 111, input: ["text"] },
		fullSpec(),
	);
	assertUpdates(updates, [["reasoning", true]]);
});

test("computeModelSpecPatches: 用户明确关掉的 reasoning=false 不覆盖", () => {
	const updates = computeModelSpecPatches({ id: "gpt-4o", reasoning: false }, fullSpec());
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 规格缺 context/maxTokens 时保持为空", () => {
	const updates = computeModelSpecPatches(
		{ id: "sensenova-6.7-flash-lite" },
		fullSpec({ contextWindow: undefined, maxTokens: undefined }),
	);
	// reasoning + images 照常填；不能猜测未公开的模型上限。
	assertUpdates(updates, [
		["reasoning", true],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 空规格不会虚构模型上限", () => {
	const updates = computeModelSpecPatches(
		{ id: "my-custom-model" },
		{ source: "models-dev", matchedId: "my-custom-model" },
	);
	assertUpdates(updates, []);
});

test("computeModelSpecPatches: 纯文本规格不填 input", () => {
	const updates = computeModelSpecPatches({ id: "deepseek-chat" }, fullSpec({ images: undefined }));
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["reasoning", true],
	]);
});

test("computeModelSpecPatches: 非推理模型不下发 reasoning", () => {
	const updates = computeModelSpecPatches({ id: "x" }, fullSpec({ reasoning: undefined }));
	assert.equal(updates.some(([field]) => field === "reasoning"), false);
});

test("collectModelSpecPatches: 批量补全、计数、不修改入参", async () => {
	const models = {
		providers: {
			relay: {
				baseUrl: "https://relay.example",
				models: [
					{ id: "gpt-4o" },
					{ id: "filled", contextWindow: 999, reasoning: false },
					{ id: "" }, // 空 id 不查
				],
			},
			other: {
				models: [{ id: "glm-5" }],
			},
		},
	};
	const lookedUp = [];
	const { providers, filledCount } = await collectModelSpecPatches(models, async (providerName, modelId) => {
		lookedUp.push(`${providerName}:${modelId}`);
		return modelId === "gpt-4o" ? fullSpec() : modelId === "glm-5" ? fullSpec({ contextWindow: undefined }) : null;
	});
	assert.equal(filledCount, 2);
	// 查询只对非空 id 发起
	assert.deepEqual(lookedUp, ["relay:gpt-4o", "relay:filled", "other:glm-5"]);
	// 新快照：gpt-4o 全填
	assert.equal(providers.relay.models[0].contextWindow, 128000);
	assert.equal(providers.relay.models[0].input[1], "image");
	// 手填/明确关闭的保持
	assert.equal(providers.relay.models[1].contextWindow, 999);
	assert.equal(providers.relay.models[1].reasoning, false);
	// 规格未命中（null）→ 保持为空，不改变自定义模型行为
	assert.equal(providers.relay.models[1].maxTokens, undefined);
	// 空 id 模型原样保留
	assert.equal(providers.relay.models[2].id, "");
	// glm-5 能力位照常；context 无规格值时保持为空
	assert.equal(providers.other.models[0].reasoning, true);
	assert.equal(providers.other.models[0].contextWindow, undefined);
	// 入参不被修改
	assert.equal(models.providers.relay.models[0].contextWindow, undefined);
	assert.equal(models.providers.other.models[0].reasoning, undefined);
	// 非模型字段（baseUrl）共享引用不变
	assert.equal(providers.relay.baseUrl, "https://relay.example");
});

test("collectModelSpecPatches: lookup 抛错保持原模型且不阻断保存", async () => {
	const models = { providers: { a: { models: [{ id: "x" }, { id: "y" }] } } };
	const { providers, filledCount } = await collectModelSpecPatches(models, async (p, id) => {
		if (id === "x") throw new Error("boom");
		return fullSpec();
	});
	// x 查询失败保持原样；y 使用真实规格。
	assert.equal(filledCount, 1);
	assert.equal(providers.a.models[0].contextWindow, undefined);
	assert.equal(providers.a.models[1].contextWindow, 128000);
});
