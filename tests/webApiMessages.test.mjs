/**
 * Web 端数据转换单测：chatMessagesToUiMessages（历史 ChatMessage → useChat UIMessage）。
 * 验证：角色映射（user/assistant，其它角色兜底 assistant）、thinking 注入
 * reasoning part、正文注入 text part、空消息/无 thinking 的边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { chatMessagesToUiMessages, mergeAuthoritativeUiMessages } = loadTsCommonJs(
	"src/renderer/src/web/webApi.ts",
);

function message(overrides = {}) {
	return {
		id: "m1",
		agentId: "a1",
		role: "assistant",
		text: "hello",
		timestamp: 1,
		...overrides,
	};
}

test("maps user role to user and text part", () => {
	const result = chatMessagesToUiMessages([message({ role: "user", text: "hi" })]);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "user");
	assert.equal(result[0].parts.length, 1);
	assert.equal(result[0].parts[0].type, "text");
	assert.equal(result[0].parts[0].text, "hi");
});

test("maps assistant role to assistant and text part", () => {
	const result = chatMessagesToUiMessages([message({ role: "assistant", text: "hi" })]);
	assert.equal(result[0].role, "assistant");
	assert.equal(result[0].parts[0].type, "text");
});

test("falls back non-user roles to assistant", () => {
	for (const role of ["system", "tool", "error"]) {
		const result = chatMessagesToUiMessages([message({ role })]);
		assert.equal(result[0].role, "assistant", `role ${role} should map to assistant`);
	}
});

test("injects reasoning part before text when thinking present", () => {
	const result = chatMessagesToUiMessages([
		message({ thinking: "推理内容", text: "正文" }),
	]);
	assert.equal(result[0].parts.length, 2);
	assert.equal(result[0].parts[0].type, "reasoning");
	assert.equal(result[0].parts[0].text, "推理内容");
	assert.equal(result[0].parts[1].type, "text");
	assert.equal(result[0].parts[1].text, "正文");
});

test("omits text part when text empty", () => {
	const result = chatMessagesToUiMessages([message({ text: "" })]);
	assert.equal(result[0].parts.length, 0);
});

test("keeps stable ids from message", () => {
	const result = chatMessagesToUiMessages([message({ id: "stable-id" })]);
	assert.equal(result[0].id, "stable-id");
});

test("merges a runtime snapshot into local Web messages without duplicating local ids", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-1", role: "assistant", text: "older" }),
		message({ id: "web-user", role: "user", text: "hello" }),
		message({ id: "web-assistant", role: "assistant", text: "answer" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user", role: "user", text: "hello" }),
		message({ id: "runtime-assistant", role: "assistant", text: "answer" }),
		message({ id: "runtime-next", role: "assistant", text: "new from PC" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.map((item) => item.parts[0]?.type).join(","), "text,text,text,text");
	assert.equal(merged.map((item) => item.parts[0]?.text).join(","), "older,hello,answer,new from PC");
	assert.equal(merged[1].id, "runtime-user");
	assert.equal(merged[2].id, "runtime-assistant");
});

test("authoritative snapshots replace a stale partial assistant message", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "local-assistant", role: "assistant", text: "partial" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-assistant", role: "assistant", text: "partial answer" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "runtime-assistant");
	assert.equal(merged[0].parts[0].text, "partial answer");
});

test("runtime snapshots match the newest repeated message instead of old history", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "old-ok", role: "assistant", text: "ok" }),
		message({ id: "web-ok", role: "assistant", text: "ok" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-ok", role: "assistant", text: "ok" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].id, "old-ok");
	assert.equal(merged[1].id, "runtime-ok");
});

test("runtime tool snapshots keep their position when display text changes", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-user", role: "user", text: "inspect" }),
		message({ id: "history-assistant", role: "assistant", text: "I will inspect" }),
		message({ id: "history-tool", role: "tool", text: "✓ read", meta: { toolCallId: "call-1" } }),
		message({ id: "history-final", role: "assistant", text: "done" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user", role: "user", text: "inspect" }),
		message({ id: "runtime-assistant", role: "assistant", text: "I will inspect" }),
		message({ id: "runtime-tool", role: "tool", text: "▶ read", meta: { toolCallId: "call-1" } }),
		message({ id: "runtime-final", role: "assistant", text: "done" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(
		merged.map((item) => item.parts[0]?.text).join("\u0000"),
		["inspect", "I will inspect", "▶ read", "done"].join("\u0000"),
	);
	assert.equal(merged.length, 4);
});

test("unmatched authoritative messages are inserted by their timeline timestamp", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-first", role: "user", text: "first", timestamp: 100 }),
		message({ id: "history-last", role: "assistant", text: "last", timestamp: 300 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-first", role: "user", text: "first", timestamp: 100 }),
		message({ id: "runtime-status", role: "system", text: "retrying", timestamp: 200 }),
		message({ id: "runtime-last", role: "assistant", text: "last", timestamp: 300 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(
		merged.map((item) => item.parts[0]?.text).join("\u0000"),
		["first", "retrying", "last"].join("\u0000"),
	);
});
