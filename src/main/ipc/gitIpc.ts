import { ipcMain } from "electron";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
	getDefaultGitCommitMessagePrompt,
	resolveGitCommitMessagePromptLocale,
} from "../../shared/gitCommitMessagePrompt";
import { ipcChannels } from "../../shared/ipc";
import type { GitGenerateCommitMessageResult, GitWorkspaceDiffGroup } from "../../shared/types";
import type { GitService } from "../git/GitService";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import { PiRpcClient } from "../pi/PiRpcClient";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WorktreeService } from "../git/WorktreeService";

export type GitIpcDeps = {
	appLogger: Pick<AppLogger, "warn" | "info" | "error">;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getLocale: () => string;
	gitService: GitService;
	piLocator: PiLocator;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	worktreeService: WorktreeService;
};

// ── QuickGen：持久化轻量 pi 进程，通过 RPC 生成提交摘要 ──────────────

/** 轻量 pi 进程，用 RPC 模式运行，只做文本生成，不加载 session/tools/extensions */
let genProcess: ChildProcess | null = null;
let genRpcClient: PiRpcClient | null = null;
let genProcessCwd = "";
let genModelKey = "";
let genIdleTimer: NodeJS.Timeout | null = null;
/** 生成互斥锁：同一时刻只允许一个摘要请求，避免并发打到复用进程触发 pi 的 busy 拒绝 */
let genBusy = false;

/** 清理快速生成进程 */
function stopGenProcess() {
	if (genIdleTimer) {
		clearTimeout(genIdleTimer);
		genIdleTimer = null;
	}
	genRpcClient?.close();
	genRpcClient = null;
	if (genProcess && genProcess.exitCode === null) {
		try { genProcess.kill(); } catch { /* ignore */ }
	}
	genProcess = null;
	genProcessCwd = "";
	genModelKey = "";
}

/** 重置空闲定时器：30 分钟无请求自动杀掉进程释放内存 */
function resetGenIdleTimer() {
	if (genIdleTimer) clearTimeout(genIdleTimer);
	genIdleTimer = setTimeout(() => {
		stopGenProcess();
	}, 30 * 60_000);
}

/** 确保有一个轻量 pi RPC 进程在运行，跨项目复用 */
async function ensureGenProcess(
	projectPath: string,
	command: string,
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	model: { provider: string; modelId: string },
	appLogger: Pick<AppLogger, "warn">,
): Promise<PiRpcClient> {
	// provider/model 变化时必须重启轻量进程，避免旧进程继续持有上一组选中的模型。
	const modelKey = `${model.provider}\0${model.modelId}`;
	if (genProcess && genRpcClient && genProcess.exitCode === null) {
		if (genModelKey === modelKey) {
			genProcessCwd = projectPath;
			resetGenIdleTimer();
			return genRpcClient;
		}
		stopGenProcess();
	}

	// 清理已死的旧进程
	if (genProcess) stopGenProcess();

	const settings = settingsStore.get();
	const invocation = piLocator.createInvocation(command, [
		"--mode", "rpc",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--thinking", "off",
	]);

	const childProcess = spawn(invocation.command, invocation.args, {
		cwd: projectPath,
		env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
		stdio: ["pipe", "pipe", "pipe"],
		shell: invocation.shell,
		windowsHide: true,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
	});
	genProcess = childProcess;
	genProcessCwd = projectPath;

	genRpcClient = new PiRpcClient(childProcess.stdin!, childProcess.stdout!);

	try {
		const modelResponse = await genRpcClient.request({
			type: "set_model",
			provider: model.provider,
			modelId: model.modelId,
		});
		if (!modelResponse.success) {
			throw new Error(modelResponse.error ?? `Unable to select model ${model.provider}/${model.modelId}`);
		}
		genModelKey = modelKey;
	} catch (error) {
		stopGenProcess();
		throw error;
	}

	// stderr 仅用于调试日志
	genProcess.stderr!.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8").slice(0, 300);
		void appLogger.warn("git", "QuickGen stderr", { text });
	});

	genProcess.on("exit", () => {
		// 旧进程可能在模型切换后才发出 exit；只允许当前实例清理全局状态。
		if (genProcess === childProcess) stopGenProcess();
	});

	resetGenIdleTimer();
	return genRpcClient;
}

