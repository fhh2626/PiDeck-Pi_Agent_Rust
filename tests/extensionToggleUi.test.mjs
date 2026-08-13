import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("extension menu exposes enable and disable actions beside uninstall", () => {
	const source = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");

	assert.match(source, /toggle: \(source: string, enabled: boolean\)/);
	assert.match(source, /getExtensionsApi\(\)\.toggle\(extension\.source, enabled\)/);
	assert.match(source, /extension\.enabled === false/);
	assert.match(source, /CircleOff/);
	assert.match(source, /CircleCheck/);
});
