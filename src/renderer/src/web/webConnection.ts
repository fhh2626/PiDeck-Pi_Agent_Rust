/**
 * Web 连接态策略：轮询失败不能一次就变红，会话命令失败也不等于服务掉线。
 */

export const WEB_STATE_POLL_MS = 3_000;
export const WEB_DISCONNECT_FAILURES = 3;

export type WebConnectionSnapshot = {
	connected: boolean;
	failures: number;
};

/** 一次 /api/state 成功立刻恢复已连接。 */
export function markWebStateSuccess(): WebConnectionSnapshot {
	return { connected: true, failures: 0 };
}

/**
 * 轮询失败累计到阈值才断开。
 * 单次抖动（切网、锁屏、手机休眠）只记失败，不改已连接状态。
 */
export function markWebStateFailure(
	current: WebConnectionSnapshot,
	threshold = WEB_DISCONNECT_FAILURES,
): WebConnectionSnapshot {
	const failures = current.failures + 1;
	return {
		connected: failures >= threshold ? false : current.connected,
		failures,
	};
}
