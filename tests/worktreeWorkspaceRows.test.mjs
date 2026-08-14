// 回归测试：侧栏 worktree 工作区行的四个行为契约。
// 背景问题：
// 1) 选中某个工作区时整个区块（含会话列表）被压暗——active 只能挂在分支名行上；
// 2) 主工作区没有折叠入口；
// 3) 新建/匿名按钮只在项目行上，worktree 模式下入口不明显——挪到工作区行。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const worktreeTree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");
const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
const workspaceStyles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");

test("main workspace is collapsible via the shared worktree expand set", () => {
  assert.match(worktreeTree, /mainCollapsed/);
  assert.match(worktreeTree, /toggleWorktreeSessions\(mainSessionsKey\)/);
  // 折叠时不渲染会话列表
  assert.match(worktreeTree, /\{!mainCollapsed && \(/);
});

test("main workspace row carries create-draft and anonymous actions", () => {
  const mainSection = worktreeTree.slice(
    worktreeTree.indexOf("workspace-tree-main"),
    worktreeTree.indexOf("workspace-tree-list"),
  );
  assert.match(mainSection, /createDraft\(props\.project\.id\)/);
  assert.match(mainSection, /createAnonymous\(props\.project\.id\)/);
});

test("worktree rows carry the anonymous action next to create-draft", () => {
  // 行视图必须同时提供「新建/匿名」两个入口。操作浮层已抽成共享组件
  // WorkspaceRowActions（类名不再内联在行视图里），故按行视图定义切片断言行为。
  const rowView = worktreeTree.slice(worktreeTree.lastIndexOf("WorkspaceTreeRowView"));
  assert.match(rowView, /createDraft\(childProject\.id\)/);
  assert.match(rowView, /createAnonymous\(childProject\.id\)/);
  assert.match(rowView, /<WorkspaceRowActions>/);
});

test("active worktree selection only highlights the branch row, not the whole block", () => {
  // wrapper 不允许再带 isActive 背景（会把展开的会话列表一起压暗）
  assert.doesNotMatch(worktreeTree, /workspace-tree-row group[\s\S]{0,200}isActive && "bg-accent\/60/);
  // 窄侧栏注释行插在中间，窗口留到 500 保证断言不依赖注释长度
  assert.match(worktreeTree, /workspace-tree-select[\s\S]{0,500}isActive && "bg-accent\/60/);
});

test("child worktree labels use a smaller hierarchy than their parent project", () => {
  const childRow = worktreeTree.slice(worktreeTree.indexOf("WorkspaceTreeRowView"));
  // 父项目和主工作区保持 text-body；只有其他 worktree 降为辅助导航字号。
  assert.match(childRow, /workspace-tree-select",[\s\S]{0,200}"text-control"/);
});

test("worktree auxiliary labels stay at the compact micro size", () => {
  // 这些是层级提示而非主要导航项；使用 caption 会随 medium 档位放大到 13px，
  // 导致“其他工作区”和“还有 N 个会话/查看更多子项”抢过会话行的视觉层级。
  assert.match(worktreeTree, /workspace-tree-section-header[^\n]*text-micro/);
  assert.match(sessionTree, /className=\{`h-auto justify-start px-2 text-micro /);
  assert.match(sessionTree, /worktree-sessions-more/);
  assert.match(workspaceStyles, /\.session-more-row,[\s\S]*?font-size: var\(--font-size-micro\)/);
  assert.match(workspaceStyles, /\.worktree-sessions-more[\s\S]*?font-size: var\(--font-size-micro\)/);
});

test("active child worktree keeps the secondary text weight", () => {
  const childRow = worktreeTree.slice(worktreeTree.indexOf("WorkspaceTreeRowView"));
  assert.match(childRow, /isActive \? "font-normal" : "font-medium"/);
});

test("project row hides create/anonymous buttons in worktree mode", () => {
  // worktree 模式下入口挪到主工作区行，项目行不再重复提供
  assert.match(projectTree, /isCurrent && !project\.worktreeEnabled/);
  assert.match(projectTree, /!project\.worktreeEnabled && \(/);
});
