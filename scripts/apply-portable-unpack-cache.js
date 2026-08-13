/**
 * electron-builder 的 portable 目标会忽略 build.portable.script，
 * 始终读取 app-builder-lib/templates/nsis/portable.nsi。
 * 打包前把官方模板换成按版本复用 TEMP 缓存的启动器，避免每次双击都全量解压。
 */
const fs = require("node:fs");
const path = require("node:path");

const OFFICIAL_TEMPLATE = path.join(
  __dirname,
  "..",
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "portable.nsi",
);
const CUSTOM_TEMPLATE = path.join(__dirname, "..", "build", "portable.nsi");
const BACKUP_TEMPLATE = `${OFFICIAL_TEMPLATE}.pideck-backup`;

function applyPortableUnpackCacheTemplate() {
  if (!fs.existsSync(CUSTOM_TEMPLATE)) {
    throw new Error(`missing custom portable template: ${CUSTOM_TEMPLATE}`);
  }
  if (!fs.existsSync(OFFICIAL_TEMPLATE)) {
    throw new Error(`missing official portable template: ${OFFICIAL_TEMPLATE}`);
  }
  if (!fs.existsSync(BACKUP_TEMPLATE)) {
    fs.copyFileSync(OFFICIAL_TEMPLATE, BACKUP_TEMPLATE);
  }
  fs.copyFileSync(CUSTOM_TEMPLATE, OFFICIAL_TEMPLATE);
}

function restorePortableUnpackCacheTemplate() {
  if (!fs.existsSync(BACKUP_TEMPLATE)) return;
  fs.copyFileSync(BACKUP_TEMPLATE, OFFICIAL_TEMPLATE);
  fs.unlinkSync(BACKUP_TEMPLATE);
}

module.exports = {
  applyPortableUnpackCacheTemplate,
  restorePortableUnpackCacheTemplate,
};

if (require.main === module) {
  const command = process.argv[2];
  if (command === "restore") {
    restorePortableUnpackCacheTemplate();
  } else {
    applyPortableUnpackCacheTemplate();
  }
}
