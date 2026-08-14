import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Electron 应用 fixture：启动打包产物（out/main/index.js），
 * 用临时数据目录隔离 userData（Windows 走 APPDATA，Linux 走 XDG_CONFIG_HOME，
 * macOS 走 HOME），避免 E2E 污染开发者本机的 PiDeck 数据。
 *
 * 注意：不要传 ELECTRON_RENDERER_URL，那样会指向不存在的 dev server；
 * 打包产物自带 renderer 资源。
 */
export type AppFixture = {
	app: ElectronApplication;
	window: Page;
	userDataRoot: string;
};

/** 测试文件可通过 test.use({ seedProjects }) 预置项目列表（写入 projects.json） */
export type SeedProject = { id: string; name: string; path: string; pinned?: boolean };

const repoRoot = resolve(__dirname, "..");

export const test = base.extend<AppFixture & { seedProjects: SeedProject[] | undefined }>({
	seedProjects: [undefined, { option: true }],
	userDataRoot: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "pideck-e2e-"));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},
	app: async ({ userDataRoot, seedProjects }, use) => {
		// 预置项目列表（ProjectStore.load 保留种子项目并追加内置 Chat 项目）；
		// 写进 profile 目录（应用尊重 --user-data-dir，见 main/index.ts 注释）。
		if (seedProjects && seedProjects.length > 0) {
			mkdirSync(join(userDataRoot, "profile"), { recursive: true });
			writeFileSync(
				join(userDataRoot, "profile", "projects.json"),
				JSON.stringify(
					seedProjects.map((project, index) => ({
						lastOpenedAt: Date.now() + index,
						sortOrder: index,
						...project,
					})),
				),
			);
		}
		const env = {
			...process.env,
			// 隔离 userData；同时清掉 dev 注入，防止指到 dev server
			ELECTRON_RENDERER_URL: "",
			...(process.platform === "win32"
				? { APPDATA: userDataRoot }
				: process.platform === "darwin"
					? { HOME: userDataRoot }
					: { XDG_CONFIG_HOME: userDataRoot, HOME: userDataRoot }),
			// E2E 不探测真实 pi：customPiPath 留空，Agent 用例另走 e2e:real
			CI: "1",
		};
		delete env.ELECTRON_RENDERER_URL;
		const app = await electron.launch({
			// 未打包运行时应用名解析为 "Electron"，userData 默认落到真实
			// %APPDATA%/Electron-dev（跨 E2E 运行共享、污染本机）。必须显式
			// --user-data-dir 指向临时目录（Electron 尊重该 Chromium 开关）。
			args: [join(repoRoot, "out", "main", "index.js"), `--user-data-dir=${join(userDataRoot, "profile")}`],
			env,
		});
		await use(app);
		await app.close();
	},
	window: async ({ app }, use) => {
		const window = await app.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		await use(window);
	},
});

export { expect } from "@playwright/test";
