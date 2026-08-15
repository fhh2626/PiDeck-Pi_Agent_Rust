import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadHelper() {
  const filePath = "src/main/prompts/createUniquePrompt.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: nodeRequire,
  }, { filename: filePath });
  return module.exports;
}

test("unique prompt creation retries only the bounded name-conflict path", async () => {
  const { createUniquePrompt } = loadHelper();
  const calls = [];
  const result = await createUniquePrompt({
    baseName: "review",
    maxAttempts: 4,
    create: async (name) => {
      calls.push(name);
      if (calls.length < 3) throw { code: "already-exists" };
      return { name };
    },
    isAlreadyExists: (error) => error?.code === "already-exists",
  });

  assert.deepEqual(calls, ["review", "review-2", "review-3"]);
  assert.equal(result.name, "review-3");
});

test("unique prompt creation propagates non-conflict errors without retry", async () => {
  const { createUniquePrompt } = loadHelper();
  const failure = new Error("read-only");
  const calls = [];

  await assert.rejects(
    createUniquePrompt({
      baseName: "review",
      create: async (name) => {
        calls.push(name);
        throw failure;
      },
      isAlreadyExists: () => false,
    }),
    (error) => error === failure,
  );

  assert.deepEqual(calls, ["review"]);
});

test("prompt imports use the bounded helper and atomic prompt creation", () => {
  const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
  const xueManager = readFileSync("src/main/prompts/XuePromptManager.ts", "utf8");
  const promptManager = readFileSync("src/main/prompts/PromptManager.ts", "utf8");

  assert.match(storeIpc, /createUniquePrompt/);
  assert.match(xueManager, /createUniquePrompt/);
  assert.match(promptManager, /flag: "wx"/);
  assert.match(promptManager, /PromptAlreadyExistsError/);
});
