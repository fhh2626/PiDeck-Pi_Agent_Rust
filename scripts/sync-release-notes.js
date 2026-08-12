/**
 * sync-release-notes.js
 *
 * 从 CHANGELOG.zh-CN.md 自动提取最新版本亮点，同步到：
 *   - README.zh-CN.md 的「更新亮点」区块
 *   - README.md 的「Release Highlights」区块
 *   - docs-site/changelog.md 的最近版本条目
 *
 * 用法：
 *   node scripts/sync-release-notes.js          # 预览变更
 *   node scripts/sync-release-notes.js --apply   # 应用变更
 *   node scripts/sync-release-notes.js --version 0.6.6  # 指定版本
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ── 解析 CHANGELOG ──────────────────────────────────────────────────

function parseChangelog(lang) {
  const file = path.join(ROOT, `CHANGELOG${lang === "zh" ? ".zh-CN" : ""}.md`);
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");

  // 找到最新版本（第一个 ## v 开头）
  let versionStart = -1;
  let versionEnd = -1;
  let versionLine = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## v?([\d.]+(?:\-beta\.\d+)?)/);
    if (m) {
      if (versionStart === -1) {
        versionStart = i;
        versionLine = lines[i];
      } else {
        versionEnd = i;
        break;
      }
    }
  }
  if (versionStart === -1) return null;

  const section = lines.slice(versionStart, versionEnd).join("\n");
  const version = versionLine.replace(/^##\s+/, "").replace(/\s*-\s*\d{4}-\d{2}-\d{2}/, "").trim();

  // 提取日期
  const dateMatch = versionLine.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : "";

  // 提取亮点条目：按小节分组，小节标题的 emoji 决定条目类型
  const highlights = [];
  let currentSection = "";
  for (const line of lines.slice(versionStart, versionEnd)) {
    const sectionMatch = line.match(/^###\s*(🚀|✨|🐛|🧪)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    const itemMatch = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*/);
    if (itemMatch && currentSection) {
      highlights.push(`${currentSection} **${itemMatch[1]}**`);
    }
  }

  // 提取前 10 个 🚀 作为主要亮点
  const majorFeatures = highlights
    .filter((h) => h.startsWith("🚀"))
    .slice(0, 12)
    .map((h) => h.replace(/^🚀\s+/, ""));
  // 提取 ✨ 和 🐛
  const improvements = highlights
    .filter((h) => h.startsWith("✨") || h.startsWith("🐛"))
    .slice(0, 4)
    .map(stripEmojiPrefix);
  const experimental = highlights
    .filter((h) => h.startsWith("🧪"))
    .slice(0, 2)
    .map((h) => h.replace(/^🧪\s+/, ""));

  return { version, date, majorFeatures, improvements, experimental, highlights };
}

function stripBold(text) {
  return text.replace(/^\*\*|\*\*$/g, "");
}

function generateReadmeBlock(data, lang) {
  const { version, date, majorFeatures, improvements, experimental } = data;
  const isZh = lang === "zh";
  const lines = [];

  if (isZh) {
    lines.push(`> **最新版本 ${version}**（${date}）`);
    lines.push("");
    lines.push(`### ${version} 更新亮点`);
  } else {
    lines.push(`> **Latest: ${version}** (${date})`);
    lines.push("");
    lines.push(`### ${version} Release Highlights`);
  }

  for (const feat of majorFeatures) {
    lines.push(`- 🚀 **${stripBold(feat)}**`);
  }
  for (const imp of improvements) {
    lines.push(`- ✨ **${stripBold(imp)}**`);
  }
  for (const exp of experimental) {
    lines.push(isZh ? `- 🧪 **${stripBold(exp)}**` : `- 🧪 **${stripBold(exp)}**`);
  }

  lines.push("");
  lines.push(isZh ? "[查看完整更新日志 →](CHANGELOG.zh-CN.md)" : "[View Full Changelog →](CHANGELOG.md)");

  return lines.join("\n");
}

function updateReadme(readmePath, newBlock) {
  const content = fs.readFileSync(readmePath, "utf8");
  const lines = content.split("\n");

  // 找到更新日志区块的开始和结束
  const startMarker = "> **";
  let blockStart = -1;
  let blockEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(startMarker)) {
      blockStart = i;
      // 找到结束（下一个空行后的非空行，或 --- 分隔线）
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith("---") || lines[j].trim().startsWith("[")) {
          blockEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (blockStart === -1) {
    console.error(`  ⚠️  Could not find changelog block in ${readmePath}`);
    return false;
  }

  // 计算实际替换范围：从 start 到 "查看完整更新日志" 行之后
  let endLine = blockEnd;
  for (let i = blockEnd; i < Math.min(blockEnd + 5, lines.length); i++) {
    if (lines[i].includes("查看完整更新日志") || lines[i].includes("View Full Changelog")) {
      endLine = i + 1;
      break;
    }
  }

  const oldBlock = lines.slice(blockStart, endLine).join("\n");
  const newContent = content.replace(oldBlock, newBlock);

  if (newContent === content) {
    console.error(`  ⚠️  No changes made to ${readmePath}`);
    return false;
  }

  fs.writeFileSync(readmePath, newContent);
  return true;
}

