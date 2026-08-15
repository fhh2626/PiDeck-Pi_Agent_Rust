import { test, expect } from "./mock-pi-fixture";

/**
 * Web 服务 React 前端（A2）端到端：
 * fixture 预置 webServiceEnabled=true + webServicePort=8765（见 mock-pi-fixture）。
 * 覆盖：
 * 1) 加载 → 新建会话 → 发消息 → 流式渲染完整回复
 * 2) 思考/工具帧 → 折叠思考卡片 + 工具卡片渲染
 * 3) 会话切换 → useChat per-id 缓存保留历史消息
 * 4) 暗色模式（prefers-color-scheme）→ data-theme=dark
 * 5) 移动端/平板视口 → 布局不横向溢出，头部与输入区完整落在视觉视口内
 */
test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8765,
	},
});

async function waitForHealthy(baseUrl: string): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const health = await fetch(`${baseUrl}/api/health`).catch(() => null);
		if (health?.ok) return true;
	}
	return false;
}

test("web service: load, create session, send message and stream via /api/chat", async ({ app }) => {
	test.setTimeout(120_000);

	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);

	// 主窗口导航到 Web 服务根路径（Electron context 不支持 newPage）
	const page = await app.firstWindow();
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();
	// 侧栏品牌区 + 项目列表由 /api/state 轮询填充（内置聊天项目）
	await expect(page.locator(".chat-list-pane .project-group")).toHaveCount(1, { timeout: 20_000 });

	// 点击项目行内 "+" 新建会话（POST /api/sessions）
	await page.locator(".project-group .project-action").click();
	// 会话列表出现一项（active）
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });

	// 发送消息 → useChat 走 /api/chat → mock pi 流式 text_delta → 打字机渲染
	const textarea = page.locator("textarea#prompt");
	await textarea.fill("你好 web");
	await page.keyboard.press("Enter");

	// 流式中间态 + 完整收尾（mock pi 回复含固定文案）
	const assistantText = page.locator(".assistant-text");
	await expect(assistantText).toContainText("Mock 回复：「你好 web」", { timeout: 30_000 });
	await expect(assistantText).toContainText("流式渲染验证完成", { timeout: 30_000 });
});

test("web service: thinking and tool frames render as cards", async ({ app }) => {
	test.setTimeout(120_000);

	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);

	const page = await app.firstWindow();
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator(".chat-list-pane .project-group")).toHaveCount(1, { timeout: 20_000 });

	await page.locator(".project-group .project-action").click();
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });

	const textarea = page.locator("textarea#prompt");
	await textarea.fill("带思考工具 THINK TOOL");
	await page.keyboard.press("Enter");

	// 思考卡片（reasoning part → 折叠卡片，默认展开）
	await expect(page.locator(".assistant-text")).toContainText("流式渲染验证完成", { timeout: 30_000 });
	await expect(page.locator("text=推理：先分析文件结构...")).toBeVisible({ timeout: 30_000 });
	// 工具卡片（tool-invocation part → .tool-card，工具名 bash）
	await expect(page.locator(".tool-card[data-tool-name='bash']")).toHaveCount(1, { timeout: 30_000 });
});

test("web service: switching sessions keeps history in per-id cache", async ({ app }) => {
	test.setTimeout(120_000);

	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);

	const page = await app.firstWindow();
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator(".chat-list-pane .project-group")).toHaveCount(1, { timeout: 20_000 });

	// 会话 A：新建 + 发消息 + 等回复完成
	await page.locator(".project-group .project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });
	const textarea = page.locator("textarea#prompt");
	await textarea.fill("会话 A 的第一条消息");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text")).toContainText("流式渲染验证完成", { timeout: 30_000 });

	// 会话 B：新建另一个会话（切到 B，composer 清空）
	await page.locator(".project-group .project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row")).toHaveCount(2, { timeout: 20_000 });
	const activeRow = page.locator(".chat-list-pane .session-row.active");
	await expect(activeRow).toHaveCount(1, { timeout: 20_000 });

	// 切回会话 A：会话列表排序不固定，直接点「非激活」的那一行（新建的 B 是激活的）
	const rows = page.locator(".chat-list-pane .session-row");
	await expect(rows).toHaveCount(2, { timeout: 20_000 });
	const inactiveIndex = await rows.evaluateAll((elements) =>
		elements.findIndex((el) => !el.classList.contains("active")),
	);
	expect(inactiveIndex).toBeGreaterThanOrEqual(0);
	await rows.nth(inactiveIndex).click();
	await expect(page.locator(".user-turn")).toContainText("会话 A 的第一条消息", { timeout: 20_000 });
	await expect(page.locator(".assistant-text")).toContainText("流式渲染验证完成", { timeout: 20_000 });
});

test("web service: dark mode follows prefers-color-scheme", async ({ app }) => {
	test.setTimeout(120_000);

	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);

	const page = await app.firstWindow();
	// 暗色模拟必须在导航前设置，web-main 在启动时读取 matchMedia
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect
		.poll(() => page.evaluate(() => document.documentElement.dataset.theme))
		.toBe("dark");
});

test("web service: mobile and tablet viewports keep the shell fully visible", async ({ app }) => {
	test.setTimeout(120_000);

	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);

	const page = await app.firstWindow();
	for (const viewportSize of [
		{ width: 390, height: 844 },
		{ width: 768, height: 1024 },
	]) {
		// 手机与窄平板都走 Web 的视口适配；地址栏/键盘变化由 visualViewport
		// 更新 CSS 变量，不能只靠固定的 100vh。
		await page.setViewportSize(viewportSize);
		await page.goto(baseUrl);
		await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
		await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
		const layout = await page.evaluate(() => {
			const rectOf = (selector: string) => {
				const element = document.querySelector<HTMLElement>(selector);
				if (!element) return null;
				const rect = element.getBoundingClientRect();
				return { top: rect.top, bottom: rect.bottom, height: rect.height };
			};
			const visualViewport = window.visualViewport;
			const doc = document.documentElement;
			return {
				scrollWidth: doc.scrollWidth,
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				visualHeight: visualViewport?.height ?? window.innerHeight,
				app: rectOf(".app"),
				header: rectOf(".chat-header"),
				composer: rectOf(".composer"),
			};
		});
		if (!layout.app || !layout.header || !layout.composer) {
			throw new Error("Web layout landmarks are missing");
		}
		expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
		expect(layout.app.top).toBeGreaterThanOrEqual(-1);
		expect(layout.app.bottom).toBeLessThanOrEqual(layout.innerHeight + 1);
		expect(layout.app.height).toBeCloseTo(layout.visualHeight, 0);
		expect(layout.header.top).toBeGreaterThanOrEqual(layout.app.top - 1);
		expect(layout.composer.bottom).toBeLessThanOrEqual(layout.app.bottom + 1);
		expect(layout.composer.bottom).toBeLessThanOrEqual(layout.innerHeight + 1);
	}
});
