import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const wrapper = readFileSync(
	"src/renderer/src/components/session/MarkdownStream.tsx",
	"utf8",
);
const viteConfig = readFileSync("electron.vite.config.ts", "utf8");
const staticCallers = [
	"src/renderer/src/components/app/FileDiffViewer.tsx",
	"src/renderer/src/components/overlays/AppUpdateOverlay.tsx",
	"src/renderer/src/components/scratchPad/ScratchPadPanel.tsx",
].map((path) => readFileSync(path, "utf8"));

test("static markdown callers do not pull Streamdown into the renderer entry", () => {
	assert.match(wrapper, /import\("\.\/MarkdownStreamRenderer"\)/);
	assert.doesNotMatch(wrapper, /from "streamdown"/);
	assert.doesNotMatch(wrapper, /from "@streamdown\//);
	for (const source of staticCallers) {
		assert.doesNotMatch(source, /from "streamdown"/);
		assert.doesNotMatch(source, /from "@streamdown\//);
	}
	// 不把动态 Markdown 依赖强行聚合成入口共享 chunk；否则 Vite 会为它生成首屏 preload。
	assert.doesNotMatch(viteConfig, /return "vendor-markdown"/);
});
