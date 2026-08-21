import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coordinator = readFileSync(
  "src/main/sessions/SessionRuntimeCoordinator.ts",
  "utf8",
);
const main = readFileSync("src/main/index.ts", "utf8");
const createBackend = readFileSync("src/main/backend/createBackend.ts", "utf8");
const sessionBridge = readFileSync("src/main/backend/sessionRuntimeBridge.ts", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const runtimeInjector = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const runtimeUi = readFileSync(
  "src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx",
  "utf8",
);
const composer = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);
const toolCards = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const askResultCard = readFileSync(
  "src/renderer/src/components/session/AskQuestionResultCard.tsx",
  "utf8",
);
const webTimeline = readFileSync(
  "src/renderer/src/web/WebTimeline.tsx",
  "utf8",
);
const webChatApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");

test("catalog scans attach matching existing runtimes in the main process", () => {
  assert.match(coordinator, /attachCatalogRuntimes\(/);
  assert.match(createBackend, /attachCatalogRuntimes\(records\)/);
  assert.match(sessionIpc, /sessionsCatalogList[\s\S]*mergeScanned[\s\S]*attachCatalogRuntimes/);
});

test("unbound interactive UI is cancelled and cannot be surfaced as Session UI", () => {
  assert.match(sessionBridge, /cancelUnboundUiRequest/);
  assert.match(sessionBridge, /"batch_ask"/);
  assert.match(sessionBridge, /sendUIResponse\([^,]+,[^,]+, \{ cancelled: true \}\)/);
  assert.doesNotMatch(app, /bindSessionRuntimeAtom|bindSessionRuntime\(/);
  assert.doesNotMatch(app, /api\.agents\.onUiRequest\(/);
});

test("Ask Question keeps normalized batch requests pending for the session responder", () => {
  assert.match(coordinator, /method === "batch_ask"/);
  assert.match(agentManager, /hasCustomOption/);
  assert.match(agentManager, /option\.startsWith\("✎"\)/);
  assert.match(agentManager, /allowOther: typed\.allowOther === true \|\| hasCustomOption/);
  // AgentManager 把解析出的批量表单原样放进 batch_ask 请求的 batchQuestions 字段
  assert.match(agentManager, /batchQuestions: batchEnvelope\.questions/);
});

test("session UI requests remain generation-bound and render in the timeline footer", () => {
  assert.match(runtimeInjector, /createSessionRuntimeUiResponder\(/);
  assert.match(runtimeInjector, /sessionId: currentSessionId/);
  assert.match(runtimeInjector, /runtimeGeneration: latest\.runtimeGeneration/);
  assert.match(runtimeInjector, /<SessionRuntimeUiOverlay/);
  assert.match(runtimeUi, /ask-inline-bar(?:\s+ask-inline-bar--active)?/);  // Ask 继续使用稳定的布局锚点类
  assert.match(runtimeUi, /ApprovalCard/);
  assert.doesNotMatch(runtimeUi, /className="modal-backdrop ask-dialog-backdrop"/);
  assert.doesNotMatch(composer, /runtimeUi/);
  assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
  assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
  // 已完成 ask_question 渲染为常驻 AskQuestionResultCard（批量逐题展示）；
  // 普通 ToolCard 只保留 running / 损坏 ask 的图标与副标题（askCard.question）。
  assert.match(askResultCard, /result\.questions/);
  assert.match(askResultCard, /AskQuestionResultCard/);
  assert.match(toolCards, /isAskCard/);
  // Web 端复用 SessionRuntimeUiOverlay 作为 pending 卡，并通过 props 接线。
  assert.match(webTimeline, /<SessionRuntimeUiOverlay/);
  assert.match(webChatApp, /pendingUiRequest=/);
  assert.match(webChatApp, /onRespondUi=/);
  assert.doesNotMatch(webTimeline, /function WebAskCard\(/);
});

test("Web wiring is Session-first and exposes no Agent compatibility creation", () => {
  assert.match(
    createBackend,
    /createSessionDraft: async \(input\)[\s\S]*sessionCatalog\.createDraft/,
  );
  assert.match(
    createBackend,
    /sendSessionPrompt: async \(input\)[\s\S]*sessionRuntimeCoordinator\.send\(input\)/,
  );
  // stopSessionRuntime is now a shared helper called from both IPC and the web deps.
  assert.match(sessionBridge, /async function stopSessionRuntime\([\s\S]*?sessionRuntimeCoordinator\.stopRuntime\(target\)/);
  assert.doesNotMatch(createBackend, /createAgent:/);
  assert.doesNotMatch(main, /LEGACY_EXTERNAL_RUNTIME|ipcChannels\.agentsCreate/);
});

test("catalog deletion rejects bound or activating Session runtimes", () => {
  assert.match(sessionIpc, /sessionsCatalogDelete[\s\S]*sessionRuntimeCoordinator\.getTarget\(sessionId\)[\s\S]*sessionRuntimeCoordinator\.isActivating\(sessionId\)/);
  assert.match(createBackend, /deleteSessionRecord: async \(sessionId\)[\s\S]*sessionRuntimeCoordinator\.getTarget\(sessionId\)[\s\S]*sessionRuntimeCoordinator\.isActivating\(sessionId\)/);
  assert.match(coordinator, /isActivating\(sessionId: string\): boolean/);
});

test("replacement restore is gated by full origin identity in main", () => {
  assert.match(sessionBridge, /const originKey = originEntry\?\.filePath[\s\S]*buildSessionOriginKey/);
  assert.match(sessionBridge, /canRestoreOrigin: \(\) => \{[\s\S]*buildSessionOriginKey[\s\S]*\) === originKey;/);
  assert.match(coordinator, /failClosedRuntimeReplacement/);
  assert.match(coordinator, /replacementBySession/);
});