function updateDocsSite(data) {
  const { version, date, majorFeatures, improvements } = data;
  const filePath = path.join(ROOT, "docs-site", "changelog.md");
  let content = fs.readFileSync(filePath, "utf8");

  // 去掉旧版 v0.6.6 或 v0.6.6-beta.x 条目（如果有），避免重复
  content = content.replace(/^## v0\.6\.6(?:-beta\.\d+)?[^\n]*\n[\s\S]*?(?=^## v0\.6\.5)/m, "");

  const lines = content.split("\n");

  // 找到第一个版本号行（v0.6.5 或更早），在其前面插入新条目
  const firstVersionIdx = lines.findIndex(l => /^##\s+v0/.test(l));
  if (firstVersionIdx === -1) {
    console.error("  ⚠️  Could not find version entry in docs-site/changelog.md");
    return false;
  }

  // 生成新条目
  const newEntry = [
    `## ${version}`,
    "",
    `发布时间：${date}`,
    "",
  ];
  for (const feat of majorFeatures.slice(0, 15)) {
    newEntry.push(`- 🚀 **${stripBold(feat)}**`);
  }
  for (const imp of improvements.slice(0, 4)) {
    newEntry.push(`- ✨ **${stripBold(imp)}**`);
  }
  newEntry.push("");

  const newContent = [
    ...lines.slice(0, firstVersionIdx),
    ...newEntry,
    ...lines.slice(firstVersionIdx),
  ].join("\n");

  fs.writeFileSync(filePath, newContent);
  return true;
}

// ── 主流程 ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const versionFilter = args.find((a) => a.startsWith("--version="));
  const targetVersion = versionFilter ? versionFilter.split("=")[1] : null;

  console.log("=== 发行说明同步工具 ===");
  console.log(`模式: ${apply ? "应用" : "预览"}${targetVersion ? ` (版本: ${targetVersion})` : ""}`);
  console.log("");

  // 解析中英文 CHANGELOG
  const zhData = parseChangelog("zh");
  const enData = parseChangelog("en");

  if (!zhData || !enData) {
    console.error("无法解析 CHANGELOG");
    process.exit(1);
  }

  const version = zhData.version;
  console.log(`最新版本: ${version} (${zhData.date})`);
  console.log("");

  if (targetVersion && version !== targetVersion) {
    console.log(`  ⏭️  跳过: 目标版本 ${targetVersion} 不等于最新版本 ${version}`);
    process.exit(0);
  }

  // 生成 README 区块
  const zhBlock = generateReadmeBlock(zhData, "zh");
  const enBlock = generateReadmeBlock(enData, "en");

  console.log("=== 中文 README 区块 ===");
  console.log(zhBlock);
  console.log("");
  console.log("=== 英文 README 区块 ===");
  console.log(enBlock);
  console.log("");

  if (!apply) {
    console.log("💡 使用 --apply 参数应用变更");
    console.log("💡 使用 --version=0.6.6 指定版本");
    return;
  }

  // 应用变更
  console.log("正在应用变更...");

  const zhReadme = path.join(ROOT, "README.zh-CN.md");
  const enReadme = path.join(ROOT, "README.md");

  const zhOk = updateReadme(zhReadme, zhBlock);
  const enOk = updateReadme(enReadme, enBlock);
  const docsOk = updateDocsSite(zhData);

  if (zhOk) console.log("  ✅ README.zh-CN.md 已更新");
  if (enOk) console.log("  ✅ README.md 已更新");
  if (docsOk) console.log("  ✅ docs-site/changelog.md 已更新");
  if (!zhOk && !enOk && !docsOk) {
    console.log("  ⚠️  无需更新，或未找到匹配区块");
  }

  console.log("");
  if (zhOk || enOk || docsOk) {
    console.log("📋 三处同步完成。请检查后提交：");
    console.log("   git diff README.md README.zh-CN.md docs-site/changelog.md");
  }
}

/**
 * 去掉条目开头的 ✨/🐛 emoji 前缀（供 README/docs-site 重新归类展示）。
 * 必须带 u flag：🐛/✨ 是 surrogate pair，字符类不带 u 只能匹配半个 code unit，
 * 导致 replace 静默失败、emoji 残留（曾出现 README 里 ✨ 区混入 🐛 前缀）。
 */
function stripEmojiPrefix(text) {
  return text.replace(/^[✨🐛]\s+/u, "");
}

// 导出核心函数供单测使用；CLI 直接执行时只跑 main()
module.exports = { stripEmojiPrefix };

if (require.main === module) {
  main();
}
