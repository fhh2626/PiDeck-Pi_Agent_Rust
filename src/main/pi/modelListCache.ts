/**
 * pi --list-models 全局缓存模块。
 *
 * 数据源：pi --list-models（pi 内部处理 auth.json/models.json/内置目录，输出「可用模型」）。
 * 首选数据源是 implementation-neutral RPC；旧版/不完整 Pi 才退回文本表格。
 * TypeScript 文本 fallback 可用 --offline，Rust CLI 没有这个参数，不能共用。
 *
 * 刷新策略：
 * - 启动时异步预加载（应用 ready 后后台 fork 一次）；
 * - 界面保存 models.json/auth.json 后失效并后台重取；
 * - 每次启动 Agent 时强制重取（防用户直接改文件不生效）。
 */

import type { AvailableModel } from "../../shared/types";
import type { PiLocator } from "./PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PiRpcClient } from "./PiRpcClient";
import { normalizePiRpcModels } from "../../shared/piCompatibility";

/** 全局缓存：模型列表（null = 未加载/已失效） */
let cachedListModels: AvailableModel[] | null = null;
/** 在途请求去重：并发调用只 fork 一次 */
let cachedListModelsPending: Promise<AvailableModel[]> | null = null;

/** pi --list-models 加速参数：offline 跳过网络目录刷新，no-ext/skills/themes 跳过发现加载。 */
export const MODEL_LIST_FAST_ARGS = [
	"--list-models",
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/** Rust fallback: keep the CLI flags shared by both implementations only. */
export const MODEL_LIST_RUST_ARGS = [
	"--list-models",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/** RPC is the stable model-list contract shared by the TypeScript and Rust implementations. */
export const MODEL_LIST_RPC_ARGS = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/**
 * 解析 pi --list-models 的文本表格输出。
 * 表格格式：provider  model  context  max-out  thinking  images
 * context/max-out 为人类可读 token 数（如 1M / 65.5K / 272K），解析为数字；
 * thinking/images 为 yes/no。从右往左取后 4 列，避免 provider/model 列含空格时错位。
 */
export function parsePiListModels(stdout: string): AvailableModel[] {
	const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length < 2) return [];
	// Rust may print diagnostics before the table; locate the header instead of
	// blindly assuming the first line is a header.
	const headerIndex = lines.findIndex((line) => /^provider\s+model\b/i.test(line));
	const dataLines = lines.slice(headerIndex >= 0 ? headerIndex + 1 : 1);
	const models: AvailableModel[] = [];
	const seen = new Set<string>();
	for (const line of dataLines) {
		const parts = line.split(/\s+/).filter(Boolean);
		if (parts.length < 3) continue;
		// Rust appends "Showing N of M providers..." after the rows. It is not a
		// model row; requiring a trailing yes/no pair rejects it safely.
		const provider = parts[0];
		const modelId = parts[1];
		if (!provider || !modelId || /^showing$/i.test(provider)) continue;
		if (parts.length >= 6) {
			// 完整 6 列表格：后 4 列固定为 context/max-out/thinking/images
			const tail = parts.slice(-4);
			if (!isYesNo(tail[2]) || !isYesNo(tail[3])) continue;
			const key = `${provider}\u0000${modelId}`.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				contextWindow: parseTokenSize(tail[0] ?? ""),
				maxTokens: parseTokenSize(tail[1] ?? ""),
				reasoning: tail[2]?.toLowerCase() === "yes",
				images: tail[3]?.toLowerCase() === "yes",
			});
		} else {
			// 兼容旧格式（provider/model/thinking），仅解析可确认字段
			const thinking = parts[parts.length - 1];
			if (!isYesNo(thinking)) continue;
			const key = `${provider}\u0000${modelId}`.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				reasoning: thinking?.toLowerCase() === "yes",
			});
		}
	}
	return models;
}

function isYesNo(value: string | undefined): boolean {
	return value?.toLowerCase() === "yes" || value?.toLowerCase() === "no";
}

/** 解析 pi 表格里的 token 数："1M"→1048576，"65.5K"→67109，"200K"→204800；解析失败返回 undefined。 */
export function parseTokenSize(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const match = /^([\d.]+)([KkMm])?$/.exec(trimmed);
	if (!match) return undefined;
	const num = Number(match[1]);
	if (!Number.isFinite(num) || num <= 0) return undefined;
	const unit = match[2]?.toLowerCase();
	if (unit === "k") return Math.round(num * 1024);
	if (unit === "m") return Math.round(num * 1024 * 1024);
	return Math.round(num);
}

