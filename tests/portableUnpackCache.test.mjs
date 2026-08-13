import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const portableScript = readFileSync("build/portable.nsi", "utf8");
const applyHelper = readFileSync("scripts/apply-portable-unpack-cache.js", "utf8");
const distWin = readFileSync("scripts/dist-win.js", "utf8");
const compileExe = readFileSync("scripts/compile-exe.js", "utf8");
const officialPortableLoader = readFileSync(
	"node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js",
	"utf8",
);

test("Windows portable reuses a versioned unpack cache instead of extracting every launch", () => {
	assert.equal(packageJson.build.portable?.unpackDirName, `PiDeck-portable-${packageJson.version}`);
	assert.match(portableScript, /IfFileExists "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" skip_extract 0/);
	assert.match(portableScript, /skip_extract:/);
	assert.match(portableScript, /Exec "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\} \$R0"/);
	assert.doesNotMatch(portableScript, /ExecWait "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\} \$R0"/);
	assert.ok(
		portableScript.indexOf("SetOutPath $EXEDIR") === -1,
		"cached portable launcher must not delete the unpack directory after launch",
	);
});

test("electron-builder portable target is patched to use the cached unpacker", () => {
	// electron-builder ignores build.portable.script and always reads templates/nsis/portable.nsi.
	assert.match(officialPortableLoader, /nsisTemplatesDir, "portable\.nsi"/);
	assert.match(applyHelper, /templates",\s*"nsis",\s*"portable\.nsi"/);
	assert.match(applyHelper, /build", "portable\.nsi"/);
	assert.match(distWin, /applyPortableUnpackCacheTemplate\(\)/);
	assert.match(distWin, /restorePortableUnpackCacheTemplate\(\)/);
	assert.match(compileExe, /applyPortableUnpackCacheTemplate\(\)/);
	assert.match(compileExe, /restorePortableUnpackCacheTemplate\(\)/);
});
