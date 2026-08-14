import { test, expect } from "./mock-pi-fixture";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git 面板端到端（#113 3.4-14）：真实临时 git 仓库 + mock pi 环境，
 * 覆盖 状态(status) → 行内 diff → 暂存 → 提交 的完整链路，
 * 并在仓库侧用 git log 复核提交真实落盘。
 */

const repoDir = join(tmpdir(), "pideck-git-e2e-repo");

function git(args: string) {
	return execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8" }).trim();
}

// 仓库在模块加载时就绪（fixture 启动 app 前执行），用固定路径便于用例内直接变更文件
rmSync(repoDir, { recursive: true, force: true });
mkdirSync(repoDir, { recursive: true });
git("init -b main");
git("config user.email e2e@pideck.local");
git("config user.name pideck-e2e");
writeFileSync(join(repoDir, "a.txt"), "hello\n");
git("add .");
git("commit -m init");

test.use({
	seedProjects: [{ id: "e2e-git-repo", name: "GitE2E", path: repoDir }],
});

test("git panel: status -> diff -> stage -> commit", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 选中种子项目（项目行显示目录 basename），并在该项目下新建会话草案
	// （头部抽屉开关只在有会话视图时渲染；注意「新建 Agent」图标每个项目行都有，
	//  必须限定在目标项目行内点击，否则会落到聊天项目上）
	const projectRow = window.locator(".conversation", { hasText: "pideck-git-e2e" }).first();
	await projectRow.click();
	await projectRow.locator('.project-action[title="新建 Agent"]').click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });

	// 先展开抽屉（rail 只在抽屉打开期间渲染），再切到 Git tab
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true", { timeout: 5000 });
	await window.locator('[data-testid="drawer-rail-git"]').click();
	const panel = window.locator(".git-panel");
	await expect(panel).toBeVisible({ timeout: 15_000 });
	// 分支标签反映真实仓库状态
	await expect(panel.locator(".git-branch-label")).toHaveText("main", { timeout: 15_000 });

	// 制造一处工作区改动并刷新状态
	appendFileSync(join(repoDir, "a.txt"), "changed by e2e\n");
	await panel.locator("#git-pane-changes").getByRole("button", { name: "刷新" }).click();
	const changedFile = panel.locator(".git-resource-name", { hasText: "a.txt" }).first();
	await expect(changedFile).toBeVisible({ timeout: 15_000 });

	// 行内 diff：点击文件名打开工作区 diff 查看器，确认内容后关闭
	await panel.locator(".git-resource-open", { hasText: "a.txt" }).first().click();
	const diffHeader = window.locator(".file-diff-header");
	await expect(diffHeader).toBeVisible({ timeout: 10_000 });
	await expect(diffHeader).toContainText("a.txt");
	await window.locator(".file-diff-close").click();
	await expect(diffHeader).toBeHidden();

	// 全部暂存 → 提交
	await panel.getByRole("button", { name: "全部暂存" }).click();
	await expect(panel.locator(".git-scm-input")).toBeEnabled({ timeout: 10_000 });
	await panel.locator(".git-scm-input").fill("e2e: update a.txt");
	await panel.locator(".git-commit-btn").click();

	// 提交后面板回到「没有待提交的更改」
	await expect(panel.locator(".git-status-msg")).toContainText("没有待提交的更改", { timeout: 15_000 });

	// 仓库侧复核：提交真实存在且为最新一条
	const log = git("log --oneline -2");
	expect(log.split("\n")[0]).toContain("e2e: update a.txt");
});
