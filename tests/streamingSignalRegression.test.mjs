import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏：流式期间渲染层必须拿到 isStreaming=true 才会走逐字渐显
 * （useSmoothStream），否则回答整段蹦出、滚动引擎收不到逐字增长（无滞空感）。
 *
 * 背景：isStreaming 原只来自 pi get_state 轮询，而主进程在 text_delta 期间
 * 从不 emitRuntimeState，mock/真实 pi 的轮询也无法覆盖该窗口 → 链路断裂。
 * 修复：主进程本地维护 streamingAgents，边沿置位/清除并推轻量 isStreaming 补丁；
 * text-stream / 50ms 消息 flush 热路径不再无条件打 runtime。
 */
test("streaming signal: isStreaming edges push lightweight patch, hot path does not", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

	// 1) 本地流式标志集合存在，并在 getRuntimeState 里并入（轮询兜底）
	assert.match(agentManager, /private readonly streamingAgents = new Set<string>\(\)/);
	assert.match(
		agentManager,
		/isStreaming: state\?\.isStreaming \|\| this\.streamingAgents\.has\(agentId\)/,
	);

	// 2) 边沿 helper：只在 true/false 变化时写 Set 并推 patch
	assert.match(agentManager, /private setStreamingAgent\(agentId: string, streaming: boolean\)/);
	assert.match(agentManager, /this\.setStreamingAgent\(agentId, true\)/);
	assert.match(agentManager, /this\.setStreamingAgent\(agentId, false\)/);

	// 3) message_end / done / error 清除（回答结束不再误报流式中）
	assert.match(
		agentManager,
		/eventType === "message_end" \|\| eventType === "done" \|\| eventType === "error"/,
	);

	// 4) agent_end / agent_settled / abort 清除（run 生命周期终点）
	assert.match(agentManager, /if \(typed\.type === "agent_end"\)/);
	assert.match(agentManager, /if \(typed\.type === "agent_settled"\)/);
	assert.match(agentManager, /this\.sealAgentStream\(agentId\)/);
	const clearCount = agentManager.match(/this\.setStreamingAgent\(agentId, false\)/g)?.length ?? 0;
	assert.ok(clearCount >= 3, "streaming flag must be cleared on end/settled/abort paths");

	// 5) 轻量补丁仍走 agents:runtime-state，但不挂在 text-stream / 消息 flush 热路径
	assert.match(agentManager, /private emitStreamingStatePatch\(agentId: string\)/);
	assert.match(agentManager, /isStreaming: this\.streamingAgents\.has\(agentId\)/);
	assert.match(agentManager, /ipcChannels\.agentsRuntimeState/);

	const emitNow = agentManager.indexOf("private emitTextStreamNow(agentId: string, text: string, done = false)");
	const emitNowEnd = agentManager.indexOf("private emitState()", emitNow);
	assert.ok(emitNow >= 0 && emitNowEnd > emitNow);
	assert.doesNotMatch(
		agentManager.slice(emitNow, emitNowEnd),
		/emitStreamingStatePatch\(agentId\)/,
	);

	const flush = agentManager.indexOf("private flushMessageEmit(agentId: string)");
	const flushEnd = agentManager.indexOf("private setStreamingAgent", flush);
	assert.ok(flush >= 0 && flushEnd > flush);
	assert.doesNotMatch(
		agentManager.slice(flush, flushEnd),
		/emitStreamingStatePatch\(agentId\)/,
	);

	// abort 关边沿必须仍发 patch，避免停止后 spinner 残
	const abortPatch = agentManager.indexOf("if (hadActiveTool) this.emitToolRuntimeTransition(agentId, false);");
	assert.ok(abortPatch >= 0);
	assert.match(
		agentManager.slice(abortPatch, abortPatch + 280),
		/this\.emitStreamingStatePatch\(agentId\)/,
	);
});

test("renderer uses Controls isStreaming for live run marking", () => {
	const timeline = readFileSync(
		"src/renderer/src/components/session/SessionMessageTimeline.tsx",
		"utf8",
	);
  assert.match(timeline, /isLatestTimelineRunBusy/);
  assert.match(timeline, /liveThinkingId=\{liveThinkingId\}/);
  assert.match(timeline, /liveThinkingIdBySessionIdAtomFamily/);
  assert.doesNotMatch(timeline, /streamingThinking=\{isRunStreaming \? activeThinking : undefined\}/);
  assert.doesNotMatch(timeline, /streamingMessageId/);
});
