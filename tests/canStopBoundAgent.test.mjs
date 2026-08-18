import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { canStopBoundAgent } = loadTsCommonJs("src/renderer/src/utils/canStopBoundAgent.ts");

test("interrupted error agents stay stoppable from the session chrome", () => {
	assert.equal(canStopBoundAgent("running"), true);
	assert.equal(canStopBoundAgent("idle"), true);
	assert.equal(canStopBoundAgent("error"), true);
	assert.equal(canStopBoundAgent("starting"), false);
	assert.equal(canStopBoundAgent("closed"), false);
	assert.equal(canStopBoundAgent(undefined), false);
});

test("session chrome stop gates share the error-inclusive helper", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const controller = readFileSync("src/renderer/src/hooks/useSessionRuntimeController.ts", "utf8");
	assert.match(app, /canStopBoundAgent\(activeAgent\?\.status\)/);
	assert.match(controller, /canStopBoundAgent\(activeAgent\?\.status\)/);
});
