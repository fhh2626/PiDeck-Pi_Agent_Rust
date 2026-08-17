/**
 * 将会话消息折叠成轨迹账本（turn + 3-lane 时间线）。
 *
 * 业务规则：
 * - 用户消息开启新 turn；其后的 assistant / thinking / tool 归入该 turn。
 * - system / error 不拆 turn，挂到当前 turn；若还没有 turn 则单独成 turn。
 * - 工具起止优先用 meta.startedAt + meta.durationMs（与 AgentManager 写入约定一致），
 *   不用 message.timestamp（update/end 会刷新，历史恢复后耗时不可还原）。
 * - in-flight（running / pending）不伪造 duration：endedAt 留空，时间列显示为进行中。
 * - 历史 assistant/thinking 往往只有一个 timestamp（结束时刻）。轮内用相邻锚点
 *   回推区间，避免账本只剩工具有耗时；用户/过程事件仍是时间点，不编造。
 * - JSONL 过程事件（session/model/thinking/custom/compaction）按时间插入最近 turn，
 *   不另开 IPC 通道以外的第二条对话投影。
 * - 系统提示词 Pi 不落盘：可选的 extras.systemPrompt 仅作参考记录，不是当轮请求快照。
 */

import type { ChatMessage } from "../../../../../shared/types";
import type { SessionProcessEvent } from "../../../../../shared/types/trajectory";

export type TrajectoryLane = "input" | "model" | "tools" | "process";

export type TrajectoryRecordKind =
	| "user"
	| "assistant"
	| "thinking"
	| "tool"
	| "system"
	| "error"
	| "process"
	| "systemPrompt";

export type TrajectoryRecord = {
	id: string;
	kind: TrajectoryRecordKind;
	lane: TrajectoryLane;
	turnIndex: number;
	title: string;
	summary: string;
	startedAt: number;
	/** 缺省 = in-flight，时间线可投影到 now，账本不得编造耗时。 */
	endedAt?: number;
	durationMs?: number;
	status?: string;
	toolName?: string;
	toolCallId?: string;
	text?: string;
	detail?: string;
	/** 首条用户消息 = 本会话初始提示词（DSH 的 user 开轮语义）。 */
	isInitialPrompt?: boolean;
	processKind?: SessionProcessEvent["kind"];
	cwd?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
};

export type TrajectoryTurn = {
	index: number;
	id: string;
	startedAt: number;
	endedAt?: number;
	inFlight: boolean;
	/** 本轮首条到末条的墙钟跨度；in-flight 时缺省，UI 用 now 显示已过时间。 */
	durationMs?: number;
	records: TrajectoryRecord[];
};

export type TrajectoryModel = {
	turns: TrajectoryTurn[];
	records: TrajectoryRecord[];
	domainStart: number;
	domainEnd: number;
};

export type TrajectoryBuildExtras = {
	processEvents?: SessionProcessEvent[];
	/** 内置/参考系统提示，不是 Pi 当轮真实请求体。 */
	systemPrompt?: string;
};

