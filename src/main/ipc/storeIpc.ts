/**
 * Store IPC handlers: prompts + skills + xue + extensions.
 * Phase 3.5: extracted from src/main/index.ts registerIpc().
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	CreatePiPromptTemplateInput,
	PiPromptTemplateSummary,
	PromptStoreItem,
	PromptStoreRawItem,
	PromptStoreSearchResponse,
	PromptStoreSearchResult,
} from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { PromptManager } from "../prompts/PromptManager";
import type { SkillManager } from "../skills/SkillManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { ExtensionManager } from "../extensions/ExtensionManager";

export type StoreIpcDeps = {
	promptManager: PromptManager;
	skillManager: SkillManager;
	xuePromptManager: XuePromptManager;
	extensionManager: ExtensionManager;
	appLogger: AppLogger;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
};

export function registerStoreIpc({
	promptManager,
	skillManager,
	xuePromptManager,
	extensionManager,
	appLogger,
	mainCopy,
}: StoreIpcDeps): void {
	// ── Prompt Templates ──
	ipcMain.handle(ipcChannels.promptsList, () => promptManager.list());
	ipcMain.handle(ipcChannels.promptsCreate, async (_event, input: CreatePiPromptTemplateInput) => {
		const result = await promptManager.create(input);
		void appLogger.info("prompt", "Prompt template created", { name: input.name });
		return result;
	});
	ipcMain.handle(ipcChannels.promptsDelete, async (_event, filePath: string) => {
		await promptManager.delete(filePath);
		void appLogger.info("prompt", "Prompt template deleted", { filePath });
	});
	ipcMain.handle(ipcChannels.promptsOpenFolder, () => promptManager.openFolder());
	ipcMain.handle(ipcChannels.promptsRestoreBuiltins, async () => {
		await promptManager.restoreHiddenBuiltins();
		void appLogger.info("prompt", "Built-in prompt templates restored");
	});
	ipcMain.handle(ipcChannels.promptsEdit, async (_event, filePath: string, content?: string) => {
		if (content !== undefined) {
			await promptManager.writeContent(filePath, content);
			return;
		}
		return promptManager.readContent(filePath);
	});
	ipcMain.handle(ipcChannels.promptsListByProject, async (_event, projectPath: string) => {
		return promptManager.listByProject(projectPath);
	});
	ipcMain.handle(ipcChannels.promptsCreateInProject, async (_event, projectPath: string, input: CreatePiPromptTemplateInput) => {
		const result = await promptManager.createInProject(projectPath, input);
		void appLogger.info("prompt", "Project prompt template created", {
			projectPath,
			name: input.name,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.promptsDeleteInProject, async (_event, projectPath: string, fileName: string) => {
		await promptManager.deleteFromProject(projectPath, fileName);
		void appLogger.info("prompt", "Project prompt template deleted", { projectPath, fileName });
	});
	ipcMain.handle(ipcChannels.promptsRename, async (_event, oldName: string, newName: string) => {
		const result = await promptManager.rename(oldName, newName);
		void appLogger.info("prompt", "Prompt template renamed", { oldName, newName });
		return result;
	});
	ipcMain.handle(ipcChannels.promptsRenameInProject, async (_event, projectPath: string, oldName: string, newName: string) => {
		const result = await promptManager.renameInProject(projectPath, oldName, newName);
		void appLogger.info("prompt", "Project prompt template renamed", { projectPath, oldName, newName });
		return result;
	});

	// ── Prompt Store (prompts.chat) ──────────────────────────────────────
	const PROMPT_STORE_BASE = "https://prompts.chat/api";

	/** 将 prompts.chat 原始 prompt 条目扁平化为 UI 消费的格式 */
	function flattenPromptItem(raw: PromptStoreRawItem): PromptStoreItem {
		return {
			id: raw.id,
			title: raw.title,
			description: raw.description,
			content: raw.content,
			type: raw.type,
			author: raw.author?.name ?? "",
			category: raw.category?.name ?? "",
			tags: raw.tags?.map((t) => t.tag?.name).filter(Boolean) ?? [],
			votes: raw.voteCount ?? 0,
			createdAt: raw.createdAt,
		};
	}

	/** 将 prompts.chat 的命名变量转换为 pi 的位置参数 */
	function convertStoreVarsToPiVars(content: string): { converted: string; argumentHint: string; varCount: number } {
		const varMap = new Map<string, { index: number; hasDefault: boolean; defaultVal?: string }>();
		let nextIndex = 1;
		const scanRegex = /\$\{([a-zA-Z_]\w*)(?::(.*?))?\}/g;
		let scanMatch: RegExpExecArray | null;
		while ((scanMatch = scanRegex.exec(content)) !== null) {
			const varName = scanMatch[1];
			if (!varMap.has(varName)) {
				varMap.set(varName, {
					index: nextIndex++,
					hasDefault: scanMatch[2] !== undefined,
					defaultVal: scanMatch[2],
				});
			}
		}
		if (varMap.size === 0) {
			return { converted: content, argumentHint: "", varCount: 0 };
		}
		let converted = content.replace(
			/\$\{([a-zA-Z_]\w*)(?::(.*?))?\}/g,
			(_match, varName: string, defaultVal?: string) => {
				const info = varMap.get(varName)!;
				if (defaultVal !== undefined) {
					return `\${${info.index}:-${defaultVal}}`;
				}
				return `$${info.index}`;
			},
		);
		const hints: string[] = [];
		for (let i = 1; i < nextIndex; i++) {
			const entry = Array.from(varMap.entries()).find(([, v]) => v.index === i);
			if (!entry) continue;
			const [varName, info] = entry;
			if (info.hasDefault) {
				hints.push(`[${varName}:${info.defaultVal}]`);
			} else {
				hints.push(`<${varName}>`);
			}
		}
		const argumentHint = hints.length > 0 ? hints.join(" ") : "";
		return { converted, argumentHint, varCount: varMap.size };
	}

	ipcMain.handle(ipcChannels.promptStoreSearch, async (_event, query: string, options?: {
		limit?: number;
		type?: string;
		category?: string;
		tag?: string;
	}) => {
		try {
			const params = new URLSearchParams({ q: query });
			if (options?.limit) params.set("perPage", String(options.limit));
			if (options?.type) params.set("type", options.type);
			if (options?.category) params.set("category", options.category);
			if (options?.tag) params.set("tag", options.tag);

			const url = `${PROMPT_STORE_BASE}/prompts?${params.toString()}`;
			const response = await fetch(url, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				throw new Error(`prompts.chat API 返回 ${response.status}`);
			}
			const raw = (await response.json()) as PromptStoreSearchResponse;
			const result: PromptStoreSearchResult = {
				query,
				count: raw.total,
				prompts: raw.prompts.map(flattenPromptItem),
			};
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("prompt-store", "Search failed", { query, error: message });
			throw new Error(mainCopy("store.promptSearchFailed"));
		}
	});

	ipcMain.handle(ipcChannels.promptStoreGet, async (_event, id: string) => {
		try {
			const url = `${PROMPT_STORE_BASE}/prompts/${encodeURIComponent(id)}`;
			const response = await fetch(url, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				throw new Error(`prompts.chat API 返回 ${response.status}`);
			}
			const raw = (await response.json()) as PromptStoreRawItem;
			return flattenPromptItem(raw);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("prompt-store", "Get prompt failed", { id, error: message });
			throw new Error(mainCopy("store.promptDetailFailed"));
		}
	});

	ipcMain.handle(ipcChannels.promptStoreImport, async (_event, {
		title,
		description,
		content,
	}: {
		title: string;
		description: string;
		content: string;
	}) => {
		try {
			const name = title
				.trim()
				.toLowerCase()
				.replace(/[^\p{L}\p{N}-]+/gu, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "");
			if (!name) throw new Error(mainCopy("store.invalidItemTitle"));

			const { converted, argumentHint, varCount } = convertStoreVarsToPiVars(content);

			const tryCreate = async (tryName: string): Promise<PiPromptTemplateSummary> => {
				try {
					return await promptManager.create({ name: tryName, description });
				} catch {
					const match = tryName.match(/-(\d+)$/);
					const nextNum = match ? parseInt(match[1], 10) + 1 : 2;
					const suffixName = tryName.replace(/-\d+$/, "") + "-" + nextNum;
					return tryCreate(suffixName);
				}
			};

			const hintLine = argumentHint ? `\nargument-hint: ${argumentHint}` : "";
			const frontmatter = `---\ndescription: ${description.replace(/\n/g, " ")}\nsource: prompts.chat${hintLine}\n---\n\n`;
			const summary = await tryCreate(name);
			await promptManager.writeContent(summary.path, frontmatter + converted);

			void appLogger.info("prompt-store", "Imported prompt from store", {
				title,
				localName: summary.name,
				variables: varCount,
			});
			return summary;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("prompt-store", "Import failed", { title, error: message });
			throw new Error(mainCopy("store.promptImportFailed"));
		}
	});

	// ── Skill Store ─────────────────────────────
	ipcMain.handle(ipcChannels.skillStoreSearch, async (_event, query: string) => {
		try {
			const params = new URLSearchParams({ q: query, perPage: "20" });
			const url = `https://prompts.chat/api/prompts?${params.toString()}`;
			const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			if (!response.ok) throw new Error(`prompts.chat API 返回 ${response.status}`);
			const raw = (await response.json()) as PromptStoreSearchResponse;
			const result = {
				query,
				count: raw.total,
				prompts: raw.prompts.map(flattenPromptItem),
			};
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("skill-store", "Search failed", { query, error: message });
			throw new Error(mainCopy("store.skillSearchFailed"));
		}
	});

	ipcMain.handle(ipcChannels.skillStoreImport, async (_event, item: PromptStoreItem, locationId: "pi-global" | "agents-global" = "pi-global") => {
		try {
			const name = item.title
				.trim()
				.toLowerCase()
				.replace(/[^\p{L}\p{N}-]+/gu, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "");
			if (!name) throw new Error(mainCopy("store.invalidItemTitle"));

			const { writeFile } = await import("node:fs/promises");

			const summary = await skillManager.create({
				name,
				description: item.description || item.title,
				locationId: locationId ?? "pi-global",
			});

			const skillContent = `---\nname: ${name}\ndescription: ${(item.description || item.title).replace(/\n/g, " ")}\nsource: prompts.chat\n---\n\n# ${item.title}\n\n${item.content}`;
			await writeFile(summary.path, skillContent, "utf8");

			void appLogger.info("skill-store", "Imported skill from store", { title: item.title, localName: name });
			return summary;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("skill-store", "Import failed", { title: item.title, error: message });
			throw new Error(mainCopy("store.skillImportFailed"));
		}
	});

	// ── Skills.sh ─────────────────────────
	ipcMain.handle(ipcChannels.skillHubSearch, async (_event, opts: { query: string; limit?: number }) => {
		const { query, limit = 50 } = opts;
		try {
			const response = await fetch(
				`https://www.skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
				{ signal: AbortSignal.timeout(15_000) },
			);
			if (!response.ok) throw new Error(`API returned ${response.status}`);
			const json = (await response.json()) as {
				skills?: Array<{ id: string; skillId: string; name: string; installs: number; source: string }>;
			};
			const skills = json.skills ?? [];
			const items = skills.map((item) => ({
				slug: item.id,
				name: item.name,
				description: "",
				description_zh: "",
				iconUrl: undefined,
				stars: 0,
				downloads: item.installs,
				installs: item.installs,
				category: "",
				version: "",
				ownerName: item.source,
				source: "skills.sh",
			}));
			items.sort((a, b) => b.installs - a.installs);
			return { query, total: items.length, items };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("skill-hub", "Search failed", { query, error: message });
			throw new Error(mainCopy("store.skillsShSearchFailed"));
		}
	});

	ipcMain.handle(ipcChannels.skillHubDetail, async () => null);

	ipcMain.handle(ipcChannels.skillHubInstall, async (_event, slug: string) => {
		const lastSlash = slug.lastIndexOf("/");
		const pkg = lastSlash > 0 ? slug.slice(0, lastSlash) : slug;
		const skillName = lastSlash > 0 ? slug.slice(lastSlash + 1) : "";
		// P0 security: whitelist shell-safe characters only
		const SAFE_SLUG_RE = /^[a-zA-Z0-9@/\-_.]+$/;
		if (!SAFE_SLUG_RE.test(pkg) || (skillName && !SAFE_SLUG_RE.test(skillName))) {
			return { success: false, slug, installDir: "", error: mainCopy("store.skillsShInvalidSlug") };
		}
		try {
			const { exec } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execAsync = promisify(exec);
			const cmd = `npx skills add "${pkg}" -g -s "${skillName}" -y`;
			await execAsync(cmd, { encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
			void appLogger.info("skill-hub", "Installed skill", { slug, pkg, skillName });
			return { success: true, slug, installDir: "" };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("skill-hub", "Install failed", { slug, error: message });
			// 返回真实错误信息（截断防爆，exec 的 stderr 可能很长），渲染层 toast 直接展示；
			// 此前只返回通用文案，用户无法判断是网络、权限还是包名问题
			const brief = message.length > 300 ? `${message.slice(0, 300)}…` : message;
			return { success: false, slug, installDir: "", error: brief };
		}
	});

	// ── Xue Prompts ─────────────────────────────
	ipcMain.handle(ipcChannels.yaoPromptsList, async (_event, opts?: {
		category?: string;
		search?: string;
		page?: number;
		pageSize?: number;
	}) => {
		try {
			const result = await xuePromptManager.list(opts);
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("yao-prompts", "List failed", { error: message });
			throw new Error(mainCopy("store.yaoListFailed"));
		}
	});

	ipcMain.handle(ipcChannels.yaoPromptsDetail, async (_event, slug: string, category: string) => {
		try {
			const result = await xuePromptManager.detail(slug, category);
			if (!result) throw new Error(`未找到提示词: ${slug}`);
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("yao-prompts", "Detail failed", { slug, category, error: message });
			throw new Error(mainCopy("store.yaoDetailFailed"));
		}
	});

	ipcMain.handle(ipcChannels.yaoPromptsImport, async (_event, slug: string, category: string) => {
		try {
			const result = await xuePromptManager.importToPi(slug, category);
			void appLogger.info("yao-prompts", "Imported to pi templates", { slug, localName: result.name });
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void appLogger.warn("yao-prompts", "Import failed", { slug, category, error: message });
			throw new Error(mainCopy("store.yaoImportFailed"));
		}
	});

	// ── Extensions ──────────────────────────────
	ipcMain.handle(ipcChannels.extensionsList, (_event, forceRefresh?: boolean) =>
		extensionManager.list(Boolean(forceRefresh)));
	ipcMain.handle(ipcChannels.extensionsRemoveBuiltIn, async (_event, source: string) => {
		try {
			await extensionManager.removeBuiltIn(source);
			void appLogger.info("extension", "Built-in extension removed", { source });
		} catch (error) {
			void appLogger.error("extension", "Built-in extension remove failed", {
				source,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.extensionsRestoreBuiltIn, async (_event, source: string) => {
		await extensionManager.restoreBuiltIn(source);
		void appLogger.info("extension", "Built-in extension restored", { source });
	});
	ipcMain.handle(ipcChannels.extensionsUninstall, async (_event, source: string, scope?: "user" | "project" | "unknown") => {
		try {
			const result = await extensionManager.uninstall(source, scope);
			void appLogger.info("extension", "Extension uninstalled", { source, scope });
			return result;
		} catch (error) {
			void appLogger.error("extension", "Extension uninstall failed", {
				source,
				scope,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.extensionsInstall, async (_event, source: string) => {
		const result = await extensionManager.install(source);
		void appLogger.info("extension", "Extension installed", { source });
		return result;
	});
	ipcMain.handle(ipcChannels.extensionsToggle, async (_event, source: string, enabled: boolean) => {
		// 内置扩展走 removedBuiltInExtensions + RPC -e，不再写用户扩展目录 / pi disabledExtensions。
		if (source.startsWith("pi-deck-") && source.endsWith(".ts")) {
			if (enabled) await extensionManager.restoreBuiltIn(source);
			else await extensionManager.disableBuiltIn(source);
		} else {
			await extensionManager.setEnabled(source, enabled);
		}
		void appLogger.info("extension", "Extension toggled", { source, enabled });
	});
	ipcMain.handle(ipcChannels.extensionsUpdate, async () => {
		const result = await extensionManager.updateExtensions();
		void appLogger.info("extension", "Extensions update command completed", { updated: result.updated, bytes: result.output.length });
		return result;
	});
	ipcMain.handle(ipcChannels.extensionsUpdateOne, async (_event, source: string) => {
		const result = await extensionManager.updateExtension(source);
		void appLogger.info("extension", "Extension update-one command completed", { source, updated: result.updated, bytes: result.output.length });
		return result;
	});
}
