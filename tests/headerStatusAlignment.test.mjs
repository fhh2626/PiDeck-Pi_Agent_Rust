import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionViewSource = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const headerSource = readFileSync(
  "src/renderer/src/components/session/SessionHeader.tsx",
  "utf8",
);

function componentInvocation(source, componentName) {
  const start = source.indexOf(`<${componentName}`);
  const end = source.indexOf("/>", start);
  assert.notEqual(start, -1, `${componentName} invocation must exist`);
  assert.notEqual(end, -1, `${componentName} invocation must be self-closing`);
  return source.slice(start, end + 2);
}

test("header status cards share the right-aligned actions group", () => {
  const actionsIndex = headerSource.indexOf("chat-header-actions");
  const sessionStatusIndex = headerSource.indexOf("<SessionStatus");
  const sessionHeader = componentInvocation(sessionViewSource, "SessionHeader");

  assert.ok(sessionStatusIndex > actionsIndex, "runtime status must be inside header actions");
  assert.match(sessionHeader, /runtimeState=\{activeRuntimeState\}/);
  // pure official：右对齐由 Tailwind justify-end 承担，不再依赖 CSS justify-self；
  // 运行控制已迁入 Tab 下拉，不再有独立的 session-actions 按钮组
  assert.match(headerSource, /chat-header-actions flex min-w-0 items-center justify-end/);
  assert.doesNotMatch(headerSource, /header-actions-right/);
});
