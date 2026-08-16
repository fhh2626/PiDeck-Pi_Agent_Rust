import type { ContextControllerState } from "../../shared/types";

export const DEFAULT_CONTEXT_CONTROLLER_STATE: ContextControllerState = {
	clearToolContent: false,
	clearToolHistory: false,
};

/**
 * 从会话 JSONL 文本从后向前扫描最后一条 pi-deck-context-controller 状态快照。
 * 兼容旧版 includeTools / clearAll 字段；无快照时返回默认双 ON。
 */
export function parseContextControllerStateFromJsonl(content: string): ContextControllerState {
	if (!content) return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
	const lines = content.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim();
		if (!line || !line.startsWith("{")) continue;
		try {
			const entry = JSON.parse(line) as {
				type?: string;
				customType?: string;
				data?: Partial<ContextControllerState> & {
					includeTools?: boolean;
					clearAll?: boolean;
				};
			};
			if (entry && entry.type === "custom" && entry.customType === "pi-deck-context-controller") {
				const data = entry.data ?? {};
				const clearToolHistory =
					data.clearToolHistory === true || data.clearAll === true || data.includeTools === false;
				const clearToolContent = clearToolHistory || data.clearToolContent === true;
				return { clearToolContent, clearToolHistory };
			}
		} catch {
			// 忽略单行损坏，继续向前扫描
		}
	}
	return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
}
