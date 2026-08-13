/** 宿主注入给模型的内部指令边界；展示消息时必须剥离。 */
export const HOST_INSTRUCTION_START = "[PIDECK_HOST_INSTRUCTION]";
export const HOST_INSTRUCTION_END = "[/PIDECK_HOST_INSTRUCTION]";

/** 把宿主内部指令与用户原文打包成发给模型的消息。 */
export function wrapHostInstruction(instruction: string, userMessage: string): string {
	const normalizedInstruction = instruction.trim();
	if (!normalizedInstruction) return userMessage;
	return `${HOST_INSTRUCTION_START}\n${normalizedInstruction}\n${HOST_INSTRUCTION_END}\n\n${userMessage}`;
}

/**
 * 剥离宿主内部指令，只保留用户可见输入。
 * 同时兼容旧版本已写入会话文件的外部连接提示，避免升级后历史消息泄露内部说明。
 */
export function stripHostInstruction(text: string): string {
	if (!text) return "";
	let next = text.replace(/\r\n/g, "\n").replace(
		/\[PIDECK_HOST_INSTRUCTION\][\s\S]*?\[\/PIDECK_HOST_INSTRUCTION\]\s*/g,
		"",
	);
	if (next.startsWith("当前会话已连接飞书聊天")) {
		const parts = next.split(/\n\n+/);
		if (parts.length >= 2 && parts[0].includes("SEND_FILE")) {
			next = parts.slice(1).join("\n\n");
		}
	}
	next = next
		.replace(/\n{0,2}\[这是飞书群聊消息。请直接回复用户。\]\s*$/g, "")
		.replace(/\n{0,2}\[飞书群聊消息。请直接回复用户。\]\s*$/g, "")
		.replace(/\n{0,2}\[PiDeck 飞书能力\][\s\S]*$/g, "");
	return next.replace(/\n{3,}/g, "\n\n").trim();
}
