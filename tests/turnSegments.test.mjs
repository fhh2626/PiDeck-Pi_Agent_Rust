import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { buildTurnDisplay, hasFoldableContent } from "../src/renderer/src/components/session/timeline/buildTurnDisplay.ts";
import { buildProcessSummary } from "../src/renderer/src/components/session/timeline/segmentSummary.ts";

/**
 * 一轮回答（agent-run）扁平展示序列测试。
 *
 * 背景：旧 buildTurnSegments 把「不连续的思考/工具」拆成多个 process 折叠段，
 * 一轮回答出现多个「执行过程」汇总。buildTurnDisplay 改为扁平展示序列：
 * - process-entry（思考/工具）原位穿插，由 run 级折叠开关统一控制；
 * - interim-answer（非最后一条 assistant 文本）；
 * - final-answer（最后一条 assistant 文本，常驻）。
 * 严格按 run.items 原始时序输出，不允许重排。
 */

let seq = 0;
function assistantMessage(text, thinking, stopReason) {
	seq += 1;
	return {
		id: `a-${seq}`,
		agentId: "agent",
		role: "assistant",
		text,
		timestamp: seq,
		...(thinking ? { thinking } : {}),
		...(stopReason ? { stopReason } : {}),
	};
}

function toolMessage() {
	seq += 1;
	return {
		id: `t-${seq}`,
		agentId: "agent",
		role: "tool",
		text: "✓ read",
		timestamp: seq,
		meta: { toolName: "read", status: "done" },
	};
}

function thinkingGroup(text) {
	const message = assistantMessage("", text);
	return {
		kind: "thinking-group",
		id: `tg-${message.id}`,
		messages: [message],
		text,
		startedAt: message.timestamp,
		endedAt: message.timestamp,
	};
}

function toolGroup() {
	const message = toolMessage();
	return { kind: "tool-group", id: `tg-${message.id}`, messages: [message] };
}

function runOf(items) {
	return {
		kind: "agent-run",
		id: "run-1",
		items,
		startedAt: 1,
		endedAt: 999,
	};
}

/** 提取序列概要：[类型:内容]，便于断言顺序 */
function outline(items) {
	return items.map((item) => {
		if (item.kind === "process-entry") {
			const entry = item.entry;
			return entry.kind === "thinking-entry"
				? `think:${entry.group.text}`
				: "tool";
		}
		if (item.kind === "interim-answer") return `interim:${item.message.text}`;
		return `final:${item.message.text}`;
	});
}

test("流式中间态：扁平序列严格按真实时序，不重排", () => {
	// 真实时序：思考T1 → 回答段1 → 工具 → 思考T2（还在进行，run 未结束）
	const run = runOf([
		{ kind: "message", message: assistantMessage("段1", "T1") },
		toolGroup(),
		thinkingGroup("T2"),
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), [
		"think:T1",
		"interim:段1",
		"tool",
		"think:T2",
	]);
	// 段1 后随工具/思考条目（run 未收尾）→ 中间回复，不得提升为 final-answer
	assert.equal(items[1].kind, "interim-answer");
});

