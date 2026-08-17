import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync(
  "src/renderer/src/components/session/SessionStartSurface.tsx",
  "utf8",
);
const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

test("start surface reuses the session bottom composer, not a second input implementation", () => {
  // 统一输入：直接居中挂完整 ComposerArea（模型/思考/模式/安全级别/发送全保留），
  // 禁止再出现自制 TipTapComposer / waitRuntimeReady / sendPrompt 链路。
  assert.match(surface, /<ComposerArea/);
  assert.match(surface, /import \{ ComposerArea \} from "\.\/ComposerArea"/);
  assert.match(surface, /import \{ QueuedPromptPanel \} from "\.\/ComposerPanels"/);
  assert.match(surface, /useSessionPaneServices\(\)/);
  assert.match(surface, /queuedPromptsBySession\[props\.sessionId\]/);
  assert.match(surface, /<LogoMark size=\{72\} \/>/);
  assert.doesNotMatch(surface, /TipTapComposer/);
  assert.doesNotMatch(surface, /waitRuntimeReady|sendPrompt|getComposerEnterIntent/);
});

test("start surface centers the composer", () => {
  // DeepSeek 式居中：flex 列 + 重心下移（pt-[18vh] 压向视口中心）；
  // 2026-11 整体放大：Logo 72 / 980px / 高 300；快捷项按钮已按用户要求移除
  assert.match(surface, /pt-\[18vh\]/);
  assert.match(surface, /max-w-\[980px\]/);
  assert.match(surface, /defaultHeight=\{150\}/);
  assert.match(surface, /session-start-surface/);
  // 移除快捷项后不再存在相关常量/交互代码
  assert.doesNotMatch(surface, /QUICK_ACTIONS/);
  assert.doesNotMatch(surface, /insertQuickPrompt/);
});

test("bottom composer is hidden while the start surface is showing", () => {
  // 无消息时底部栏不渲染，避免同屏两个输入框；有消息后回归
  assert.match(view, /sessionTimeline\.messages\.length > 0/);
  assert.match(view, /ResizablePanel\s*\n\s*id="composer"/);
});

test("empty active sessions render the start surface with the session id", () => {
  assert.match(timeline, /activeMessages\.length === 0/);
  assert.match(timeline, /<SessionStartSurface sessionId=\{sessionId\} \/>/);
});
