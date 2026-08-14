import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseAvailableModelsResponse } = loadTsCommonJs(
	"src/main/pi/agentUtils.ts",
);

test("available models RPC failure is propagated instead of becoming an empty list", () => {
	assert.throws(
		() => parseAvailableModelsResponse({ type: "response", command: "models", success: false, error: "busy" }),
		/busy/,
	);
});

test("available models response keeps only validated model records", () => {
	const models = parseAvailableModelsResponse({
		type: "response",
		command: "models",
		success: true,
		data: {
			models: [
				{ id: "gpt-5", provider: "openai", name: "GPT-5", contextWindow: 128000 },
				{ id: "missing-provider" },
				null,
			],
		},
	});
	assert.equal(models.length, 1);
	assert.equal(models[0].id, "gpt-5");
	assert.equal(models[0].provider, "openai");
	assert.equal(models[0].contextWindow, 128000);
});