/** 通过持久化 RPC 进程快速生成文本，避免每次 fork 新进程 */
async function quickGenerate(
	projectPath: string,
	prompt: string,
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	model: { provider: string; modelId: string },
	appLogger: Pick<AppLogger, "warn">,
): Promise<string> {
	// 复用进程同时只能跑一个生成；并发（连点/跨项目）直接拒绝，由 handler 转友好提示
	if (genBusy) {
		throw new Error("Agent is already processing");
	}
	genBusy = true;

	const settings = settingsStore.get();
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
		settings.piRuntimePreference,
		settings.piTypescriptPath,
		settings.piRustPath,
	);

	try {
		const rpc = await ensureGenProcess(projectPath, command, piLocator, settingsStore, model, appLogger);

		return await new Promise<string>((resolve, reject) => {
			const collected: string[] = [];
			let settled = false;
			const timeout = setTimeout(() => {
				if (!settled) {
					void appLogger.warn("git", "QuickGen timed out", {});
					// 超时后 pi 进程内的 agent 可能仍在处理旧请求（残留 busy 状态），
					// 直接杀掉复用进程，下次请求重建干净的进程，避免后续请求被 busy 拒绝。
					stopGenProcess();
					reject(new Error("Quick generate timed out"));
				}
			}, 60_000);

			const onEvent = (event: Record<string, unknown>) => {
				const eventType = event.type as string;
				if (eventType === "message_update") {
					const ae = (event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
					if (ae?.type === "text_delta" && typeof ae.delta === "string") {
						collected.push(ae.delta);
					}
				}
				if (eventType === "agent_settled" || eventType === "agent_end") {
					settled = true;
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					resolve(collected.join(""));
				}
			};

			rpc.on("event", onEvent);

			rpc.request({ type: "prompt", message: prompt }).then((response) => {
				if (!response.success) {
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					reject(new Error(response.error ?? "Prompt rejected"));
				}
			}).catch((err) => {
				clearTimeout(timeout);
				rpc.off("event", onEvent);
				reject(err);
			});
		});
	} finally {
		genBusy = false;
	}
}

// ── IPC 注册 ────────────────────────────────────────────────────────

