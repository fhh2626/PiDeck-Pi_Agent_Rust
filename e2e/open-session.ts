import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeedProject } from "./fixtures";

/**
 * 创建真实存在的临时项目目录（ProjectStore 需要路径有效），
 * 返回可传给 test.use({ seedProjects }) 的种子项目。
 */
export function makeSeedProject(name: string, id = `e2e-${name.toLowerCase().replace(/\s+/g, "-")}`): SeedProject {
	const dir = mkdtempSync(join(tmpdir(), `pideck-e2e-${name.toLowerCase().replace(/\s+/g, "-")}-`));
	mkdirSync(dir, { recursive: true });
	return { id, name, path: dir };
}

/**
 * 打开第一个项目会话（e2e 公共前置）：
 * 用内置 Chat 项目标题栏的「新会话」按钮（createDraft）——项目行内的
 * 「新建 Agent」是 hover 才显示的 dimmed actions（opacity-0 + pointer-events-none），
 * headless 下不可点；Chat 项目默认展开，按钮常驻可见。
 * exact:true 排除 Tab 栏的「新建会话」。
 * 等 composer 可输入（contenteditable="true"，TipTap 可用时不渲染 aria-disabled，
 * 见 agent-flow.spec.ts 注释）后返回 composer 定位器。
 */
export async function openFirstSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const newSession = window.getByRole("button", { name: "新会话", exact: true });
	await expect(newSession).toBeVisible({ timeout: 15_000 });
	await newSession.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}
