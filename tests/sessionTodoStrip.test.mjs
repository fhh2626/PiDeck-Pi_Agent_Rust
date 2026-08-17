import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 与 sessionWidgetChips.test.mjs 相同的 TSX 编译替身模式：只测公开 helper 与源码结构，
// 不挂载真实 React / jotai。
function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: filePath });
  return module.exports;
}

const stripPath = "src/renderer/src/components/session/SessionTodoStrip.tsx";
const stripSource = () => readFileSync(stripPath, "utf8");
const composerSource = () =>
  readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const viewSource = () =>
  readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

function loadStripHelpers() {
  // stub 掉 JSX 依赖（jotai/lucide/i18n/parse），只取 progressLabel 纯函数
  return compile(stripPath, {
    react: {},
    jotai: {},
    "lucide-react": {},
    "../../i18n": { t: (key, params = {}) => key + ":" + JSON.stringify(params) },
    "./ComposerRuntimeIntegrations": {},
    "./agentTodoParser": { parseAgentTodoItems: (lines) => [] },
  });
}

test("progressLabel omits zero-count segments and joins with en-space middots", () => {
  const { progressLabel } = loadStripHelpers();
  const item = (status) => ({ status, id: status, title: status });
  // 全状态齐：三段都在，分隔符为 en-space(U+2002) · en-space
  assert.equal(
    progressLabel([item("completed"), item("in-progress"), item("pending")]),
    "sessionTodo.done:{\"done\":1}\u2002·\u2002sessionTodo.active:{\"active\":1}\u2002·\u2002sessionTodo.pending:{\"pending\":1}",
  );
  // 零计数段省略：只有进行中 + 待处理（完成 0 不显示）
  assert.equal(
    progressLabel([item("in-progress"), item("pending")]),
    "sessionTodo.active:{\"active\":1}\u2002·\u2002sessionTodo.pending:{\"pending\":1}",
  );
  // 全部完成：只显示 done 段
  assert.equal(
    progressLabel([item("completed"), item("completed")]),
    "sessionTodo.done:{\"done\":2}",
  );
});

test("strip reads both todo widgets, respects dismissal, and hides when empty", () => {
  const source = stripSource();
  // 数据链路：合并 pi-deck-todo + pi-deck-plan-todos 两个 widget 为一个待办列表
  assert.match(source, /pi-deck-todo/);
  assert.match(source, /pi-deck-plan-todos/);
  assert.match(source, /isWidgetDismissed\(dismissed, props\.sessionId, key, widgetLines\)/);
  assert.match(source, /loadDismissedWidgets/);
  assert.match(source, /parseAgentTodoItems\(lines\)/);
  // 无 todo 行整体不渲染（dsh TodoPanel 同款行为）
  assert.match(source, /if \(items\.length === 0\) return null/);
  // 折叠态本地 state
  assert.match(source, /const \[collapsed, setCollapsed\] = useState\(true\)/);
});

test("strip renders a collapsed row with title, progress and three-state glyphs", () => {
  const source = stripSource();
  // 折叠条：h-9（36px）行 + ListChecks 图标 + 标题 + 进度文案 + chevron
  assert.match(source, /flex h-9 w-full items-center/);
  assert.match(source, /ListChecks size=\{14\}/);
  assert.match(source, /t\("sessionTodo\.title"\)/);
  assert.match(source, /progressLabel\(items\)/);
  assert.match(source, /aria-expanded=\{!collapsed\}/);
  // 展开列表：180px 内滚动 + 状态字形（completed/in-progress/pending 三态 svg）
  assert.match(source, /max-h-\[180px\]/);
  assert.match(source, /StatusGlyph status=\{item\.status\}/);
  assert.match(source, /animate-spin/);
  assert.match(source, /strokeDasharray="2\.4 2\.4"/);
});

test("composer area forwards a widgets slot and session view mounts the strip", () => {
  const composer = composerSource();
  const view = viewSource();
  // ComposerArea：新增 widgets prop 并透传到 ComposerMeasuredExtras（测量链驱动面板增高）
  assert.match(composer, /widgets\?: ReactNode/);
  assert.match(composer, /widgets=\{props\.widgets \?\? null\}/);
  // SessionView：底部 composer 挂载 SessionTodoStrip，带 sessionId
  assert.match(view, /import \{ SessionTodoStrip \} from "\.\/SessionTodoStrip"/);
  assert.match(view, /widgets=\{<SessionTodoStrip sessionId=\{sessionId\} \/>\}/);
});

test("strip copy is present in both locale dictionaries", () => {
  for (const locale of [zh(), en()]) {
    assert.match(locale, /"sessionTodo\.title"/);
    assert.match(locale, /"sessionTodo\.done": "\{done\}/);
    assert.match(locale, /"sessionTodo\.active": "\{active\}/);
    assert.match(locale, /"sessionTodo\.pending": "\{pending\}/);
  }
});

// ── dismiss 记录（自 SessionWidgetChips 迁入，2026-08）──

test("widget dismissal is permanent across restarts and revives only on new content", () => {
  const { isWidgetDismissed, widgetDismissalId, widgetLinesSignature } = loadStripHelpers();
  const lines = ["── 待办 ──", "☐ #1 修复登录页样式"];
  // 用户手动关闭 → 记录当时的内容指纹
  const dismissed = {
    [widgetDismissalId("session-a", "pi-deck-todo")]: widgetLinesSignature(lines),
  };
  // 重启后扩展重建同一列表：指纹相同 → 永久保持隐藏
  assert.equal(isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", [...lines]), true);
  // 工具再次调用追加新待办：内容变化 → 自动复活
  assert.equal(
    isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", [...lines, "☐ #2 补测试"]),
    false,
  );
  // dismiss 按 session / widgetKey 隔离
  assert.equal(isWidgetDismissed(dismissed, "session-b", "pi-deck-todo", [...lines]), false);
  assert.equal(isWidgetDismissed(dismissed, "session-a", "pi-deck-plan-todos", [...lines]), false);
});

test("widgetLinesSignature is stable and order/content sensitive", () => {
  const { widgetLinesSignature } = loadStripHelpers();
  const a = ["☐ #1 任务一", "☐ #2 任务二"];
  assert.equal(widgetLinesSignature(a), widgetLinesSignature([...a]));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature([...a].reverse()));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature([...a, "☐ #3 任务三"]));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature(["☐ #1 任务一改"]));
});

// ── chat-header widget chips 已移除（2026-08 用户要求：待办统一走输入框上方常驻条）──

test("chat-header widget chips are removed; header slot and mounts are gone", () => {
  const view = viewSource();
  const header = readFileSync(
    "src/renderer/src/components/session/SessionHeader.tsx",
    "utf8",
  );
  const strip = stripSource();
  // 组件文件删除 + 挂载/槽位/import 移除
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/SessionWidgetChips.tsx"),
  );
  assert.doesNotMatch(view, /SessionWidgetChips/);
  assert.doesNotMatch(header, /widgetChips/);
  // dismiss 工具迁入常驻条，保持同一 localStorage 指纹语义
  assert.match(strip, /DISMISSED_WIDGETS_KEY/);
  assert.match(strip, /isWidgetDismissed\(dismissed, props\.sessionId, key, widgetLines\)/);
  assert.match(strip, /loadDismissedWidgets/);
});
