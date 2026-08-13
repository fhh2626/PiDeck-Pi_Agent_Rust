/**
 * afterPack 钩子：打包后执行多项清理，缩减安装包体积。
 *
 * 1. Locale 精简 —— 只保留中英文，删除 Electron 其余 52 个语言包（节省 ~42MB）
 * 2. 保留第三方包的运行时入口，清理文档、许可证、测试等非运行时文件
 *
 * 参考: https://www.electron.build/configuration/configuration#afterpack
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

/** 要保留的语言包列表（小写，无 .pak 后缀） */
const KEEP_LOCALES = new Set(["en-us", "zh-cn", "zh-tw"]);

/** asar 工具路径 */
const ASAR_BIN = path.join(__dirname, "..", "node_modules", ".bin", "asar");

/** 运行时当前平台标识，如 win32-x64 */
const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;

/** 递归删除目录 */
async function rmDir(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 递归获取目录总大小 */
async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        total += (await fs.promises.stat(full)).size;
      }
    }
  } catch { /* 忽略 */ }
  return total;
}

/**
 * 从 asar 中删除指定路径的文件/目录。
 * 利用 asar CLI 的 extract + repack 实现。
 */
async function stripFromAsar(asarPath, extractDir, removePaths, label) {
  console.log(`[afterPack] ${label}：正在提取 asar...`);

  // 提取 asar 到临时目录
  execSync(`"${ASAR_BIN}" extract "${asarPath}" "${extractDir}"`, {
    stdio: "pipe",
    timeout: 120_000,
  });

  let totalRemoved = 0;
  for (const relPath of removePaths) {
    const fullPath = path.join(extractDir, relPath);
    try {
      const stat = await fs.promises.stat(fullPath);
      const size = stat.isDirectory() ? await dirSize(fullPath) : stat.size;
      await fs.promises.rm(fullPath, { recursive: true, force: true });
      totalRemoved += size;
      console.log(`  [afterPack] 已删除: ${relPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } catch {
      // 路径不存在，忽略
    }
  }

  if (totalRemoved > 0) {
    // 重新打包为 asar, 覆盖原文件
    const tmpAsar = asarPath + ".tmp";
    execSync(
      `"${ASAR_BIN}" pack "${extractDir}" "${tmpAsar}"`,
      { stdio: "pipe", timeout: 120_000 },
    );
    fs.renameSync(tmpAsar, asarPath);

    // 清理临时目录
    await rmDir(extractDir);

    const oldSize = fs.statSync(asarPath).size + totalRemoved;
    const newSize = fs.statSync(asarPath).size;
    console.log(
      `[afterPack] ${label}: 节省 ${(totalRemoved / 1024 / 1024).toFixed(1)} MB (asar ${(oldSize / 1024 / 1024).toFixed(0)} → ${(newSize / 1024 / 1024).toFixed(0)} MB)`,
    );
  } else {
    await rmDir(extractDir);
    console.log(`[afterPack] ${label}: 无冗余文件可清理`);
  }

  return totalRemoved;
}

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
exports.default = async function (context) {
  const { appOutDir } = context;

  // ====================================
  // 1. Locale 精简
  // ====================================
  const localesDir = path.join(appOutDir, "locales");
  try {
    const entries = await fs.promises.readdir(localesDir);
    let removed = 0;
    let kept = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.endsWith(".pak")) continue;
      const localeKey = entry.replace(/\.pak$/i, "").toLowerCase();
      if (!KEEP_LOCALES.has(localeKey)) {
        const fullPath = path.join(localesDir, entry);
        try {
          const stat = await fs.promises.stat(fullPath);
          totalBytes += stat.size;
          await fs.promises.unlink(fullPath);
          removed++;
        } catch { /* 忽略 */ }
      } else {
        kept++;
      }
    }

    if (removed > 0) {
      console.log(
        `[afterPack] 语言包: 已删除 ${removed} 个 (${(totalBytes / 1024 / 1024).toFixed(1)} MB)，保留 ${kept} 个: ${[...KEEP_LOCALES].join(", ")}`,
      );
    }
  } catch {
    // 没有 locales 目录（Linux 等），跳过
  }

  // ====================================
  // 2. 根目录 Electron 基础设施清理
  //    LICENSES.chromium.html 是 Chromium 全部开源协议文本，
  //    对最终用户无实际用途（15MB）。chrome_*.pak 是 Chrome 的 UI 资源，
  //    Electron 桌面应用不使用浏览器 UI，可安全删除。
  // ====================================
  const rootCleanups = [
    { path: "LICENSES.chromium.html", desc: "Chromium 开源许可证大全" },
    { path: "chrome_100_percent.pak", desc: "Chrome 常规 DPI UI 资源" },
    { path: "chrome_200_percent.pak", desc: "Chrome 高DPI UI 资源" },
  ];

  for (const { path: filename, desc } of rootCleanups) {
    const fullPath = path.join(appOutDir, filename);
    try {
      const stat = await fs.promises.stat(fullPath);
      await fs.promises.unlink(fullPath);
      console.log(`[afterPack] 已删除根目录 ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)：${desc}`);
    } catch {
      // 文件不存在则跳过
    }
  }

  // ====================================
  // 3. asar 内 node_modules 冗余清理
  //    一次提取 → 集中清理 → 一次打包，避免反复 extract/repack。
  // ====================================
  const asarPath = path.join(appOutDir, "resources", "app.asar");

  if (!fs.existsSync(asarPath)) {
    console.log("[afterPack] 未找到 app.asar，跳过 node_modules 清理");
    return;
  }

  const extractDir = path.join(appOutDir, ".asar-extract");
  console.log(`[afterPack] 正在提取 asar 进行清理...`);
  execSync(`"${ASAR_BIN}" extract "${asarPath}" "${extractDir}"`, {
    stdio: "pipe",
    timeout: 120_000,
  });

  let totalRemoved = 0;

  // --- 3a. 删除所有 node_modules 中的 source map、文档、测试文件 ---
  const nmExtractDir = path.join(extractDir, "node_modules");
  if (fs.existsSync(nmExtractDir)) {
    async function cleanNodeModules(dir) {
      let removedInDir = 0;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (!entry.isDirectory()) {
            const lowerName = entry.name.toLowerCase();
            // 删除：source map、README、CHANGELOG、AUTHORS、Markdown 文档
            if (
              entry.name.endsWith(".js.map") ||
              entry.name.endsWith(".map") ||
              entry.name.endsWith(".d.ts") ||
              lowerName === "readme.md" ||
              lowerName === "changelog.md" ||
              lowerName === "contributing.md" ||
              lowerName === "authors" ||
              lowerName === "authors.md" ||
              entry.name === "LICENSE" ||
              lowerName === "license.md" ||
              lowerName === "license.txt"
            ) {
              const stat = await fs.promises.stat(full);
              if (stat.size > 0) {
                await fs.promises.unlink(full);
                removedInDir += stat.size;
              }
            }
          } else if (
            entry.name === "node_modules" ||
            ["test", "tests", "spec", "__tests__", "__snapshots__", "__mocks__"].includes(entry.name)
          ) {
            // 删除测试目录（不进入递归，直接删整个目录）
            try {
              const testDirSize = await dirSize(full);
              await rmDir(full);
              removedInDir += testDirSize;
            } catch { /* 忽略 */ }
          } else {
            // 递归进入普通目录
            removedInDir += await cleanNodeModules(full);
          }
        }
      } catch { /* 无权限则跳过 */ }
      return removedInDir;
    }

    const docBytes = await cleanNodeModules(nmExtractDir);
    if (docBytes > 0) {
      totalRemoved += docBytes;
      console.log(`  [afterPack] 已删除 node_modules 中文档/SourceMap (${(docBytes / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  // --- 3b2. 删除 asar 内 node-pty 非当前平台的 prebuild（.node 文件被 electron-builder 自动解包到 asar.unpacked，
  //    但 asar 内仍保留了所有平台的副本，平台过滤只在 afterPack 上一步做了 asar.unpacked 的清理）---
  const nodePtyPrebuildDir = path.join(extractDir, "node_modules", "node-pty", "prebuilds");
  if (fs.existsSync(nodePtyPrebuildDir)) {
    try {
      const entries = await fs.promises.readdir(nodePtyPrebuildDir, { withFileTypes: true });
      const keepPrefix = CURRENT_PLATFORM;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === keepPrefix) continue;
        const fullPath = path.join(nodePtyPrebuildDir, entry.name);
        const size = await dirSize(fullPath);
        await rmDir(fullPath);
        totalRemoved += size;
        console.log(`  [afterPack] asar 内已删除 prebuild: ${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch { /* 目录不存在则跳过 */ }
  }

  // --- 3c. 重新打包 asar ---
  if (totalRemoved > 0) {
    const tmpAsar = asarPath + ".tmp";
    execSync(`"${ASAR_BIN}" pack "${extractDir}" "${tmpAsar}"`, {
      stdio: "pipe",
      timeout: 120_000,
    });
    const oldSize = fs.statSync(asarPath).size;
    fs.renameSync(tmpAsar, asarPath);
    const newSize = fs.statSync(asarPath).size;
    console.log(`[afterPack] asar: 节省 ${(totalRemoved / 1024 / 1024).toFixed(1)} MB (${(oldSize / 1024 / 1024).toFixed(0)} → ${(newSize / 1024 / 1024).toFixed(0)} MB)`);
  } else {
    console.log(`[afterPack] asar: 无冗余可清理`);
  }

  // 清理临时目录
  await rmDir(extractDir);

  // ====================================
  // 4. node-pty 跨平台 prebuild 清理（asar.unpacked）
  // 在 Windows 打包时只保留 win32-x64，删除其余 3 个平台的预编译二进制。
  // ====================================
  const nodePtyDir = path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");
  if (fs.existsSync(nodePtyDir)) {
    try {
      const entries = await fs.promises.readdir(nodePtyDir, { withFileTypes: true });
      const keepPrefix = CURRENT_PLATFORM;

      let removed = 0;
      let totalPrebuildBytes = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === keepPrefix) {
          console.log(`  [afterPack] 已保留 prebuild: ${entry.name}`);
          continue;
        }
        const fullPath = path.join(nodePtyDir, entry.name);
        const size = await dirSize(fullPath);
        await rmDir(fullPath);
        totalPrebuildBytes += size;
        removed++;
        console.log(`  [afterPack] 已删除 prebuild: ${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }

      if (removed > 0) {
        console.log(`[afterPack] node-pty prebuilds: 已删除 ${removed} 个 (${(totalPrebuildBytes / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch { /* 目录不存在则跳过 */ }
  }

  // ====================================
  // 5. node-pty 内 source map 清理（asar.unpacked）
  // ====================================
  const nodePtyUnpacked = path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty");
  if (fs.existsSync(nodePtyUnpacked)) {
    let mapFiles = 0;
    let mapBytes = 0;

    async function walk(dir) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.name.endsWith(".map")) {
            const stat = await fs.promises.stat(full);
            mapBytes += stat.size;
            await fs.promises.unlink(full);
            mapFiles++;
          }
        }
      } catch { /* */ }
    }

    await walk(nodePtyUnpacked);
    if (mapFiles > 0) {
      console.log(`  [afterPack] node-pty source map: 已删除 ${mapFiles} 个 (${(mapBytes / 1024).toFixed(0)} KB)`);
    }
  }
};
