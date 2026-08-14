import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
  }, { filename: filePath });
  return module.exports;
}

const policy = compileModule("src/main/security/policy.ts");
const {
  assertAuthorizedFilePath,
  isPathWithinAuthorizedRoots,
  UnauthorizedFilePathError,
} = compileModule("src/main/fs/authorizedPaths.ts", {
  "../security/policy": policy,
});

test("authorized paths accept descendants and reject adjacent directories", () => {
	assert.equal(
		isPathWithinAuthorizedRoots("C:/work/project/src/file.ts", ["C:/work/project"]),
		true,
	);
	assert.equal(
		isPathWithinAuthorizedRoots("C:/work/project-evil/file.ts", ["C:/work/project"]),
		false,
	);
	assert.equal(
		isPathWithinAuthorizedRoots("C:/outside/file.ts", ["C:/work/project"]),
		false,
	);
});

test("authorized paths normalize traversal before checking containment", () => {
	assert.equal(
		assertAuthorizedFilePath("C:/work/project/src/../file.ts", ["C:/work/project"], "read"),
		"C:\\work\\project\\file.ts",
	);
	assert.throws(
		() => assertAuthorizedFilePath("C:/work/project/../../secret.txt", ["C:/work/project"], "read"),
		(error) => error instanceof UnauthorizedFilePathError && error.code === "FILE_PATH_NOT_AUTHORIZED",
	);
});

test("authorized paths support multiple roots for project and global resources", () => {
	assert.equal(
		isPathWithinAuthorizedRoots("C:/Users/test/.pi/agent/prompts/review.md", [
			"C:/work/project",
			"C:/Users/test/.pi/agent",
		]),
		true,
	);
});
