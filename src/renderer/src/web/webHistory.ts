/**
 * Web 历史分页是否还能再翻。
 * 游标存在 ref 里、首页失败、或只合并了 runtime 窗口时，
 * 不能把「没有 nextBefore」当成已经到顶——否则长会话滚到底/顶都看不到加载入口。
 */
export type WebHistoryMeta = {
	total: number;
	nextBefore: number | null;
	nextBeforeEntryId?: string;
	indexVersion?: string;
	status?: "ready" | "error";
};

export function hasMoreWebHistory(input: {
	meta?: WebHistoryMeta;
	loaded: boolean;
	catalogMessageCount?: number;
}): boolean {
	if (input.meta?.nextBefore != null) return true;
	// 首页已成功且游标到顶：短会话 / 已翻完。
	if (input.loaded && input.meta?.status === "ready") return false;
	// 尚未拉过首页，或首页失败：目录里有消息就仍应露出加载入口。
	const catalogCount = input.catalogMessageCount;
	if (typeof catalogCount === "number") return catalogCount > 0;
	return !input.loaded || input.meta?.status === "error";
}

/**
 * 点「加载更多」时能不能发请求。
 * 流式会先把会话标成 loaded，但不能因此把「还没拿到首页游标」当成到顶。
 */
export function canRequestWebHistoryPage(input: {
	loaded: boolean;
	meta?: WebHistoryMeta;
}): boolean {
	if (input.meta?.nextBefore != null) return true;
	if (input.meta?.status === "error") return true;
	if (!input.loaded) return true;
	// 流式提前标 loaded、首页还没回来：仍应拉尾页，而不是点了没反应。
	return input.meta?.status !== "ready";
}
