import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LogLineCache } from "../src/main/logging/logLineCache.ts";

/**
 * LogLineCache 缓存契约：
 * 日志文件指纹（mtime+size）未变时 linesOf 必须零 IO 复用缓存——
 * 这是"每次进入设置日志 tab 都全量重读所有日志文件"回归的看门测试。
 */

async function makeCache() {
	const dir = await mkdtemp(join(tmpdir(), "loglinecache-"));
	const file = join(dir, "app-2026-01-01.log");
	const realStat = (p) => stat(p);
	const realRead = (p) => import("node:fs/promises").then((m) => m.readFile(p, "utf8"));
	return { dir, file, cache: new LogLineCache({ readFile: realRead, stat: realStat }, 8, 10) };
}

test("linesOf reads file once then reuses cache while fingerprint is unchanged", async () => {
	const { dir, file, cache } = await makeCache();
	try {
		// 规整 mtime 到秒级整数毫秒（文件系统会截断小数，需先规整再取指纹）
		const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
		await writeFile(file, "line1\nline2\n");
		await utimes(file, t0, t0);

		let readCount = 0;
		const counting = new LogLineCache(
			{
				readFile: async (p) => {
					readCount += 1;
					const fs = await import("node:fs/promises");
					return fs.readFile(p, "utf8");
				},
				stat,
			},
			8,
			10,
		);

		const first = await counting.linesOf(file);
		assert.deepEqual(first, ["line1", "line2"]);
		assert.equal(readCount, 1);

		// 等长替换内容并回滚 mtime：指纹不变 → 必须返回缓存（零重读）
		await writeFile(file, "line9\nline8\n");
		await utimes(file, t0, t0);

		const second = await counting.linesOf(file);
		assert.deepEqual(second, ["line1", "line2"], "指纹未变应复用缓存");
		assert.equal(readCount, 1, "指纹未变不得重读文件");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("append changes fingerprint and rescans tail lines", async () => {
	const { dir, file, cache } = await makeCache();
	try {
		const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
		await writeFile(file, "a\n");
		await utimes(file, t0, t0);
		await cache.linesOf(file);

		// append（当天日志持续写入）：mtime+size 变化 → 重读并含新行
		await writeFile(file, "a\nb\n");
		const lines = await cache.linesOf(file);
		assert.deepEqual(lines, ["a", "b"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("lines are tail-truncated to maxLinesPerFile", async () => {
	const { dir, file, cache } = await makeCache();
	try {
		await writeFile(file, Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n"));
		const lines = await cache.linesOf(file);
		assert.equal(lines.length, 10, "只保留尾部 10 行");
		assert.equal(lines[0], "line15");
		assert.equal(lines[9], "line24");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("clear() drops cached lines (log clear must not resurrect old content)", async () => {
	const { dir, file, cache } = await makeCache();
	try {
		const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
		await writeFile(file, "old\n");
		await utimes(file, t0, t0);
		assert.deepEqual(await cache.linesOf(file), ["old"]);

		// 模拟日志清除：文件删除 + clear；文件重建后必须读到新内容而非缓存旧行
		await rm(file);
		cache.clear();
		await writeFile(file, "new\n");
		assert.deepEqual(await cache.linesOf(file), ["new"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing file fingerprints as missing and recovers when file appears", async () => {
	const { dir, file, cache } = await makeCache();
	try {
		// 文件不存在：返回空（readFile catch）
		assert.deepEqual(await cache.linesOf(file), []);
		await writeFile(file, "appeared\n");
		assert.deepEqual(await cache.linesOf(file), ["appeared"], "文件出现应重读");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
