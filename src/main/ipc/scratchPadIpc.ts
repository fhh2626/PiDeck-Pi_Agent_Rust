import { app, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { ipcChannels } from "../../shared/ipc";
import { trashPath } from "../fs/trash";
import type { DraftMeta, ScratchPadData } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcRouter } from "../transport/RpcRouter";

export type ScratchPadIpcDeps = {
	appLogger: Pick<AppLogger, "info" | "error">;
};

export function registerScratchPadIpc(router: RpcRouter, { appLogger }: ScratchPadIpcDeps): void {
	const draftsDir = join(app.getPath("userData"), "drafts");

	/** 确保 drafts 目录存在，首次访问时如果旧 scratch-pad.md 存在则迁移为草稿 */
	async function ensureDraftsDir(): Promise<void> {
		try {
			await mkdir(draftsDir, { recursive: true });
		} catch {
			// 忽略目录已存在错误
		}
		// 迁移旧 scratch-pad.md：如果存在且有内容，移入 drafts 目录
		const oldPath = join(app.getPath("userData"), "scratch-pad.md");
		try {
			const oldStat = await stat(oldPath);
			if (oldStat.size > 0) {
				const ts = new Date(oldStat.mtimeMs);
				const name = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}-${String(ts.getMinutes()).padStart(2, "0")}-${String(ts.getSeconds()).padStart(2, "0")}.md`;
				await copyFile(oldPath, join(draftsDir, name));
			}
			await rm(oldPath);
		} catch {
			// 旧文件不存在则忽略
		}
	}

	/** 生成以当前时间命名的默认文件名：YYYY-MM-DD HH-mm-ss.md */
	function generateDraftName(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}.md`;
	}

	/** 列出所有草稿，按更新时间降序排列 */
	router.handle(ipcChannels.scratchPadList, async (): Promise<DraftMeta[]> => {
		await ensureDraftsDir();
		const files = await readdir(draftsDir);
		const mdFiles = files.filter(f => f.endsWith(".md"));
		const drafts = await Promise.all(
			mdFiles.map(async (f) => {
				const fullPath = join(draftsDir, f);
				try {
					const s = await stat(fullPath);
					return {
						id: f.replace(/\.md$/, ""),
						name: f.replace(/\.md$/, ""),
						path: fullPath,
						createdAt: s.birthtimeMs,
						updatedAt: s.mtimeMs,
					};
				} catch {
					return null;
				}
			}),
		);
		return drafts
			.filter((d): d is NonNullable<typeof d> => d !== null)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});

	/** 创建新草稿，默认文件名为当前时间 */
	router.handle(ipcChannels.scratchPadCreate, async (): Promise<DraftMeta> => {
		await ensureDraftsDir();
		const name = generateDraftName();
		const fullPath = join(draftsDir, name);
		await writeFile(fullPath, "", "utf8");
		const s = await stat(fullPath);
		void appLogger.info("scratchPad", "draft created", { path: fullPath });
		return {
			id: name.replace(/\.md$/, ""),
			name: name.replace(/\.md$/, ""),
			path: fullPath,
			createdAt: s.birthtimeMs,
			updatedAt: s.mtimeMs,
		};
	});

	/** 删除指定草稿 */
	router.handle(ipcChannels.scratchPadDelete, async (draftPath: string): Promise<void> => {
		try {
			// 草稿是用户内容：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
			await trashPath(draftPath, { source: "scratchPad:delete" });
			void appLogger.info("scratchPad", "draft deleted", { path: draftPath });
		} catch (error) {
			void appLogger.error("scratchPad", "Draft delete failed", {
				path: draftPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	/** 加载指定草稿内容，path 为空时返回空内容 */
	router.handle(ipcChannels.scratchPadLoad, async (draftPath?: string): Promise<ScratchPadData> => {
		if (!draftPath) return { content: "", lastEditedAt: 0, cursorPosition: 0 };
		try {
			const content = await readFile(draftPath, "utf8");
			const fileStat = await stat(draftPath);
			return { content, lastEditedAt: fileStat.mtimeMs, cursorPosition: 0 };
		} catch {
			return { content: "", lastEditedAt: 0, cursorPosition: 0 };
		}
	});

	/** 保存内容到指定草稿 */
	router.handle(ipcChannels.scratchPadSave, async (draftPath: string, content: string, cursorPosition: number) => {
		await ensureDraftsDir();
		await writeFile(draftPath, content, "utf8");
		void appLogger.info("scratchPad", "saved", { path: draftPath, bytes: Buffer.byteLength(content, "utf8"), cursorPosition });
	});

	/** 导出指定草稿到用户选择的路径 */
	router.handle(ipcChannels.scratchPadExport, async (draftPath?: string) => {
		if (!draftPath) return false;
		const suggestedName = basename(draftPath);
		const { canceled, filePath } = await dialog.showSaveDialog({
			defaultPath: suggestedName,
			filters: [{ name: "Markdown", extensions: ["md"] }],
		});
		if (canceled || !filePath) return false;
		const content = await readFile(draftPath, "utf8");
		await writeFile(filePath, content, "utf8");
		return true;
	});
}
