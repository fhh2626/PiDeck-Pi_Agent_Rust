import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const drawerSurface = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const drawerPorts = readFileSync("src/renderer/src/hooks/useDrawerPorts.ts", "utf8");
const fileEditorHook = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("drawer rail keeps the editor as a second entry next to split reading", () => {
  assert.match(app, /id:\s*"editor"/);
  assert.match(app, /active:\s*drawer === "editor"/);
  assert.match(app, /handleToolDrawerAction\("editor"\)/);
});

test("drawer surface and ports still carry the editor panel", () => {
  assert.match(drawerSurface, /drawer === "editor"/);
  assert.match(drawerSurface, /DrawerEditorPort/);
  assert.match(drawerSurface, /t\("editor\.emptyTitle"\)/);
  assert.match(drawerPorts, /DrawerEditorPort/);
  assert.match(drawerPorts, /input\.editorMode/);
});

test("closing the last editor tab resets workbench layout to settings default", () => {
  // 分屏 workbench 的布局重置逻辑与抽屉无关，必须保留
  assert.doesNotMatch(
    fileEditorHook,
    /editorTabs\.length === 0 && drawer === "editor"[\s\S]{0,200}?setDrawer\(null\)/,
  );
  const closeTabBlock = fileEditorHook.slice(
    fileEditorHook.indexOf("if (next.length === 0)"),
    fileEditorHook.indexOf("if (next.length === 0)") + 500,
  );
  assert.match(closeTabBlock, /contentOpenModeRef\.current/);
  assert.match(closeTabBlock, /setEditorMode\(contentOpenModeRef\.current\)/);
  const closeEditorBlock = fileEditorHook.slice(
    fileEditorHook.indexOf("const closeEditor = useCallback"),
    fileEditorHook.indexOf("const closeEditor = useCallback") + 500,
  );
  assert.match(closeEditorBlock, /setEditorMode\(contentOpenModeRef\.current\)/);
});

test("editor drawer empty-state copy stays in both locales", () => {
  for (const key of ['"editor.fileEditor"', '"editor.emptyTitle"', '"editor.emptyHint"', '"editor.emptyOpenFiles"']) {
    assert.ok(zhCN.includes(key), `zh-CN should keep ${key}`);
    assert.ok(enUS.includes(key), `en-US should keep ${key}`);
  }
});
