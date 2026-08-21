import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { markWebStateFailure, markWebStateSuccess } = loadTsCommonJs("src/renderer/src/web/webConnection.ts");

test("one poll failure does not drop an established Web connection", () => {
	const next = markWebStateFailure({ connected: true, failures: 0 });
	assert.equal(next.connected, true);
	assert.equal(next.failures, 1);
});

test("three consecutive poll failures mark the Web service disconnected", () => {
	let current = { connected: true, failures: 0 };
	current = markWebStateFailure(current);
	current = markWebStateFailure(current);
	current = markWebStateFailure(current);
	assert.equal(current.connected, false);
	assert.equal(current.failures, 3);
});

test("a later successful poll immediately restores the Web connection", () => {
	const recovered = markWebStateSuccess();
	assert.equal(recovered.connected, true);
	assert.equal(recovered.failures, 0);
});

test("WebChatApp no longer treats session create errors as a disconnect", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /markWebStateFailure/);
	assert.match(app, /WEB_STATE_POLL_MS/);
	assert.doesNotMatch(
		app,
		/setCommandError\([\s\S]*?setConnected\(false\)/,
		"creating a session must not flip the LAN connection badge",
	);
});
