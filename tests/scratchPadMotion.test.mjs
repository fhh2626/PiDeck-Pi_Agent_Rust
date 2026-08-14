import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const styles = readRendererStyles();

function cssRule(selector) {
  return styles.match(new RegExp(`(?:^|\\n)${selector} \\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
}

test("scratch pad wallpaper overlay is translucent, panel follows panel alpha", () => {
  // 壁纸模式遮罩与面板同档半透明（透出背景图，避免整页纯色空白）；
  // 草稿本面板底色跟随背景图滑块（--wallpaper-panel-alpha），不再是纯色白
  assert.match(
    styles,
    /:root\[data-bg-image="on"\] \.scratch-pad-overlay\s*\{[\s\S]*?background:\s*color-mix\([\s\S]*?var\(--wallpaper-panel-alpha,\s*30%\)/,
  );
  assert.match(
    styles,
    /:root\[data-bg-image="on"\] \.scratch-pad-panel[\s\S]*?--wallpaper-dialog-alpha:\s*var\(--wallpaper-panel-alpha,\s*30%\);/,
  );
});

test("scratch pad releases the compositor layer after its entrance motion", () => {
  const overlay = cssRule("\\.scratch-pad-overlay");
  const panel = cssRule("\\.scratch-pad-panel");

  assert.ok(overlay, "scratch pad overlay styles must exist");
  assert.doesNotMatch(overlay, /backdrop-filter/);
  assert.match(overlay, /animation:\s*scratch-pad-backdrop-enter 120ms/);
  assert.ok(panel, "scratch pad panel styles must exist");
  assert.match(panel, /animation:\s*scratch-pad-enter 180ms/);
  assert.doesNotMatch(panel, /will-change:\s*opacity, transform;/);
  assert.match(styles, /@keyframes scratch-pad-enter \{[\s\S]*?transform:\s*none;/);
});