test("中断的 run（回答后还有工具调用）：回答是工具前的阶段性文本，不收尾不提升", () => {
	const run = runOf([
		{ kind: "message", message: assistantMessage("段1") },
		toolGroup(),
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["interim:段1", "tool"]);
	// 段1 后随工具条目 → 中间回复，不能常驻折叠栏外
	assert.equal(items[0].kind, "interim-answer");
});

test("steer 打断场景：中间回复（正文+工具）永不提升为最终回答", () => {
	// 真实 steer 场景：模型先输出阶段性文本（如「两个问题：…」）再调工具，
	// 用户消息打断后该 run 以工具条目收尾——文本只是工具调用前的说明。
	const run = runOf([
		{ kind: "message", message: assistantMessage("两个问题：缓存逻辑有设计缺陷…", "T1") },
		toolGroup(),
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "interim:两个问题：缓存逻辑有设计缺陷…", "tool"]);
	assert.equal(items.some((item) => item.kind === "final-answer"), false);
});

test("run 收尾条目是 assistant 才提升：工具执行后的总结照常常驻", () => {
	// 正常完成轮：工具先跑完，最后一条 assistant 是收尾条目 → 最终回答
	const run = runOf([
		toolGroup(),
		{ kind: "message", message: assistantMessage("总结", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["tool", "think:T2", "final:总结"]);
	assert.equal(items[2].kind, "final-answer");
});

test("提升稳定性：收尾判定随 run 结构变化，不会提升后又反复", () => {
	// [M1]：M1 收尾 → 提升
	const run1 = runOf([{ kind: "message", message: assistantMessage("段1") }]);
	assert.equal(buildTurnDisplay(run1, { showThinking: true })[0].kind, "final-answer");
	// [M1, T1]：M1 后随工具 → 不提升
	const run2 = runOf([
		{ kind: "message", message: assistantMessage("段1") },
		toolGroup(),
	]);
	assert.equal(buildTurnDisplay(run2, { showThinking: true })[0].kind, "interim-answer");
	// [M1, T1, M2]：M2 收尾 → 提升；M1 始终是中间回复
	const run3 = runOf([
		{ kind: "message", message: assistantMessage("段1") },
		toolGroup(),
		{ kind: "message", message: assistantMessage("段2") },
	]);
	const items3 = buildTurnDisplay(run3, { showThinking: true });
	assert.equal(items3[0].kind, "interim-answer");
	assert.equal(items3[2].kind, "final-answer");
});

test("多段回答：中间回答与最终回答正确区分，各自思考插入到文本之前", () => {
	// 真实时序：T1 → 段1 → 工具 → T2 → 段2
	const run = runOf([
		{ kind: "message", message: assistantMessage("段1", "T1") },
		toolGroup(),
		{ kind: "message", message: assistantMessage("段2", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), [
		"think:T1",
		"interim:段1",
		"tool",
		"think:T2",
		"final:段2",
	]);
	// 段1 不是最后一条 assistant → interim；段2 是最后一条 → final
	assert.equal(items[1].kind, "interim-answer");
	assert.equal(items[4].kind, "final-answer");
});

test("相邻多段回答（中间无工具）：各自思考保持「思考→回答」时序", () => {
	const run = runOf([
		{ kind: "message", message: assistantMessage("段1", "T1") },
		{ kind: "message", message: assistantMessage("段2", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), [
		"think:T1",
		"interim:段1",
		"think:T2",
		"final:段2",
	]);
});

test("流式中（isComplete=false）：所有 assistant 都归中间回答，不提前常驻", () => {
	// 真实流式场景：run 尚未结束（agent 忙碌），当前最后一条 assistant
	// 不能判定为最终回答——否则会常驻在折叠栏外（用户反馈的 bug）。
	const run = runOf([
		{ kind: "message", message: assistantMessage("段1", "T1") },
		toolGroup(),
		{ kind: "message", message: assistantMessage("段2", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true, isComplete: false });
	assert.deepEqual(outline(items), [
		"think:T1",
		"interim:段1",
		"tool",
		"think:T2",
		"interim:段2",
	]);
	// 即使最后一条也不得标记为 final-answer（流式中无法判断）
	assert.equal(items[4].kind, "interim-answer");
});

test("完整轮次：最终回答的思考插到其前，顺序保持", () => {
	const run = runOf([
		thinkingGroup("T1"),
		toolGroup(),
		{ kind: "message", message: assistantMessage("回答", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), [
		"think:T1",
		"tool",
		"think:T2",
		"final:回答",
	]);
});

test("showThinking 关闭时不展开消息自带思考，但已有 thinking-group 仍保留", () => {
	const run = runOf([
		thinkingGroup("T1"),
		{ kind: "message", message: assistantMessage("段1", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: false });
	assert.deepEqual(outline(items), ["think:T1", "final:段1"]);
});

test("无 assistant 消息的 run：全部归入过程步骤", () => {
	const run = runOf([thinkingGroup("T1"), toolGroup()]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "tool"]);
});

test("过程步骤使用稳定 id（流式重渲染不重置展开状态）", () => {
	const message = assistantMessage("段1", "T1");
	const run = runOf([{ kind: "message", message }]);
	const first = buildTurnDisplay(run, { showThinking: true });
	const second = buildTurnDisplay(run, { showThinking: true });
	const firstThinking = first[0];
	const secondThinking = second[0];
	assert.equal(firstThinking.kind, "process-entry");
	assert.equal(secondThinking.kind, "process-entry");
	assert.equal(firstThinking.entry.id, secondThinking.entry.id);
});

/* ── groupToolMessages：连续 assistant 消息不再合并（多段回答原位平铺，issue #130） ── */

function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") return { formatFilePathRef: (p) => p };
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

test("groupToolMessages 不合并连续 assistant 消息：多段回答各自独立、顺序保持", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "段1", thinking: "T1", timestamp: 2 };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "段2", thinking: "T2", timestamp: 3 };
	const rendered = groupToolMessages([user, a1, a2]);
	const run = rendered.find((item) => item.kind === "agent-run");
	assert.ok(run, "should produce one agent-run");
	const texts = run.items
		.filter((item) => item.kind === "message")
		.map((item) => item.message.text);
	// vm 沙箱跨 realm 的数组与 Node 侧 Array 原型不同，deepEqual 会误判，统一走 JSON 比较
	assert.equal(JSON.stringify(texts), JSON.stringify(["段1", "段2"]));
	// 合并会把 T1/T2 串接到同一条消息上导致思考上移；不合并时各自保留在各自消息里
	assert.equal(run.items[0].message.thinking, "T1");
	assert.equal(run.items[1].message.thinking, "T2");
});

test("groupToolMessages keeps a compaction card after the preceding assistant run", () => {
	const { groupToolMessages } = loadAppUtils();
	const messages = [
		{ id: "u1", agentId: "a", role: "user", text: "问题 1", timestamp: 1 },
		{ id: "a1", agentId: "a", role: "assistant", text: "回答 1", timestamp: 2 },
		{ id: "summary", agentId: "a", role: "system", text: "摘要", timestamp: 3, meta: { type: "compaction" } },
		{ id: "u2", agentId: "a", role: "user", text: "问题 2", timestamp: 4 },
		{ id: "a2", agentId: "a", role: "assistant", text: "回答 2", timestamp: 5 },
	];
	const rendered = groupToolMessages(messages);
	const outline = rendered.map((item) => item.kind === "agent-run"
		? item.items.filter((child) => child.kind === "message").map((child) => child.message.text).join("/")
		: item.message?.text ?? item.kind);
	assert.equal(JSON.stringify(outline), JSON.stringify(["问题 1", "回答 1", "摘要", "问题 2", "回答 2"]));
});

/* ── stopReason 协议信号判定（2026-08 升级）──
 * pi RPC message_end 携带 provider 归一化 stopReason：
 * stop=最终回复 / toolUse=中间回复（工具调用回合）/ pending=message_start 占位。
 * 渲染层优先用协议信号（message_end 即确定、永不反复），无字段时回退启发式。 */


test("stopReason=stop：steer 排队后模型回应，stop 消息提升、此前 toolUse 中间回复不提升", () => {
	// 真实 steer 场景（抓取验证）：中间回复(toolUse) → 工具 → 用户 steer → stop 回应
	const run = runOf([
		{ kind: "message", message: assistantMessage("中间回复", undefined, "toolUse") },
		toolGroup(),
		{ kind: "message", message: assistantMessage("最终总结", undefined, "stop") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["interim:中间回复", "tool", "final:最终总结"]);
	assert.equal(items[0].kind, "interim-answer");
	assert.equal(items[2].kind, "final-answer");
});

test("stopReason=toolUse：即使它是 run 最后一条 assistant，也永不提升为最终回答", () => {
	// 关键新行为：协议信号优先于「最后一条 + 收尾条目」启发式。
	// 纯工具回合（空文本）与带文本中间回复的 stopReason 都是 toolUse。
	const runWithText = runOf([
		{ kind: "message", message: assistantMessage("我查一下", undefined, "toolUse") },
	]);
	const items = buildTurnDisplay(runWithText, { showThinking: true });
	assert.equal(items[0].kind, "interim-answer");

	// 空文本纯工具回合：同样不提升（旧启发式会把空骨架提升为空 final）
	const runEmpty = runOf([
		{ kind: "message", message: assistantMessage("", undefined, "toolUse") },
	]);
	const itemsEmpty = buildTurnDisplay(runEmpty, { showThinking: true });
	assert.equal(itemsEmpty[0].kind, "interim-answer");
});

test("stopReason=aborted/error/length：一律中间回答，不常驻", () => {
	// pending 是骨架占位残留：单独用例验证回退行为（收尾可提升、后随工具不提升）。
	for (const reason of ["aborted", "error", "length"]) {
		const run = runOf([
			{ kind: "message", message: assistantMessage("被打断的文本", undefined, reason) },
		]);
		const items = buildTurnDisplay(run, { showThinking: true });
		assert.equal(
			items[0].kind,
			"interim-answer",
			`stopReason=${reason} 不应提升为 final-answer`,
		);
	}
});

test("stopReason 缺失（旧数据）：回退「最后一条 assistant 且收尾」启发式", () => {
	// 无字段消息保持旧行为：收尾提升、后随工具不提升
	const runTail = runOf([{ kind: "message", message: assistantMessage("旧总结") }]);
	assert.equal(buildTurnDisplay(runTail, { showThinking: true })[0].kind, "final-answer");
	const runMid = runOf([
		{ kind: "message", message: assistantMessage("旧中间回复") },
		toolGroup(),
	]);
	assert.equal(buildTurnDisplay(runMid, { showThinking: true })[0].kind, "interim-answer");
});

test("流式中（isComplete=false）：stopReason=stop 的消息也暂不提升（run 未结束不可定论）", () => {
	// 流式中 run 未收尾：即使某条消息 stopReason=stop（如工具回合的临时结束），
	// 也不能提前常驻——最终回答资格必须等 run 结束确认。
	const run = runOf([
		{ kind: "message", message: assistantMessage("中间回复", undefined, "toolUse") },
		{ kind: "message", message: assistantMessage("暂时结尾", undefined, "stop") },
	]);
	const items = buildTurnDisplay(run, { isComplete: false, showThinking: true });
	assert.equal(items[0].kind, "interim-answer");
	assert.equal(items[1].kind, "interim-answer");
});

test("stopReason=pending 残留（message_end 缺字段的降级路径）：视为无字段，回退启发式", () => {
	// 主进程骨架不持久化 pending 后，历史旧数据仍可能带 pending（旧版本 pi 落盘）；
	// 渲染层把 pending 当无字段处理：收尾消息可提升、后随工具不提升。
	const runTail = runOf([
		{ kind: "message", message: assistantMessage("旧总结", undefined, "pending") },
	]);
	assert.equal(buildTurnDisplay(runTail, { showThinking: true })[0].kind, "final-answer");
	const runMid = runOf([
		{ kind: "message", message: assistantMessage("旧中间回复", undefined, "pending") },
		toolGroup(),
	]);
	assert.equal(buildTurnDisplay(runMid, { showThinking: true })[0].kind, "interim-answer");
});

test("stopReason=stop 但非最后一条 assistant：不提升（位置守卫，防御异常数据）", () => {
	// 异常数据防御：stop 消息后仍有条目时按中间回复处理，保证每 run 至多一个 final-answer。
	const runMid = runOf([
		{ kind: "message", message: assistantMessage("不该提升", undefined, "stop") },
		toolGroup(),
	]);
	const items = buildTurnDisplay(runMid, { showThinking: true });
	assert.equal(items[0].kind, "interim-answer");

	// 多个 stop：只有最后一条 assistant 提升（不变量：每 run 至多一个 final）
	const runDouble = runOf([
		{ kind: "message", message: assistantMessage("段1", undefined, "stop") },
		{ kind: "message", message: assistantMessage("段2", undefined, "stop") },
	]);
	const itemsDouble = buildTurnDisplay(runDouble, { showThinking: true });
	assert.equal(itemsDouble[0].kind, "interim-answer");
	assert.equal(itemsDouble[1].kind, "final-answer");
});

test("空文本中间回复（error 占位/live 挂载点）不计入折叠汇总", () => {
	// 真实场景（用户反馈截图）：连续 error 空消息 + 1 段有文本中间回复 + 工具 + 最终回答。
	// 修复前 5 条 error 空消息被计成「5段中间回复」，实际只有 1 段。
	const run = runOf([
		{ kind: "message", message: assistantMessage("", undefined, "error") },
		{ kind: "message", message: assistantMessage("", undefined, "error") },
		{ kind: "message", message: assistantMessage("好问题，先核实数据能力再答。", undefined, "toolUse") },
		toolGroup(),
		{ kind: "message", message: assistantMessage("核实完毕", undefined, "stop") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	const summary = buildProcessSummary(items);
	assert.equal(summary.interimCount, 1, "空文本骨架不应计入中间回复数");
	assert.equal(summary.toolCount, 1);
	assert.equal(summary.thinkingCount, 0);
	assert.equal(hasFoldableContent(items), true);
});

test("全空 run（连续 error 空消息）：无可折叠内容，不渲染汇总按钮", () => {
	const run = runOf([
		{ kind: "message", message: assistantMessage("", undefined, "error") },
		{ kind: "message", message: assistantMessage("", undefined, "error") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.equal(hasFoldableContent(items), false);
	assert.equal(buildProcessSummary(items).interimCount, 0);
});