export function registerGitIpc({
	appLogger,
	mainCopy,
	getLocale,
	gitService,
	piLocator,
	projectStore,
	settingsStore,
	worktreeService,
}: GitIpcDeps): void {
	ipcMain.handle(ipcChannels.gitBranches, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return gitService.getBranches(project.path);
	});

	ipcMain.handle(
		ipcChannels.gitCheckout,
		async (_event, projectId: string, branch: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await gitService.checkout(project.path, branch);
			// 切换分支可能覆盖未提交的工作区改动：记 warn 审计日志，排查"文件消失"时能定位到切换动作。
			void appLogger.warn("git", "Branch checked out", { projectId, branch, changed: result });
			return result;
		},
	);

	ipcMain.handle(
		ipcChannels.gitCreateBranch,
		async (_event, projectId: string, branchName: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return gitService.createBranch(project.path, branchName);
		},
	);

	// 差异查看需要文件的 Git HEAD 原始内容作为对比基准；参数是绝对文件路径，后端自行定位仓库根。
	ipcMain.handle(
		ipcChannels.gitOriginalContent,
		async (_event, filePath: string) => {
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getOriginalContent(filePath, maxBytes);
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorktreeList,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const entries = await worktreeService.list(project.path);
			// 每次扫描都同步注册外部新增 worktree，保证侧栏数据和 git 状态一致。
			for (const wt of entries) {
				await projectStore.add(wt.path, projectId);
			}
			return entries;
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorktreeCreate,
		async (_event, projectId: string, branchName: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const info = await worktreeService.create(project.path, projectId, branchName);
			await projectStore.add(info.path, projectId);
			return info;
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorktreeRemove,
		async (_event, projectId: string, worktreePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			try {
				const ok = await worktreeService.remove(worktreePath, project.path);
				const normalizeForCompare = (value: string) => {
					const resolved = resolve(value);
					return process.platform === "win32" ? resolved.toLowerCase() : resolved;
				};
				const normalizedTarget = normalizeForCompare(worktreePath);
				const stillInGit = (await worktreeService.list(project.path)).some(
					(entry) => normalizeForCompare(entry.path) === normalizedTarget,
				);
				// 如果 git 已经没有该 worktree（包括用户在外部删过导致 remove 返回 false），
				// 也要清理 PiDeck 项目记录，否则重启后会从 projects.json 恢复成"删不掉"。
				if (ok || !stillInGit) {
					const child = projectStore.findByPath(worktreePath);
					if (child) await projectStore.remove(child.id);
					// worktree 删除 = 物理目录删除（走回收站），记审计日志便于追踪。
					void appLogger.info("git", "Worktree removed", {
						projectId,
						worktreePath,
						projectRecordRemoved: Boolean(child),
					});
					return true;
				}
				void appLogger.info("git", "Worktree removal skipped", {
					projectId,
					worktreePath,
					reason: "worktree still tracked by git",
				});
				return false;
			} catch (error) {
				void appLogger.error("git", "Worktree remove failed", {
					projectId,
					worktreePath,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);

	// -- Git 增强：提交历史 / 分支对比 / Graph
	ipcMain.handle(
		ipcChannels.gitCommitLog,
		async (_event, projectId: string, options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean }) => {
			const project = projectStore.get(projectId);
			if (!project) return [];
			return gitService.getCommitLog(project.path, options);
		},
	);

	ipcMain.handle(
		ipcChannels.gitRefs,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) return [];
			return gitService.getRefs(project.path);
		},
	);

	ipcMain.handle(
		ipcChannels.gitBranchCompare,
		async (_event, projectId: string, base: string, target: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return gitService.compareBranches(project.path, base, target);
		},
	);

	ipcMain.handle(
		ipcChannels.gitCommitDetail,
		async (_event, projectId: string, ref: string) => {
			const project = projectStore.get(projectId);
			if (!project) return null;
			return gitService.getCommitDetail(project.path, ref);
		},
	);

	ipcMain.handle(
		ipcChannels.gitCommitFileDiff,
		async (_event, projectId: string, ref: string, filePath: string, originalPath?: string) => {
			const project = projectStore.get(projectId);
			if (!project) return null;
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getCommitFileDiff(project.path, ref, filePath, originalPath, maxBytes);
		},
	);

	ipcMain.handle(
		ipcChannels.gitDiffFileBetween,
		async (_event, projectId: string, ref1: string, ref2: string, filePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) return "";
			return gitService.diffFileBetweenRefs(project.path, ref1, ref2, filePath);
		},
	);


	// Git 工作区状态 + Stage/Unstage
	ipcMain.handle(
		ipcChannels.gitStatus,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) return { merge: [], index: [], workingTree: [], untracked: [] };
			return gitService.getStatus(project.path);
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorkspaceFileDiff,
		async (_event, projectId: string, group: GitWorkspaceDiffGroup, filePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) return null;
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getWorkspaceFileDiff(project.path, group, filePath, maxBytes);
		},
	);

	ipcMain.handle(
		ipcChannels.gitStage,
		async (_event, projectId: string, paths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.stageFiles(project.path, paths);
		},
	);

	ipcMain.handle(
		ipcChannels.gitUnstage,
		async (_event, projectId: string, paths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.unstageFiles(project.path, paths);
		},
	);

	ipcMain.handle(
		ipcChannels.gitDiscard,
		async (_event, projectId: string, group: "workingTree" | "untracked", filePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			try {
				await gitService.discardFile(project.path, group, filePath);
				// untracked 丢弃 = 删除用户文件（走回收站），记审计日志便于追踪。
				void appLogger.info("git", "Changes discarded", { projectId, group, filePath });
			} catch (error) {
				void appLogger.error("git", "Discard changes failed", {
					projectId,
					group,
					filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);

	ipcMain.handle(
		ipcChannels.gitCommit,
		async (_event, projectId: string, message: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.commit(project.path, message);
			void appLogger.info("git", "Commit created", { projectId, message });
		},
	);

	ipcMain.handle(
		ipcChannels.gitCherryPick,
		async (_event, projectId: string, hash: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.cherryPick(project.path, hash);
			void appLogger.info("git", "Commit cherry-picked", { projectId, hash });
		},
	);

	ipcMain.handle(
		ipcChannels.gitRevert,
		async (_event, projectId: string, hash: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.revertCommit(project.path, hash);
			void appLogger.info("git", "Commit reverted", { projectId, hash });
		},
	);

	ipcMain.handle(
		ipcChannels.gitPush,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.push(project.path);
			void appLogger.info("git", "Pushed", { projectId });
		},
	);

	ipcMain.handle(
		ipcChannels.gitPull,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.pull(project.path);
			void appLogger.info("git", "Pulled", { projectId });
		},
	);

	ipcMain.handle(
		ipcChannels.gitReset,
		async (_event, projectId: string, hash: string, mode: "soft" | "mixed" | "hard") => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.resetToCommit(project.path, hash, mode);
			// hard reset 会丢工作区/暂存区改动（reflog 外的不可恢复路径），warn 级突出显示。
			void appLogger.warn("git", "Reset to commit", { projectId, hash, mode });
		},
	);

	ipcMain.handle(
		ipcChannels.gitDropCommit,
		async (_event, projectId: string, hash: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.dropCommit(project.path, hash);
			void appLogger.warn("git", "Commit dropped", { projectId, hash });
		},
	);

	ipcMain.handle(
		ipcChannels.gitGenerateCommitMessage,
		async (_event, projectId: string): Promise<GitGenerateCommitMessageResult> => {
			const project = projectStore.get(projectId);
			if (!project) return { ok: true, message: "" };

			const diff = await gitService.getStagedDiff(project.path);
			if (!diff.trim()) return { ok: true, message: "" };

			const settings = settingsStore.get();
			const provider = settings.gitCommitMessageProvider.trim();
			const modelId = settings.gitCommitMessageModel.trim();
			if (!provider || !modelId) {
				// 结构化错误码：渲染层识别后提供“去设置”引导，而不是只显示一行文案
				return {
					ok: false,
					code: "GIT_COMMIT_MODEL_REQUIRED",
					message: mainCopy("git.commitMessageModelRequired"),
				};
			}

			// 从设置中读取提示词模板，替换 {diff} 为实际 diff 内容
			const promptTemplate = settings.gitCommitMessagePrompt || getDefaultGitCommitMessagePrompt(
				resolveGitCommitMessagePromptLocale(getLocale()),
			);
			const prompt = promptTemplate.replace("{diff}", diff.slice(0, 8000));

			try {
				const result = await quickGenerate(
					project.path,
					prompt,
					piLocator,
					settingsStore,
					{ provider, modelId },
					appLogger,
				);
				void appLogger.warn("git", "Generate commit message result", { length: result.length });
				return { ok: true, message: result.trim() };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void appLogger.warn("git", "Generate commit message failed", { error: msg });
				// pi 的 busy 拒绝是技术性英文，统一转成本地化提示；其余错误保留原文便于排查
				if (/Agent is already processing/i.test(msg)) {
					return { ok: false, code: "GIT_COMMIT_BUSY", message: mainCopy("git.commitMessageBusy") };
				}
				if (/timed out/i.test(msg)) {
					return { ok: false, code: "GIT_COMMIT_TIMEOUT", message: mainCopy("git.commitMessageTimeout") };
				}
				return { ok: false, code: "GIT_COMMIT_GENERATE_FAILED", message: msg };
			}
		},
	);

	ipcMain.handle(
		ipcChannels.gitInit,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const { execFile } = await import("node:child_process");
			await execFile("git", ["init"], { cwd: project.path });
			void appLogger.info("git", "Repository initialized", { projectId, path: project.path });
		},
	);

	// Fetch：刷新远程跟踪引用（定时轮询 ahead/behind 的前置步骤）
	ipcMain.handle(
		ipcChannels.gitFetch,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.fetch(project.path);
		},
	);

	// ahead/behind：驱动 push/pull 角标；无上游返回 null（不显示角标）
	ipcMain.handle(
		ipcChannels.gitAheadBehind,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return gitService.getAheadBehind(project.path);
		},
	);

	// 删除变更文件（移入回收站）：路径由 GitService 按 status 白名单校验
	ipcMain.handle(
		ipcChannels.gitDeleteFiles,
		async (_event, projectId: string, paths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			// 入参不可信：必须是非空字符串数组，防注入
			if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || !p)) {
				throw new Error("Invalid paths");
			}
			await gitService.deleteFiles(project.path, paths);
			// 批量删除文件：最高风险操作之一，完整记录路径清单（含数量）便于误删回溯。
			void appLogger.warn("git", "Files deleted (recycle bin)", { projectId, count: paths.length, paths });
		},
	);

}
