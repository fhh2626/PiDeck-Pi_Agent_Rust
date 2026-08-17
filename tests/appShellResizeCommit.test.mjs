// 回归测试：侧栏/抽屉拖拽状态必须在布局变更完成时（onLayoutChanged）统一回写，
// 禁止在 Panel onResize（每个 pointermove 触发一次）里 setState。
// 背景：拖拽期间每帧 setState 会让整个工作台重渲染，且 defaultSize 随动触发
// react-resizable-panels 重布局，两者叠加造成拖拽抖动。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

test("resize state commits via Group onLayoutChanged, not per-frame Panel onResize", () => {
  assert.match(shell, /onLayoutChanged=\{handleLayoutChanged\}/);
  assert.doesNotMatch(shell, /onResize=\{handle/);
});

test("container zoom/resize syncs panel pixels via ResizeObserver", () => {
  // 库 onLayoutChanged 在 preserve-relative-size 下 zoom 前后百分比不变，W 深比较
  // 判定相同跳过 → AppShell 收不到通知。必须直察 Group 容器：RO 回调排库之后，
  // getSize() 已更新，把 drawer/list 实际像素写回 --drawer-*/listWidth。
  assert.match(shell, /elementRef=\{groupRef\}/);
  assert.match(shell, /new ResizeObserver\(\(\) => \{/);
  assert.match(shell, /ro\.observe\(el\)/);
  assert.match(shell, /setDrawerWidth\(px\)/);
  assert.match(shell, /setListWidth\(px\)/);
  assert.match(shell, /drawerOpenRef\.current/);
});

test("programmatic layout changes do not write collapsed or expand-to-min width", () => {
  // isUserInteraction=false 仍须在折叠状态回写前 return，避免 effect → resize → 回写回路。
  // 抽屉像素宽走 shouldCommitPanelPixels：折叠 0 与 expand→min 都不写，缩放后的真实像素才写。
  assert.match(shell, /if \(!meta\.isUserInteraction\) return;/);
  assert.match(shell, /shouldCommitPanelPixels/);
});

test("splitter paints a single neutral diffused line", () => {
  const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
  const block = foundation.slice(foundation.indexOf(".splitter {"), foundation.indexOf(".v-splitter {"));
  // separator 本体不画线（shadcn bg-border 会盖过后加载的 utility），必须显式 transparent，
  // 视觉只留 ::before，避免双线
  assert.match(block, /\.splitter \{[\s\S]*?background:\s*transparent !important/);
  // 分隔条不掺主题色，任何 accent 主题下都不发绿
  assert.doesNotMatch(block, /--color-accent/);
});
