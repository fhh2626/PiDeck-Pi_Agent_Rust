import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import type { SessionProcessEvent } from "../../../shared/types/trajectory";
import {
	prependSessionHistoryPageAtom,
	prependSessionMessagePageAtom,
	sessionMessageCacheBySessionIdAtomFamily,
	type SessionMessageCacheEntry,
} from "../atoms";

/** 与时间线 runtime 翻页对齐：一次补 3 轮，复用同一份消息缓存。 */
const RUNTIME_HISTORY_TURN_PAGE_SIZE = 3;

const EMPTY_CACHE_ATOM = atom<SessionMessageCacheEntry | undefined>(undefined);

/**
 * 轨迹抽屉的数据源：只订本会话 cache family，把 runtime 历史前缀与窗口段拼成一条账本。
 * 翻页写回同一 atom，时间线与抽屉共享已加载历史，不另开 IPC 通道。
 */
export function useSessionTrajectorySource(sessionId: string | undefined) {
	const cachedEntry = useAtomValue(
		sessionId ? sessionMessageCacheBySessionIdAtomFamily(sessionId) : EMPTY_CACHE_ATOM,
	);
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [processEvents, setProcessEvents] = useState<SessionProcessEvent[]>([]);
	const [systemPrompt, setSystemPrompt] = useState<string | undefined>(undefined);
	const loadSequenceRef = useRef(0);
	const processSequenceRef = useRef(0);

	useEffect(() => {
		if (!sessionId) {
			setProcessEvents([]);
			return;
		}
		const sequence = ++processSequenceRef.current;
		void desktopApi.sessions.readProcessEvents(sessionId).then((events) => {
			if (processSequenceRef.current !== sequence) return;
			setProcessEvents(events);
		}).catch(() => {
			if (processSequenceRef.current === sequence) setProcessEvents([]);
		});
	}, [sessionId, cachedEntry?.revision, cachedEntry?.updatedAt]);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.prompts.list().then((result) => {
			if (cancelled) return;
			const prompt = result.templates.find((item) => item.name === "pi-system");
			setSystemPrompt(prompt?.content);
		}).catch(() => {
			if (!cancelled) setSystemPrompt(undefined);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const messages = useMemo(() => {
		if (!cachedEntry) return [];
		if (cachedEntry.source === "runtime" && cachedEntry.history) {
			return [...cachedEntry.history.messages, ...cachedEntry.messages];
		}
		return cachedEntry.messages;
	}, [cachedEntry]);

	const diskPage = cachedEntry?.source === "disk" ? cachedEntry.page : undefined;
	const runtimeHistory = cachedEntry?.source === "runtime" ? cachedEntry.history : undefined;
	const hasMore = diskPage
		? diskPage.nextBefore !== null
		: Boolean(
			cachedEntry?.source === "runtime" &&
			(runtimeHistory ? runtimeHistory.nextBefore !== null : (cachedEntry.windowStart ?? 0) > 0),
		);

	const loadMore = useCallback(() => {
		if (!sessionId || !cachedEntry || isLoadingMore) return;
		const sequence = ++loadSequenceRef.current;
		const expectedRevision = cachedEntry.revision;

		if (diskPage) {
			const before = diskPage.nextBefore;
			if (before === null) return;
			setIsLoadingMore(true);
			void desktopApi.sessions
				.readRecordMessagePage(sessionId, before, 100)
				.then((page) => {
					if (loadSequenceRef.current !== sequence) return;
					prependMessagePage({ sessionId, before, expectedRevision, page });
				})
				.finally(() => {
					if (loadSequenceRef.current === sequence) setIsLoadingMore(false);
				});
			return;
		}

		if (cachedEntry.source !== "runtime") return;
		const before = runtimeHistory?.nextBefore;
		const anchorMessage = !runtimeHistory
			? cachedEntry.messages.find((message) => typeof message.meta?.entryId === "string")
			: undefined;
		const anchorEntryId =
			typeof anchorMessage?.meta?.entryId === "string" ? anchorMessage.meta.entryId : undefined;
		const anchorFilePos = !runtimeHistory && !anchorEntryId
			? (typeof cachedEntry.windowStartFilePos === "number" ? cachedEntry.windowStartFilePos : undefined)
			: undefined;
		if (!runtimeHistory && !anchorEntryId && anchorFilePos === undefined) return;

		setIsLoadingMore(true);
		void desktopApi.sessions
			.readRecordMessagePage(
				sessionId,
				before ?? (anchorFilePos !== undefined ? anchorFilePos : undefined),
				RUNTIME_HISTORY_TURN_PAGE_SIZE,
				{
					unit: "turn",
					beforeEntryId: anchorEntryId ?? runtimeHistory?.nextBeforeEntryId ?? undefined,
				},
			)
			.then((page) => {
				if (loadSequenceRef.current !== sequence) return;
				prependHistoryPage({ sessionId, expectedRevision, before, page });
			})
			.finally(() => {
				if (loadSequenceRef.current === sequence) setIsLoadingMore(false);
			});
	}, [cachedEntry, diskPage, isLoadingMore, prependHistoryPage, prependMessagePage, runtimeHistory, sessionId]);

	return {
		messages,
		processEvents,
		systemPrompt,
		hasMoreMessages: hasMore,
		isLoadingMoreMessages: hasMore ? isLoadingMore : false,
		loadMore,
	};
}
