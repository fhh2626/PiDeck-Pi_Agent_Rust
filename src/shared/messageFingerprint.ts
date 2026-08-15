import type { ChatMessage } from "./types/session";

/** 去除 provider/终端输出可能携带的 ANSI 控制序列。 */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function imageSignature(message: ChatMessage): string {
	const images = message.images ?? [];
	if (images.length === 0) return "";
	return images
		.map((image) => {
			const data = image.data ?? "";
			const head = data.slice(0, 64);
			const tail = data.length > 128 ? data.slice(-64) : "";
			return `${image.mimeType}:${data.length}:${head}${tail}`;
		})
		.join(",");
}

/**
 * 跨运行期事件副本与 JSONL 投影副本匹配同一条消息的稳定内容指纹。
 * 两条通道的 message.id 不同，因此不能把 id 当作跨层身份。
 */
export function messageFingerprint(message: ChatMessage): string {
	const toolCallId =
		message.role === "tool"
			? message.meta?.toolCallId
			: undefined;
	if (typeof toolCallId === "string" && toolCallId) {
		return `tool\u0000${toolCallId}`;
	}
	return [
		message.role,
		stripAnsi(message.text),
		stripAnsi(message.thinking ?? ""),
		imageSignature(message),
	].join("\u0000");
}
