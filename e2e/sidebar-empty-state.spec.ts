import { test, expect } from "./fixtures";

/**
 * 侧边栏「添加项目目录」空态引导回归（issue #149 同类反馈）：
 * 新用户只有内置 Chat 项目时，此前「项目」分组不渲染、只剩搜索行一个 24px + 图标，
 * 用户不知道可以添加自己的项目目录。现在无工作区项目时渲染空态引导卡片 + 显眼按钮。
 * 注意：本文件不得使用 test.use({ seedProjects })（顶层 use 会影响整个文件）。
 */
test("sidebar shows the add-directory guide when only the built-in Chat exists", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 内置 Chat 分组存在（标题「聊天」；Chat 是固定父项目，没有独立项目行）
	await expect(window.getByText("聊天").first()).toBeVisible({ timeout: 20_000 });
	// 空态引导可见（标题 + 说明 + 按钮）——getByText 会命中多个包含元素，取 first
	await expect(window.getByText("添加你的项目目录").first()).toBeVisible({ timeout: 10_000 });
	// 项目分组（空态）中只有引导卡片，没有项目行
	await expect(window.getByRole("treeitem", { name: "项目" })).toHaveCount(0);
	const addBtn = window.getByRole("button", { name: "添加项目" });
	await expect(addBtn.first()).toBeVisible();
	// 点击触发主进程目录选择器（原生 dialog 不阻塞页面，测试随 app 关闭结束）
	await addBtn.first().click();
});
