/**
 * 顶栏 / Tab 下拉是否还能停止当前 Agent。
 * error 不是终态：prompt 中断后进程常还在，只是状态打成 error。
 * 若把 error 排除，顶栏停止会灰掉，只剩侧栏「关闭 Agent」。
 */
export function canStopBoundAgent(status: string | undefined): boolean {
	return status === "running" || status === "idle" || status === "error";
}

/**
 * Tab 下拉「关闭会话」必须先真正停掉 Agent，再关 Tab。
 * pending / 无 runtime target 时 closeAgent 以前会静默 return，
 * 调用方却继续 closeTab，表现为标签没了、进程还在。
 */
export function shouldCloseSessionTabAfterStop(input: {
	pending: boolean;
	hasRuntimeTarget: boolean;
	stopSucceeded: boolean;
}): boolean {
	return !input.pending && input.hasRuntimeTarget && input.stopSucceeded;
}
