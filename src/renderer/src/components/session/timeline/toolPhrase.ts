/**
 * 工具语义化短语生成器（学 Proma tool-phrase.ts）。
 *
 * 将工具名 + 参数合成为一句连贯、可读的中文短语，用于工具卡收起态展示，
 * 替代直接显示完整命令行——折叠态更轻、更易扫读。
 *
 * 纯函数、无运行时依赖（node 单测直接加载）。
 */
import { parseToolArgs } from "../../app/AppUtils";

/** 从路径中提取文件名（兼容 POSIX `/` 与 Windows `\` 分隔符） */
function filename(path: string): string {
	return path.split(/[/\\]/).pop() || path;
}

/** 截断文本 */
function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + "…" : text;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
		if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
			return value[0];
		}
	}
	return undefined;
}

function pickPath(input: Record<string, unknown>): string | undefined {
	return firstString(
		input.file_path,
		input.filePath,
		input.path,
		input.file,
		input.target,
		input.destination,
		input.dest_path,
	);
}

export interface ToolPhrase {
	/** 完成态/收起态短语，如「读取 foo.ts 第 10-60 行」 */
	label: string;
	/** Loading 态短语，如「正在读取 foo.ts...」 */
	loadingLabel: string;
}

/**
 * 根据工具名和输入参数生成语义化短语。
 * 内置工具走中文动宾短语；未知/扩展工具回退为 `工具名 参数摘要`。
 */
export function getToolPhrase(
	toolName: string,
	input: Record<string, unknown> = {},
): ToolPhrase {
	const key = toolName.toLowerCase();
	const path = pickPath(input);
	const file = path ? filename(path) : undefined;

	const phraseFor = (label: string, loading: string): ToolPhrase => ({
		label,
		loadingLabel: loading,
	});

	// 文件读取/编辑/写入类
	if (key === "read") {
		const range = firstString(input.offset, input.start_line) !== undefined
			? `（${firstString(input.offset, input.start_line)} 行起）`
			: "";
		return phraseFor(file ? `读取 ${file}${range}` : "读取文件", file ? `正在读取 ${file}...` : "正在读取文件...");
	}
	if (key === "edit" || key === "multi_edit") {
		return phraseFor(file ? `编辑 ${file}` : "编辑文件", file ? `正在编辑 ${file}...` : "正在编辑文件...");
	}
	if (key === "write" || key === "create") {
		return phraseFor(file ? `写入 ${file}` : "写入文件", file ? `正在写入 ${file}...` : "正在写入文件...");
	}

	// bash / shell 命令
	if (key === "bash" || key === "shell" || key === "run") {
		const command = firstString(input.command, input.cmd);
		return phraseFor(
			command ? `执行 ${truncate(command, 60)}` : "执行命令",
			command ? `正在执行 ${truncate(command, 60)}...` : "正在执行命令...",
		);
	}

	// 搜索类
	if (key === "grep" || key === "search" || key === "web_search" || key === "websearch" || key === "websearch_") {
		const pattern = firstString(input.pattern, input.query, input.q);
		return phraseFor(pattern ? `搜索 ${truncate(String(pattern), 40)}` : "搜索", pattern ? `正在搜索 ${truncate(String(pattern), 40)}...` : "正在搜索...");
	}
	if (key === "glob" || key === "find") {
		const pattern = firstString(input.pattern, input.glob, input.query);
		return phraseFor(pattern ? `查找 ${truncate(String(pattern), 40)}` : "查找文件", pattern ? `正在查找 ${truncate(String(pattern), 40)}...` : "正在查找文件...");
	}

	// 网络获取类
	if (key === "fetch" || key === "fetch_content" || key === "url" || key === "http" || key.includes("fetch")) {
		const url = firstString(input.url, input.urls, input.query);
		return phraseFor(url ? `获取 ${truncate(String(url), 50)}` : "获取网页", url ? `正在获取 ${truncate(String(url), 50)}...` : "正在获取网页...");
	}

	// 待办/清单类
	if (key === "todo" || key === "todolist" || key === "task") {
		const action = firstString(input.action, input.text);
		return phraseFor(action ? `待办 ${truncate(String(action), 40)}` : "更新待办", action ? `正在更新待办...` : "正在更新待办...");
	}

	// 图片/附件
	if (key === "image" || key === "vision" || key.includes("image")) {
		return phraseFor(file ? `查看图片 ${file}` : "查看图片", file ? `正在查看图片 ${file}...` : "正在查看图片...");
	}

	// 通用/扩展/MCP 工具：回退到「工具名 参数摘要」
	const paramSummary = firstString(
		input.command, input.cmd,
		input.pattern, input.query,
		input.url, input.file_path, input.filePath, input.path,
	);
	const displayName = toolName || "工具";
	return phraseFor(
		paramSummary ? `${displayName} ${truncate(String(paramSummary), 60)}` : displayName,
		`正在${displayName}...`,
	);
}

/** 兼容旧签名：接收 ChatMessage，内部解析 args（给 ToolCard 直接用）。 */
export function getToolPhraseFromArgs(
	toolName: string,
	args: unknown,
): ToolPhrase {
	const parsed = parseToolArgs(args);
	return getToolPhrase(toolName, parsed ?? {});
}
