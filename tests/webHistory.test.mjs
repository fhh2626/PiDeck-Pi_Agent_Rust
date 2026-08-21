import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { hasMoreWebHistory, canRequestWebHistoryPage } = loadTsCommonJs("src/renderer/src/web/webHistory.ts");

test("web history stays loadable before the first page arrives", () => {
	assert.equal(hasMoreWebHistory({ loaded: false, catalogMessageCount: 180 }), true);
	assert.equal(hasMoreWebHistory({ loaded: false, catalogMessageCount: 0 }), false);
	assert.equal(hasMoreWebHistory({ loaded: false }), true);
});

test("web history stays loadable after a failed first page", () => {
	assert.equal(hasMoreWebHistory({
		loaded: false,
		catalogMessageCount: 80,
		meta: { total: 0, nextBefore: null, status: "error" },
	}), true);
});

test("web history uses nextBefore once the first page is ready", () => {
	assert.equal(hasMoreWebHistory({
		loaded: true,
		catalogMessageCount: 180,
		meta: { total: 180, nextBefore: 80, status: "ready" },
	}), true);
	assert.equal(hasMoreWebHistory({
		loaded: true,
		catalogMessageCount: 40,
		meta: { total: 40, nextBefore: null, status: "ready" },
	}), false);
});

test("new web sessions with an empty ready cursor do not show load more", () => {
	assert.equal(hasMoreWebHistory({
		loaded: true,
		catalogMessageCount: 0,
		meta: { total: 0, nextBefore: null, status: "ready" },
	}), false);
});

test("web history request stays allowed when streaming marked the session loaded first", () => {
	assert.equal(canRequestWebHistoryPage({ loaded: false }), true);
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
		meta: { total: 0, nextBefore: null, status: "error" },
	}), true);
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
		meta: { total: 180, nextBefore: 80, status: "ready" },
	}), true);
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
	}), true, "streaming may mark loaded before the first page returns");
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
		meta: { total: 12, nextBefore: null, status: "ready" },
	}), false);
});
