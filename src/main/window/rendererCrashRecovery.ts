/**
 * 渲染进程崩溃自动恢复守卫（2026-08 黑屏治理）。
 *
 * 背景：用户反馈黑屏 —— 渲染进程 OOM/崩溃后主进程只记日志、不恢复，窗口保持黑屏，
 * 只能手动重启。修复：非正常退出（crashed/oom/abnormal-exit 等）时由主进程自动 reload
 * 重拉渲染进程（主进程内 runtime/会话状态仍在，reload 后渲染层按启动逻辑恢复 tab，
 * 等价冷启动）。
 *
 * 守卫职责：崩溃风暴保护 —— 窗口期（60s）内最多自动恢复 2 次，超过则放弃，
 * 避免 OOM 后无限重启循环。clean-exit（正常退出）不恢复。
 */

export const RENDERER_CRASH_RECOVERY_WINDOW_MS = 60_000;
export const RENDERER_CRASH_MAX_RECOVERIES = 2;

export type RendererCrashRecoveryGuard = {
	/** 判断是否允许本次自动恢复；允许时记录本次崩溃时间戳（副作用）。 */
	shouldAutoReload(reason: string): boolean;
	/** 窗口期内已发生的自动恢复次数（日志用）。 */
	recoveriesInWindow(): number;
};

export function createRendererCrashRecoveryGuard(options: { now?: () => number } = {}): RendererCrashRecoveryGuard {
	const now = options.now ?? Date.now;
	const crashTimes: number[] = [];
	return {
		shouldAutoReload(reason) {
			// 正常退出（用户关窗/quit）不需要恢复
			if (reason === "clean-exit") return false;
			const current = now();
			// 只保留窗口期内的崩溃时间戳（原地复用数组，避免每次重建引用）
			const recent = crashTimes.filter((t) => current - t < RENDERER_CRASH_RECOVERY_WINDOW_MS);
			crashTimes.length = 0;
			crashTimes.push(...recent);
			if (recent.length >= RENDERER_CRASH_MAX_RECOVERIES) return false;
			crashTimes.push(current);
			return true;
		},
		recoveriesInWindow() {
			const current = now();
			return crashTimes.filter((t) => current - t < RENDERER_CRASH_RECOVERY_WINDOW_MS).length;
		},
	};
}
