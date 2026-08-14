import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { firstLine, latestLine } = loadTsCommonJs("src/renderer/src/utils/thinkingSummary.ts");

test("firstLine 取第一行，无换行返回全文", () => {
	assert.equal(firstLine("abc\ndef"), "abc");
	assert.equal(firstLine("单行思考"), "单行思考");
	assert.equal(firstLine(""), "");
});

test("latestLine 取最新一行（尾部，tail -f 语义）", () => {
	assert.equal(latestLine("abc\ndef"), "def");
	// 结尾换行被 trimEnd 吃掉，仍取最后一个非空行
	assert.equal(latestLine("abc\ndef\n"), "def");
	assert.equal(latestLine("单行思考"), "单行思考");
});
