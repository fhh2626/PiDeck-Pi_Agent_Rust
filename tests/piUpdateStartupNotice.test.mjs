import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("startup Pi update check is guarded against double invocation", () => {
  const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const main = readFileSync("src/renderer/src/main.tsx", "utf8");

  // 回归：StrictMode 下 useEffect([]) 在 dev 双执行，settings.get().then 回调跑两遍，
  // 未加闸门时「Pi 不是最新版本」toast 会弹两次。
  assert.match(main, /<React\.StrictMode>/);
  assert.match(app, /checkPiCliUpdateOnStartup\(\), 1200\)/);
  // 防重入：ref 置位必须在函数开头同步完成（并发回调先后到达时第二个直接跳过）
  assert.match(hook, /startupUpdateCheckDoneRef/);
  assert.match(hook, /useRef\(false\)/);
  assert.match(hook, /if \(startupUpdateCheckDoneRef\.current\) return;\n\s*startupUpdateCheckDoneRef\.current = true;/);
  // 注释说明为什么需要闸门（防回归：后人删 ref 时应看到业务规则）
  assert.match(hook, /StrictMode 下 useEffect/);
});

test("opening dev settings does not auto-detect pi; cached result is shown directly", () => {
  const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
  const modal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
  const settings = readFileSync("src/shared/types/settings.ts", "utf8");

  // 回归：打开开发设置 tab 曾自动触发一次 pi 路径检测（spawn 探测），
  // 现在只有手动点「检测环境」才检测；已检测成功的结果从 settings 缓存直接恢复显示。
  assert.doesNotMatch(modal, /activeTab === "dev" && props\.piStatus === null/);
  assert.match(modal, /不自动检测 pi/);
  // settings 持久化字段 + 恢复逻辑（piStatus 为 null 时从缓存回填）
  assert.match(settings, /piInstall\?: \{ command: string; version: string; runtimeKind\?:/);
  assert.match(hook, /settings\.piInstall && piStatus === null/);
  assert.match(hook, /persistPiInstall/);
  // 未检测到时清除旧缓存，避免残留旧路径
  assert.match(hook, /清除旧缓存，避免残留/);
});
