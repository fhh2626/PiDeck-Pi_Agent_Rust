import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pure official：侧栏搜索改为 shadcn Input，不再依赖 v3-braun 硬编码 #FAFAFA 背景。
 * 契约锁在组件结构上：Input + 左侧 Search 图标 + outline 新增按钮。
 */

const sidebar = readFileSync(
  "src/renderer/src/components/sidebar/SidebarContent.tsx",
  "utf8",
);

test("sidebar search uses shadcn Input with leading icon", () => {
  assert.match(sidebar, /from "\.\.\/ui-shadcn\/input"/);
  assert.match(sidebar, /from "\.\.\/ui-shadcn\/button"/);
  assert.match(sidebar, /<Input[\s\S]*placeholder=\{t\("app\.search"\)\}/);
  assert.match(sidebar, /className="h-6 pl-7 text-caption"/);
  assert.match(sidebar, /<Search[\s\S]*absolute/);
  assert.match(sidebar, /className="search-row grid[^\n]*rounded-\[10px\] bg-muted\/25 p-1"/);
  assert.doesNotMatch(sidebar, /className="search-row grid[^\n]*border border-border\/60/);
});

test("sidebar add-project control is outline icon button", () => {
  assert.match(sidebar, /variant="outline"/);
  assert.match(sidebar, /aria-label=\{t\("app\.addProject"\)\}/);
  assert.match(sidebar, /className="round-add size-6 shrink-0"/);
  assert.match(sidebar, /<FolderPlus className="size-3\.5" \/>/);
  assert.doesNotMatch(sidebar, /<Plus className="size-4" \/>/);
});
