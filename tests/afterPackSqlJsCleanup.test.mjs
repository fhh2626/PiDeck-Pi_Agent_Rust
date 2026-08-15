import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { removeSqlJsNonRuntimeFiles } = await import("../scripts/after-pack-cleanup.js");

test("after-pack sql.js cleanup keeps only the Node wasm runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-sqljs-cleanup-"));
	const distDir = join(root, "sql.js", "dist");
	await mkdir(distDir, { recursive: true });

	try {
		await Promise.all([
			writeFile(join(distDir, "sql-wasm.js"), "runtime"),
			writeFile(join(distDir, "sql-wasm.wasm"), "wasm"),
			writeFile(join(distDir, "sql-wasm-debug.wasm"), "debug wasm"),
			writeFile(join(distDir, "sql-wasm-browser.js"), "browser"),
			writeFile(join(distDir, "sql-asm.js"), "asm"),
			writeFile(join(distDir, "worker.sql-asm.js"), "worker"),
		]);

		const result = await removeSqlJsNonRuntimeFiles(distDir);
		assert.equal(result.removedFiles, 4);
		assert.equal(await readFile(join(distDir, "sql-wasm.js"), "utf8"), "runtime");
		assert.equal(await readFile(join(distDir, "sql-wasm.wasm"), "utf8"), "wasm");
		await assert.rejects(readFile(join(distDir, "sql-asm.js")));
		await assert.rejects(readFile(join(distDir, "sql-wasm-debug.wasm")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
