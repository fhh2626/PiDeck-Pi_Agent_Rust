import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  isCollapsedPanelPixels,
  shouldCommitPanelPixels,
} from "../src/renderer/src/lib/shellPanelLayout.ts";

test("collapsed pixels are never committed", () => {
  assert.equal(isCollapsedPanelPixels(0), true);
  assert.equal(isCollapsedPanelPixels(1), true);
  assert.equal(isCollapsedPanelPixels(2), false);
  assert.equal(
    shouldCommitPanelPixels({
      px: 0,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    null,
  );
});

test("expand-to-min does not overwrite the saved drawer width", () => {
  // 清缓存后默认 320；expand() 落到 min 180，写回去就会和 resize(320) 对打。
  assert.equal(
    shouldCommitPanelPixels({
      px: 180,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    null,
  );
  assert.equal(
    shouldCommitPanelPixels({
      px: 234,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    234,
  );
});

test("user drag to min size is still committed", () => {
  assert.equal(
    shouldCommitPanelPixels({
      px: 180,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: true,
    }),
    180,
  );
});

test("zoom or window resize commits the new pixel width", () => {
  assert.equal(
    shouldCommitPanelPixels({
      px: 400,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    400,
  );
  assert.equal(
    shouldCommitPanelPixels({
      px: 280,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    280,
  );
});

test("equal sizes are ignored to keep resize effects idle", () => {
  assert.equal(
    shouldCommitPanelPixels({
      px: 320,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    null,
  );
  assert.equal(
    shouldCommitPanelPixels({
      px: 321,
      savedWidth: 320,
      minSize: 180,
      isUserInteraction: false,
    }),
    null,
  );
});

test("AppShell opens a collapsed drawer by resizing to the saved width", () => {
  const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
  assert.match(shell, /shouldCommitPanelPixels/);
  // expand() 无历史会落到 minSize，打开抽屉必须用保存宽度 resize。
  assert.match(shell, /panel\.resize\(drawerWidthRef\.current\)/);
  assert.match(shell, /panel\.resize\(listWidthRef\.current\)/);
  assert.doesNotMatch(shell, /panel\.expand\(\)/);
});
