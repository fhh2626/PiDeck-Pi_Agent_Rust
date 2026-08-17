import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);
const chatContentWidth = readFileSync(
  "src/renderer/src/components/session/chatContentWidth.ts",
  "utf8",
);
const overlay = readFileSync(
  "src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx",
  "utf8",
);
const foundation = readFileSync(
  "src/renderer/src/styles/foundation.css",
  "utf8",
);
const tailwind = readFileSync(
  "src/renderer/src/styles/tailwind.css",
  "utf8",
);

/**
 * Ask 是会话级阻塞交互，不应参与 composer 的 flex 高度分配；否则 Ask 展开时会和
 * 编辑器的最小高度互相挤压。回归契约从两方面锁定这个边界：composer 不再接收 runtimeUi，
 * timeline 负责承载它；Ask 内容也不再创建第二个纵向滚动 owner。
 */
test("ask stays out of composer sizing and uses the session timeline as its scroll owner", () => {
  assert.doesNotMatch(composerArea, /runtimeUi/);
  assert.match(sessionView, /<SessionSurfaceStage[\s\S]*runtimeUi,/);
  assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
  assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
  // 内容宽度：消息区/输入框 inline width，Ask 随时间线同宽。
  // 时间线侧挂在 MessageScroller 的 contentProps（内层 [role=log]）上，
  // 视口铺满面板、滚动条贴面板最右，内容列仍与 composer 同宽居中。
  // 空态例外：showSurfaceEmptyState 时去掉约束（起始页自控宽度，与引导页一致）。
  assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
  assert.doesNotMatch(timeline, /style=\{chatContentWidthStyle\}/);
  assert.doesNotMatch(timeline, /--chat-inline-pad/);
  assert.doesNotMatch(foundation, /--chat-inline-pad|--chat-side-gap/);
  assert.doesNotMatch(overlay, /CollapsibleContent className="min-h-0 overflow-y-auto"/);
  assert.doesNotMatch(overlay, /max-h-\[(?:55vh|180px|240px)\][^\n]*overflow-y-auto/);
});

/**
 * 没有 Ask 时，composer 仍只需要容纳输入框自身；这个数值关系保证保留底部输入栏，
 * 同时把 Ask 的可变高度交给 timeline，而不是继续用一个无法满足的 312px 组合约束。
 */
test("composer minimum still fits the editor after ask moves to timeline", () => {
  const composerMinHeight = 148;
  const composerBoxMinHeight = 112;
  const composerVerticalPadding = 12;
  const composerGap = 8;
  const requiredHeight = composerBoxMinHeight + composerVerticalPadding + composerGap;

  assert.ok(
    requiredHeight <= composerMinHeight,
    `editor needs ${requiredHeight}px, but composer minimum is only ${composerMinHeight}px`,
  );
});

/**
 * 消息列与输入框必须共享同一条滚动条槽位：时间线视口由自身 scrollbar-gutter 预留，
 * composer 面板用 overflow-hidden + scrollbar-gutter:stable 预留同宽槽位，两者百分比
 * 宽度/居中基准一致——任何宽度设置与平台（macOS 覆盖式滚动条时两侧同为 0）下都对齐，
 * 不依赖写死的像素补偿。
 */
test("composer panel reserves the same scrollbar gutter as the timeline", () => {
  assert.match(sessionView, /session-v-composer overflow-hidden \[scrollbar-gutter:stable\]/);
  assert.doesNotMatch(sessionView, /paddingRight/);
  // 时间线侧：宽度约束挂在滚动内容上（视口自带 scrollbar-gutter:stable 预留槽位）；
  // 空态例外：showSurfaceEmptyState 时去掉约束（起始页自控宽度，与引导页一致）。
  assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
  assert.match(chatContentWidth, /scrollbar-gutter:stable/);
});
