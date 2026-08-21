import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldCloseSessionTabAfterStop } = loadTsCommonJs(
	"src/renderer/src/utils/canStopBoundAgent.ts",
);

test("session chrome only closes the tab after a real stop", () => {
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: false,
		hasRuntimeTarget: true,
		stopSucceeded: true,
	}), true);
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: true,
		hasRuntimeTarget: true,
		stopSucceeded: true,
	}), false);
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: false,
		hasRuntimeTarget: false,
		stopSucceeded: true,
	}), false);
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: false,
		hasRuntimeTarget: true,
		stopSucceeded: false,
	}), false);
});

test("closeAgent surfaces pending and missing-target failures instead of returning quietly", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /if \(isPendingAgentId\(agentId\)\) \{\s*throw new Error\(t\("sessionCommand\.runtimeBusy"\)\);/);
	assert.match(app, /if \(!target\) \{\s*throw new Error\(t\("sessionCommand\.runtimeUnavailable"\)\);/);
	assert.match(app, /await closeAgent\(activeAgentId\);\s*if \(sessionId\) workspaceChrome\.closeTab\(sessionId\);/);
});
