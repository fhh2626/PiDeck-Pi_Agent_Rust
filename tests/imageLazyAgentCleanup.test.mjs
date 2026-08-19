import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 第二批内存优化契约：消息图片按需解码 + agentId 维度 atomFamily 随退出释放
const surface = [
	readFileSync("src/renderer/src/components/session/MessageImage.tsx", "utf8"),
	readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8"),
].join("\n");
const runtimeAtoms = readFileSync(
  "src/renderer/src/atoms/runtime-atoms.ts",
  "utf8",
);
const bridge = readFileSync(
  "src/renderer/src/hooks/useSessionRuntimeBridge.ts",
  "utf8",
);

test("message images decode lazily via IntersectionObserver", () => {
  // base64 data URL 字符串无法省（已在消息对象），但解码位图是内存大头：
  // 视口外不设 src（不解码），进入视口（200px 提前量）才挂载；占位高度防滚动跳动。
  assert.match(surface, /function MessageImage\(/);
  assert.match(surface, /src=\{inView \? props\.src : undefined\}/);
  assert.match(surface, /rootMargin: \"200px\"/);
  assert.match(surface, /decoding=\"async\"/);
  assert.match(surface, /placeholderClass=\"min-h-24\"/);
  // 图片预览弹层不受影响（用户主动打开时必须即时显示）
  assert.match(surface, /src={`data:\$\{props\.image\.mimeType\};base64,\$\{props\.image\.data\}`}/);
});

test("agentId atom families are released on agent exit", () => {
  // agentId 每次新 UUID：closed 后 family 缓存只增不清是慢泄漏，退出时统一释放
  assert.match(runtimeAtoms, /export const agentExitedAtom = atom\(null/);
  assert.match(runtimeAtoms, /agentByIdAtomFamily\.remove\(agentId\);/);
  assert.match(runtimeAtoms, /runtimeCapabilityByAgentIdAtomFamily\.remove\(agentId\);/);
  assert.match(runtimeAtoms, /sessionIdByRuntimeAgentIdAtomFamily\.remove\(agentId\);/);
  // 联动：agents:state 全量推送中检测 closed 触发
  assert.match(bridge, /event\.sourceChannel === \"agents:state\" && Array\.isArray\(event\.payload\)/);
  assert.match(bridge, /tab\.status === \"closed\"/);
  assert.match(bridge, /store\.set\(agentExitedAtom, tab\.id\);/);
});
