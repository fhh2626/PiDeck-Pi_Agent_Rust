import type { SessionProcessEvent, SessionProcessEventKind } from "../../shared/types/trajectory";

const MAX_EVENTS = 240;
const DETAIL_LIMIT = 12_000;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function clipDetail(value: string): string {
	if (value.length <= DETAIL_LIMIT) return value;
	return `${value.slice(0, DETAIL_LIMIT)}\n…`;
}

function stringifyUnknown(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value.trim() ? clipDetail(value) : undefined;
	try {
		return clipDetail(JSON.stringify(value, null, 2));
	} catch {
		return undefined;
	}
}

function eventId(entry: Record<string, unknown>, index: number, kind: SessionProcessEventKind): string {
	return asString(entry.id) ?? `process-${kind}-${index}`;
}

function kindFromType(type: string, customType?: string): SessionProcessEventKind | undefined {
	if (type === "session") return "session";
	if (type === "session_info") return "sessionInfo";
	if (type === "model_change") return "modelChange";
	if (type === "thinking_level_change") return "thinkingChange";
	if (type === "compaction") return "compaction";
	if (type === "custom") return "custom";
	if (type.endsWith("_import") || customType?.endsWith(".child-session")) return "import";
	return undefined;
}

/**
 * 从会话 JSONL 抽出过程事件。坏行跳过；message 条目不进账本（对话已由 ChatMessage 覆盖）。
 */
export function parseSessionProcessEvents(raw: string): SessionProcessEvent[] {
	const events: SessionProcessEvent[] = [];
	const lines = raw.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			entry = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = asString(entry.type);
		if (!type || type === "message") continue;
		const customType = asString(entry.customType);
		const kind = kindFromType(type, customType);
		if (!kind) continue;

		const cwd = asString(entry.cwd) ?? asString((entry.header as Record<string, unknown> | undefined)?.cwd);
		const parentSession = asString(entry.parentSession)
			?? asString((entry.header as Record<string, unknown> | undefined)?.parentSession);
		const provider = asString(entry.provider);
		const modelId = asString(entry.modelId);
		const thinkingLevel = asString(entry.thinkingLevel);
		const name = asString(entry.name) ?? asString((entry.data as Record<string, unknown> | undefined)?.name);
		const tokensBefore = asNumber(entry.tokensBefore);
		const summaryText = asString(entry.summary);
		const customContent = asString(entry.content)
			?? stringifyUnknown(entry.data)
			?? stringifyUnknown(entry.customData);

		let summary = type;
		if (kind === "session") summary = cwd ? `cwd ${cwd}` : "session";
		else if (kind === "sessionInfo") summary = name ?? "session_info";
		else if (kind === "modelChange") summary = [provider, modelId].filter(Boolean).join("/") || "model_change";
		else if (kind === "thinkingChange") summary = thinkingLevel ? `thinking ${thinkingLevel}` : "thinking_level_change";
		else if (kind === "compaction") summary = summaryText ?? "compaction";
		else if (kind === "custom") summary = customType ?? "custom";
		else if (kind === "import") summary = customType ?? type;

		events.push({
			id: eventId(entry, index, kind),
			kind,
			timestamp: parseTimestamp(entry.timestamp),
			summary,
			detail: customContent ?? summaryText,
			cwd,
			parentSession,
			provider,
			modelId,
			thinkingLevel,
			customType,
			tokensBefore,
		});
		if (events.length >= MAX_EVENTS) break;
	}
	return events;
}