/** Query the implementation-neutral RPC model list (一次调用，带超时). */
async function runPiRpcModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
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
	const invocation = piLocator.createInvocation(command, MODEL_LIST_RPC_ARGS);
	const child = spawn(invocation.command, invocation.args, {
		env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
		shell: invocation.shell,
		windowsHide: true,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Startup diagnostics belong on stderr, never in the JSON-RPC stream. Drain
	// the pipe even though the model-list result only needs stdout.
	child.stderr.on("data", () => undefined);
	const client = new PiRpcClient(child.stdin, child.stdout);
	try {
		const response = await client.request({ type: "get_available_models" }, 20_000);
		if (!response.success) throw new Error(response.error ?? "get_available_models failed");
		return normalizePiRpcModels(response.data);
	} finally {
		client.close();
		stopModelListProcess(child);
	}
}

/** CLI text fallback for older/partial Pi builds that do not expose the RPC command. */
async function runPiTextModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
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
	const { execFile } = await import("node:child_process");
	// The neutral set is valid for both implementations. Only an explicit
	// TypeScript selection opts into --offline; auto mode must stay safe when
	// PATH resolves to Rust under the generic `pi` name.
	const argumentSets = settings.piRuntimePreference === "typescript"
		? [MODEL_LIST_FAST_ARGS, MODEL_LIST_RUST_ARGS]
		: [MODEL_LIST_RUST_ARGS];
	let lastError: Error | undefined;
	for (const args of argumentSets) {
		const invocation = piLocator.createInvocation(command, args);
		try {
			const result = await new Promise<{ stdout: string }>((resolve, reject) => {
				execFile(invocation.command, invocation.args, {
					env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 20_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				}, (error, stdout, stderr) => {
					if (error) {
						const message = (stderr || error.message).slice(0, 300);
						reject(new Error(message));
					} else {
						resolve({ stdout });
					}
				});
			});
			const models = parsePiListModels(result.stdout);
			if (models.length > 0 || args === argumentSets[argumentSets.length - 1]) return models;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastError ?? new Error("Unable to list Pi models");
}

/** Prefer RPC; retain the old CLI path as a compatibility fallback. */
async function runPiListModels(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	const rpcModels = await runPiRpcModelList(piLocator, settingsStore).catch(() => []);
	if (rpcModels.length > 0) return rpcModels;
	return runPiTextModelList(piLocator, settingsStore);
}

function stopModelListProcess(child: ChildProcessWithoutNullStreams): void {
	if (!child.killed) child.kill();
}

/**
 * 获取模型列表（读缓存；无缓存时 fork 一次）。
 * 关键：空结果不写缓存——启动早期 pi 可能尚未就绪导致 fork 返回空，
 * 若把空数组缓存下来会永久显示「没有匹配的模型」。
 * 首次 fork 返回空时自动重试一次（间隔 500ms），覆盖 pi 冷启动慢的场景。
 * 返回的数组由调用方消费，不应修改。
 */
export function fetchModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	if (cachedListModels) return Promise.resolve(cachedListModels);
	if (cachedListModelsPending) return cachedListModelsPending;

	cachedListModelsPending = runPiListModels(piLocator, settingsStore)
		.then(async (models) => {
			// 空结果重试一次：启动早期 pi 冷启动/环境未就绪时可能返回空表头。
			if (models.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				models = await runPiListModels(piLocator, settingsStore).catch(() => models);
			}
			// 仅非空结果入缓存；空结果（pi 未就绪/无可用模型）保持 null，下次重试。
			if (models.length > 0) cachedListModels = models;
			return models;
		})
		.finally(() => {
			cachedListModelsPending = null;
		});
	return cachedListModelsPending;
}

/**
 * 强制刷新模型列表（绕过缓存）：配置变更 / 启动 Agent 时调用。
 * 并发去重：同一时刻只 fork 一次，返回最新结果。
 */
export function refreshModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	if (cachedListModelsPending) return cachedListModelsPending;
	cachedListModelsPending = runPiListModels(piLocator, settingsStore)
		.then(async (models) => {
			if (models.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				models = await runPiListModels(piLocator, settingsStore).catch(() => models);
			}
			if (models.length > 0) cachedListModels = models;
			return models;
		})
		.finally(() => {
			cachedListModelsPending = null;
		});
	return cachedListModelsPending;
}

/** 清空模型列表缓存（配置变更后调用；后续 fetch 会重新 fork）。 */
export function invalidateModelListCache(): void {
	cachedListModels = null;
	// 在途请求让其自然完成并覆盖缓存；不主动中断
}

/** 获取当前缓存的模型列表（不触发新的 fork）。 */
export function getCachedModelList(): AvailableModel[] | null {
	return cachedListModels;
}
