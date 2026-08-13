import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Windows packaging only ships the regular NSIS installer and zip", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.deepEqual(pkg.build?.win?.target, ["nsis", "zip"]);
	assert.equal(pkg.build?.portable, undefined);
	assert.equal(pkg.scripts?.["compile-exe"], undefined);
	assert.match(pkg.scripts?.["dist:win"] ?? "", /dist-win\.js/);

	const distWin = readFileSync("scripts/dist-win.js", "utf8");
	assert.match(distWin, /nsis \+ zip/);
	assert.match(distWin, /\["nsis", "zip"\]/);
	assert.doesNotMatch(distWin, /\bportable\b/);

	const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
	const windowsWorkflow = readFileSync(".github/workflows/build-windows.yml", "utf8");
	assert.match(releaseWorkflow, /electron-builder --win nsis zip/);
	assert.match(windowsWorkflow, /electron-builder --win nsis zip/);
	assert.doesNotMatch(releaseWorkflow, /--win nsis portable/);
	assert.doesNotMatch(windowsWorkflow, /--win nsis portable/);
});
