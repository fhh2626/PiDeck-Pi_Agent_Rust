import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync(
		"src/renderer/src/components/session/trajectory/buildTrajectory.ts",
		"utf8",
	);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, module: { exports: {} } };
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(outputText, sandbox, { filename: "buildTrajectory.ts" });
	return sandbox.exports;
}

function msg(partial) {
	return {
		id: "m",
		agentId: "a",
		role: "user",
		text: "",
		timestamp: 1,
		...partial,
	};
}

test("user message opens a turn; assistant/tool/thinking belong to it", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "fix the bug", timestamp: 1000 }),
		msg({
			id: "a1",
			role: "assistant",
			text: "looking",
			thinking: "hmm",
			thinkingStartedAt: 1100,
			thinkingEndedAt: 1400,
			timestamp: 1500,
			stopReason: "toolUse",
		}),
		msg({
			id: "t1",
			role: "tool",
			text: "✓ read",
			timestamp: 1800,
			meta: {
				toolName: "read",
				toolCallId: "c1",
				startedAt: 1600,
				durationMs: 200,
				status: "done",
				detailText: "src/a.ts",
			},
		}),
	]);
	assert.equal(model.turns.length, 1);
	assert.equal(model.records.map((r) => r.kind).join(","), "user,thinking,assistant,tool");
	const tool = model.records.find((r) => r.kind === "tool");
	assert.equal(tool.startedAt, 1600);
	assert.equal(tool.durationMs, 200);
	assert.equal(tool.endedAt, 1800);
	assert.equal(tool.lane, "tools");
	assert.equal(model.records[0].lane, "input");
	assert.equal(model.records[1].lane, "model");
	assert.equal(model.records.find((r) => r.kind === "user")?.durationMs, undefined);
	assert.equal(model.records.find((r) => r.kind === "thinking")?.durationMs, 300);
	assert.equal(model.records.find((r) => r.kind === "assistant")?.durationMs, 100);
	assert.equal(model.turns[0].durationMs, 800);
});

test("history assistant without thinking span uses previous message as start", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }),
		msg({
			id: "a1",
			role: "assistant",
			text: "done",
			thinking: "plan",
			timestamp: 2500,
			stopReason: "stop",
		}),
	]);
	const thinking = model.records.find((r) => r.kind === "thinking");
	const assistant = model.records.find((r) => r.kind === "assistant");
	assert.equal(thinking?.durationMs, undefined);
	assert.equal(assistant?.startedAt, 1000);
	assert.equal(assistant?.endedAt, 2500);
	assert.equal(assistant?.durationMs, 1500);
	assert.equal(model.turns[0].durationMs, 1500);
});

test("in-flight tool does not invent duration", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory(
		[
			msg({ id: "u1", role: "user", text: "go", timestamp: 10 }),
			msg({
				id: "t1",
				role: "tool",
				text: "▶ bash",
				timestamp: 20,
				meta: { toolName: "bash", startedAt: 15, status: "running" },
			}),
		],
		100,
	);
	const tool = model.records.find((r) => r.kind === "tool");
	assert.equal(tool.endedAt, undefined);
	assert.equal(tool.durationMs, undefined);
	assert.equal(model.turns[0].inFlight, true);
	assert.ok(model.domainEnd >= 100);
});

test("filterRecordsByRange keeps overlapping spans only", () => {
	const { filterRecordsByRange } = loadModule();
	const records = [
		{ id: "a", startedAt: 0, endedAt: 10 },
		{ id: "b", startedAt: 20, endedAt: 30 },
		{ id: "c", startedAt: 25, endedAt: undefined },
	];
	const hit = filterRecordsByRange(records, { start: 22, end: 28 }).map((r) => r.id);
	assert.equal(JSON.stringify(hit), JSON.stringify(["b", "c"]));
});

test("trajectory lives in the right drawer, not the session surface", () => {
	const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
	assert.match(sessionView, /SessionSurfaceStage/);
	assert.doesNotMatch(sessionView, /sessionSurfaceViewByIdAtomFamily/);
	assert.doesNotMatch(stage, /SessionTrajectoryView/);
	assert.doesNotMatch(header, /session.view.trajectory/);
	assert.match(hook, /"trajectory"/);
	assert.match(app, /id: "trajectory"/);
	assert.match(drawer, /SessionTrajectoryPanel/);
	assert.match(drawer, /drawer === "trajectory"/);
});

test("trajectory source concatenates runtime history prefix with the live window", () => {
	const source = readFileSync("src/renderer/src/hooks/useSessionTrajectorySource.ts", "utf8");
	const panel = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryPanel.tsx", "utf8");
	assert.match(source, /sessionMessageCacheBySessionIdAtomFamily/);
	assert.match(source, /\[\.\.\.cachedEntry\.history\.messages, \.\.\.cachedEntry\.messages\]/);
	assert.match(source, /prependSessionHistoryPageAtom/);
	assert.match(source, /readProcessEvents/);
	assert.match(source, /pi-system/);
	assert.match(panel, /currentSessionIdAtom/);
	assert.match(panel, /processEvents/);
});

test("first user message is the initial prompt; process events join the ledger", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory(
		[
			msg({ id: "u1", role: "user", text: "first ask", timestamp: 2000 }),
			msg({ id: "u2", role: "user", text: "follow up", timestamp: 4000 }),
		],
		5000,
		{
			processEvents: [
				{ id: "s1", kind: "session", timestamp: 1000, summary: "cwd /repo", cwd: "/repo" },
				{ id: "m1", kind: "modelChange", timestamp: 2500, summary: "openai/gpt", provider: "openai", modelId: "gpt" },
			],
			systemPrompt: "You are pi.",
		},
	);
	assert.equal(model.records[0].kind, "systemPrompt");
	assert.equal(model.records.find((r) => r.id === "u1")?.isInitialPrompt, true);
	assert.equal(model.records.find((r) => r.id === "u2")?.isInitialPrompt, undefined);
	assert.ok(model.records.some((r) => r.processKind === "session"));
	assert.ok(model.records.some((r) => r.processKind === "modelChange"));
	assert.equal(model.records.find((r) => r.kind === "systemPrompt")?.durationMs, undefined);
	assert.equal(model.records.find((r) => r.processKind === "session")?.durationMs, undefined);
});
