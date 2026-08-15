/**
 * 折叠态思考单行摘要的取行策略（纯函数，与 deepseek-harness ReasoningRow 同模式）。
 *
 * - 流式中（running）：取最新一行（lastIndexOf('\n') 之后），配合容器 scrollLeft
 *   跟随尾部，语义类似终端 tail -f——看到的始终是最新的思考内容
 * - 结束后：取第一行（indexOf('\n') 之前），摘要从头部读起，配合 ellipsis
 */
export function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

export function latestLine(text: string): string {
	const visible = text.trimEnd();
	const newline = visible.lastIndexOf("\n");
	return newline === -1 ? visible : visible.slice(newline + 1);
}
