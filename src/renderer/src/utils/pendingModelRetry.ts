const PENDING_MODEL_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;

/** 返回本次失败后的重试延迟；耗尽后交给调用方提示重启。 */
export function pendingModelRetryDelay(attempt: number): number | undefined {
	return PENDING_MODEL_RETRY_DELAYS_MS[attempt];
}
