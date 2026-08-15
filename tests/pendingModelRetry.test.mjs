import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { pendingModelRetryDelay } = loadTsCommonJs(
	"src/renderer/src/utils/pendingModelRetry.ts",
);

test("pending model retry uses bounded backoff before requiring recovery", () => {
	assert.equal(pendingModelRetryDelay(0), 500);
	assert.equal(pendingModelRetryDelay(1), 1500);
	assert.equal(pendingModelRetryDelay(2), 3000);
	assert.equal(pendingModelRetryDelay(3), undefined);
});