const SUMMARY_LIMIT = 96;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarize(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= SUMMARY_LIMIT) return flat;
	return `${flat.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function toolNameOf(message: ChatMessage): string {
	const fromMeta = asString(message.meta?.toolName);
	if (fromMeta) return fromMeta;
	const text = message.text.replace(/^[\u25b6\u2713\u2717]\s*/u, "").trim();
	return text.split(/\s+/)[0] || "tool";
}

function laneOf(kind: TrajectoryRecordKind): TrajectoryLane {
	if (kind === "user") return "input";
	if (kind === "tool") return "tools";
	if (kind === "process" || kind === "systemPrompt") return "process";
	return "model";
}

function isThinkingOnly(message: ChatMessage): boolean {
	return (
		message.role === "assistant" &&
		Boolean(message.thinking?.trim()) &&
		!message.text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim()
	);
}

function isInFlightTool(message: ChatMessage): boolean {
	return asString(message.meta?.status) === "running";
}

function isInFlightAssistant(message: ChatMessage): boolean {
	return message.stopReason === "pending";
}

function pushRecord(records: TrajectoryRecord[], record: TrajectoryRecord): void {
	records.push(record);
}

function flushTurn(
	turns: TrajectoryTurn[],
	records: TrajectoryRecord[],
	startedAt: number,
	id: string,
): void {
	if (records.length === 0) return;
	const endedCandidates = records
		.map((record) => record.endedAt)
		.filter((value): value is number => typeof value === "number");
	const inFlight = records.some((record) => record.endedAt === undefined);
	const endedAt = inFlight ? undefined : endedCandidates.length > 0 ? Math.max(...endedCandidates) : startedAt;
	turns.push({
		index: turns.length,
		id,
		startedAt,
		endedAt,
		inFlight,
		durationMs: endedAt !== undefined && endedAt >= startedAt ? endedAt - startedAt : undefined,
		records,
	});
}

function isPointKind(kind: TrajectoryRecordKind): boolean {
	return kind === "user" || kind === "process" || kind === "systemPrompt" || kind === "system" || kind === "error";
}

function recordAnchor(record: TrajectoryRecord): number {
	return (record.endedAt && record.endedAt > 0 ? record.endedAt : record.startedAt) || 0;
}

/**
 * 历史 JSONL 里 assistant/thinking 常只有结束时刻。用轮内上一条锚点回推区间。
 * 已有实测 duration（工具、live thinking）不覆盖；同一条消息拆出的 thinking
 * 若没有独立起止，把整段算在 assistant 上，避免两条各算一遍。
 */
function inferWorkDurations(turns: TrajectoryTurn[]): void {
	for (const turn of turns) {
		for (let index = 0; index < turn.records.length; index += 1) {
			const record = turn.records[index];
			if (isPointKind(record.kind) || record.durationMs !== undefined || record.endedAt === undefined) {
				continue;
			}
			if (record.kind !== "thinking" && record.kind !== "assistant") continue;

			const next = turn.records[index + 1];
			const sameStampAsAssistant =
				record.kind === "thinking" &&
				next?.kind === "assistant" &&
				next.startedAt === record.startedAt &&
				(record.endedAt === undefined || record.endedAt === record.startedAt);
			if (sameStampAsAssistant) continue;

			const prev = turn.records
				.slice(0, index)
				.reverse()
				.find((item) => {
					const at = recordAnchor(item);
					return at > 0 && at < record.startedAt;
				});
			const prevAt = prev ? recordAnchor(prev) : 0;
			// 历史 assistant 的 timestamp 是落盘时刻 ≈ 结束；优先用它，不要伸到下一个工具。
			const ownEnd = record.endedAt > record.startedAt ? record.endedAt : 0;
			const ownStamp = record.startedAt;
			const nextAt = next && next.startedAt > 0 ? next.startedAt : 0;
			const end = ownEnd || (prevAt > 0 && ownStamp > prevAt ? ownStamp : 0) || nextAt;
			const start = prevAt > 0 && prevAt < end ? prevAt : record.startedAt;
			if (!(end > start)) continue;
			record.startedAt = start;
			record.endedAt = end;
			record.durationMs = end - start;
		}

		const endedCandidates = turn.records
			.map((record) => record.endedAt)
			.filter((value): value is number => typeof value === "number");
		turn.inFlight = turn.records.some((record) => record.endedAt === undefined);
		if (!turn.inFlight && endedCandidates.length > 0) {
			turn.endedAt = Math.max(...endedCandidates);
			turn.durationMs = Math.max(0, turn.endedAt - turn.startedAt);
		}
	}
}

function processRecord(event: SessionProcessEvent, turnIndex: number): TrajectoryRecord {
	const startedAt = event.timestamp > 0 ? event.timestamp : 0;
	return {
		id: `process:${event.id}`,
		kind: "process",
		lane: "process",
		turnIndex,
		title: event.kind,
		summary: summarize(event.summary),
		startedAt,
		endedAt: startedAt || undefined,
		// 过程事件是时间点，没有可测区间；0 会在 UI 上伪装成「瞬间完成」。
		text: event.summary,
		detail: event.detail,
		processKind: event.kind,
		cwd: event.cwd,
		provider: event.provider,
		modelId: event.modelId,
		thinkingLevel: event.thinkingLevel,
		customType: event.customType,
		status: event.tokensBefore !== undefined ? String(event.tokensBefore) : undefined,
	};
}

function insertProcessEvents(turns: TrajectoryTurn[], events: SessionProcessEvent[]): void {
	if (events.length === 0) return;
	if (turns.length === 0) {
		const records = events.map((event) => processRecord(event, 0));
		flushTurn(turns, records, records[0]?.startedAt ?? 0, records[0]?.id ?? "process");
		return;
	}

	for (const event of events) {
		const at = event.timestamp > 0 ? event.timestamp : turns[0].startedAt;
		let target = 0;
		for (let index = 0; index < turns.length; index += 1) {
			const nextStart = turns[index + 1]?.startedAt;
			if (at >= turns[index].startedAt && (nextStart === undefined || at < nextStart)) {
				target = index;
				break;
			}
			if (at < turns[0].startedAt) {
				target = 0;
				break;
			}
			target = turns.length - 1;
		}
		const turn = turns[target];
		const record = processRecord({ ...event, timestamp: at }, turn.index);
		const insertAt = turn.records.findIndex((item) => item.startedAt > record.startedAt && record.startedAt > 0);
		if (insertAt === -1) turn.records.push(record);
		else turn.records.splice(insertAt, 0, record);
		if (record.startedAt > 0 && record.startedAt < turn.startedAt) turn.startedAt = record.startedAt;
	}
}

/**
 * 从 ChatMessage[] 构建轨迹。now 仅用于空会话兜底 domain，不写入 in-flight duration。
 */
export function buildTrajectory(
	messages: ChatMessage[],
	now = Date.now(),
	extras: TrajectoryBuildExtras = {},
): TrajectoryModel {
	const turns: TrajectoryTurn[] = [];
	let current: TrajectoryRecord[] = [];
	let turnStartedAt = 0;
	let turnId = "";
	let sawUser = false;

	const startTurn = (id: string, startedAt: number) => {
		if (current.length > 0) flushTurn(turns, current, turnStartedAt, turnId || current[0].id);
		current = [];
		turnId = id;
		turnStartedAt = startedAt;
	};

	for (const message of messages) {
		if (message.role === "user") {
			const initial = !sawUser;
			sawUser = true;
			startTurn(message.id, message.timestamp);
			pushRecord(current, {
				id: message.id,
				kind: "user",
				lane: laneOf("user"),
				turnIndex: turns.length,
				title: "user",
				summary: summarize(message.text),
				startedAt: message.timestamp,
				endedAt: message.timestamp,
				text: message.text,
				isInitialPrompt: initial || undefined,
			});
			continue;
		}

		if (current.length === 0) {
			turnId = message.id;
			turnStartedAt = message.timestamp;
		}

		if (message.role === "tool") {
			const startedAt = asNumber(message.meta?.startedAt) ?? message.timestamp;
			const durationMs = asNumber(message.meta?.durationMs);
			const inFlight = isInFlightTool(message);
			const name = toolNameOf(message);
			const endedAt = inFlight
				? undefined
				: durationMs !== undefined
					? startedAt + durationMs
					: message.timestamp;
			pushRecord(current, {
				id: message.id,
				kind: "tool",
				lane: laneOf("tool"),
				turnIndex: turns.length,
				title: name,
				summary: summarize(asString(message.meta?.detailText) || message.text || name),
				startedAt,
				endedAt,
				durationMs: inFlight ? undefined : durationMs,
				status: asString(message.meta?.status) ?? (message.meta?.isError ? "error" : "done"),
				toolName: name,
				toolCallId: asString(message.meta?.toolCallId),
				text: message.text,
				detail: asString(message.meta?.detailText) ?? asString(message.meta?.result),
			});
			continue;
		}

		if (message.role === "assistant") {
			if (message.thinking?.trim()) {
				const startedAt = message.thinkingStartedAt ?? message.timestamp;
				const hasSpan = message.thinkingStartedAt !== undefined && message.thinkingEndedAt !== undefined;
				const endedAt = isThinkingOnly(message) && isInFlightAssistant(message)
					? undefined
					: (message.thinkingEndedAt ?? message.timestamp);
				pushRecord(current, {
					id: `${message.id}:thinking`,
					kind: "thinking",
					lane: laneOf("thinking"),
					turnIndex: turns.length,
					title: "thinking",
					summary: summarize(message.thinking),
					startedAt,
					endedAt,
					// 缺起止时间就不要用同一条 message.timestamp 相减得出 0ms。
					durationMs: endedAt === undefined || !hasSpan ? undefined : Math.max(0, endedAt - startedAt),
					text: message.thinking,
				});
			}
			if (!isThinkingOnly(message)) {
				const inFlight = isInFlightAssistant(message);
				pushRecord(current, {
					id: message.id,
					kind: "assistant",
					lane: laneOf("assistant"),
					turnIndex: turns.length,
					title: "assistant",
					summary: summarize(message.text),
					startedAt: message.timestamp,
					endedAt: inFlight ? undefined : message.timestamp,
					status: message.stopReason,
					text: message.text,
				});
			}
			continue;
		}

		const kind: TrajectoryRecordKind = message.role === "error" ? "error" : "system";
		pushRecord(current, {
			id: message.id,
			kind,
			lane: laneOf(kind),
			turnIndex: turns.length,
			title: asString(message.meta?.type) ?? kind,
			summary: summarize(message.text),
			startedAt: message.timestamp,
			endedAt: message.timestamp,
			text: message.text,
			detail: asString(message.meta?.type),
		});
	}

	if (current.length > 0) flushTurn(turns, current, turnStartedAt, turnId || current[0].id);
	insertProcessEvents(turns, extras.processEvents ?? []);

	if (extras.systemPrompt?.trim()) {
		const promptRecord: TrajectoryRecord = {
			id: "system-prompt-reference",
			kind: "systemPrompt",
			lane: "process",
			turnIndex: 0,
			title: "systemPrompt",
			summary: summarize(extras.systemPrompt),
			startedAt: turns[0]?.startedAt ?? now,
			endedAt: turns[0]?.startedAt ?? now,
			text: extras.systemPrompt,
			detail: extras.systemPrompt,
		};
		if (turns.length === 0) {
			flushTurn(turns, [promptRecord], promptRecord.startedAt, promptRecord.id);
		} else {
			turns[0].records.unshift(promptRecord);
			turns[0].startedAt = Math.min(turns[0].startedAt, promptRecord.startedAt);
		}
	}

	inferWorkDurations(turns);

	const records = turns.flatMap((turn) =>
		turn.records.map((record) => ({ ...record, turnIndex: turn.index })),
	);
	const times = records.flatMap((record) => {
		const values = [record.startedAt];
		if (record.endedAt !== undefined) values.push(record.endedAt);
		return values;
	}).filter((value) => value > 0);
	const domainStart = times.length > 0 ? Math.min(...times) : now;
	const closedEnd = times.length > 0 ? Math.max(...times) : now;
	// domain 右端：有 in-flight 时伸到 now，让时间线开区间可见；账本本身仍不写 duration。
	const domainEnd = records.some((record) => record.endedAt === undefined)
		? Math.max(closedEnd, now)
		: closedEnd;

	return { turns, records, domainStart, domainEnd };
}

export type TrajectoryTimeRange = { start: number; end: number };

/** 区间过滤：与 span 有重叠即保留；无区间则全量。 */
export function filterRecordsByRange(
	records: TrajectoryRecord[],
	range: TrajectoryTimeRange | undefined,
): TrajectoryRecord[] {
	if (!range) return records;
	const lo = Math.min(range.start, range.end);
	const hi = Math.max(range.start, range.end);
	return records.filter((record) => {
		const start = record.startedAt;
		const end = record.endedAt ?? start;
		return end >= lo && start <= hi;
	});
}
