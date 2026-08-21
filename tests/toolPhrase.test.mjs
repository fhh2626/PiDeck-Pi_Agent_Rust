import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 工具语义短语（学 Proma tool-phrase.ts）：折叠态显示可读中文短语，
// 替代完整命令行，让工具行更轻、更易扫读。
// 纯函数用 ts 编译 + vm 加载，避免模块路径解析负担。
const rawSource = readFileSync(
  "src/renderer/src/components/session/timeline/toolPhrase.ts",
  "utf8",
);
// 去掉 import 行（本测试直接传解析后的 input，不需要真实 parseToolArgs）；
// 保留 export，CommonJS 编译后挂到 module.exports。
const moduleSource = rawSource
  .replace(/^import .*$/gm, "")
  .replace("export interface ToolPhrase", "interface ToolPhrase");

function loadPhrase(toolName, input) {
  const js = ts.transpileModule(moduleSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console };
  vm.runInNewContext(js, sandbox);
  return sandbox.module.exports.getToolPhrase(toolName, input);
}

test("read tool produces a readable file phrase", () => {
  const phrase = loadPhrase("Read", { file_path: "src/main.ts" });
  assert.match(phrase.label, /读取 main\.ts/);
  assert.match(phrase.loadingLabel, /正在读取 main\.ts/);
});

test("bash tool shows the command", () => {
  const phrase = loadPhrase("Bash", { command: "npm run build" });
  assert.match(phrase.label, /执行 npm run build/);
  assert.match(phrase.loadingLabel, /正在执行 npm run build/);
});

test("grep tool shows the pattern", () => {
  const phrase = loadPhrase("Grep", { pattern: "TODO" });
  assert.match(phrase.label, /搜索 TODO/);
});

test("web_search tool uses a search phrase rather than a fetch phrase", () => {
  const phrase = loadPhrase("web_search", { query: "OpenAI Responses API" });
  assert.match(phrase.label, /搜索 OpenAI Responses API/);
  assert.match(phrase.loadingLabel, /正在搜索 OpenAI Responses API/);
});

test("write tool produces file phrase", () => {
  const phrase = loadPhrase("Write", { file_path: "a/b/new.ts" });
  assert.match(phrase.label, /写入 new\.ts/);
});

test("unknown/extension tool falls back to name + arg summary", () => {
  const phrase = loadPhrase("get_search_content", { query: "shadcn" });
  assert.match(phrase.label, /get_search_content shadcn/);
});
