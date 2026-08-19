import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);
const toolCalls = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const timelineFormat = readFileSync(
  "src/renderer/src/components/session/TimelineFormat.ts",
  "utf8",
);

test("tool-call rendering stays isolated behind the SurfaceComponents facade", () => {
  assert.match(toolCalls, /export const ToolCard = memo/);
  assert.match(toolCalls, /export const ToolGroupCard = memo/);
  assert.match(surface, /from "\.\/ToolCallComponents"/);
  assert.match(surface, /export \{ ToolCard, ToolGroupCard \}/);
  assert.doesNotMatch(surface, /function toolIcon\(toolName/);
  assert.doesNotMatch(surface, /const BUILT_IN_TOOLS = new Set/);
});

test("timeline tool rendering and message rows share formatting helpers", () => {
  assert.match(toolCalls, /from "\.\/TimelineFormat"/);
  assert.match(surface, /from "\.\/TimelineFormat"/);
  assert.match(timelineFormat, /export function stripAnsi/);
  assert.match(timelineFormat, /export function formatDuration/);
  assert.match(timelineFormat, /export function getToolStatus/);
});

test("web_search is classified as an extension rather than an MCP direct tool", () => {
  assert.match(toolCalls, /NON_MCP_TOOLS = new Set\(\["ask_question", "web_search"\]\)/);
});

test("tool and thinking disclosure icons use right-for-collapsed down-for-expanded semantics", () => {
  assert.match(toolCalls, /\{expanded \? \([\s\S]*<ChevronDown[\s\S]*\) : \([\s\S]*<ChevronRight/);
});

// 状态徽章（借鉴 AI Elements Tool 的 getStatusBadge）：running/error/done 三态
// 图标+文案 pill，不再只有 running 有视觉反馈、error 只是灰字。
test("tool card renders tri-state status badges with icons and i18n labels", () => {
  // 三态共用 shadcn Badge 组件
  assert.match(toolCalls, /import \{ Badge \} from "\.\.\/ui-shadcn\/badge"/);
  // running：outline + 琥珀色警示位 + spinner（随 trigger 行紧凑化收紧内边距）
  assert.match(toolCalls, /variant="outline" className="gap-1 border-warning\/40 px-1 py-0 text-micro text-warning"/);
  assert.match(toolCalls, /t\("tool\.statusRunning"\)/);
  // error：soft 红 outline（danger-soft 底 + danger 字 + 描边，与 running 琥珀同构）
  assert.match(toolCalls, /variant="outline" className="gap-1 border-danger\/40 bg-danger-soft px-1 py-0 text-micro text-danger"/);
  assert.match(toolCalls, /<CircleX size=\{9\}/);
  assert.match(toolCalls, /t\("tool\.statusError"\)/);
  // done：secondary 低强调 + CircleCheck 图标；ask_question 已回答时文案替换为「已回答」
  assert.match(toolCalls, /variant="secondary" className="gap-1 px-1 py-0 text-micro"/);
  assert.match(toolCalls, /<CircleCheck size=\{9\}/);
  assert.match(toolCalls, /askCard\?\.answered \? t\("ask\.answered"\) : t\("tool\.statusDone"\)/);
  // 旧实现「完成后不显示状态」的空文案分支已移除
  assert.doesNotMatch(toolCalls, /statusLabel/);
});
