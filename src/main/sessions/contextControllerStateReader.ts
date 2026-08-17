import type { ContextControllerState } from "../../shared/types";

export const DEFAULT_CONTEXT_CONTROLLER_STATE: ContextControllerState = {
	clearToolHistory: false,
	clearReadContent: false,
	clearCommandContent: false,
	keepRecentCount: 10,
};

function clampKeepRecentCount(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 10;
	return Math.max(0, Math.min(99, Math.floor(raw)));
}

/**
 * 从会话 JSONL 文本从后向前扫描最后一条 pi-deck-context-controller 状态快照。
 * 无快照或字段缺失时按默认值全开 + 保留最近 10 条。
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
				data?: Partial<ContextControllerState>;
			};
			if (entry && entry.type === "custom" && entry.customType === "pi-deck-context-controller") {
				const data = entry.data ?? {};
				return {
					clearToolHistory: data.clearToolHistory === true,
					clearReadContent: data.clearReadContent === true,
					clearCommandContent: data.clearCommandContent === true,
					keepRecentCount: clampKeepRecentCount(data.keepRecentCount),
				};
			}
		} catch {
			// 忽略单行损坏，继续向前扫描
		}
	}
	return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
}
