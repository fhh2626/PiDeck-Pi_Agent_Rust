/** 用于拒绝旧 runtime 代数 UI 快照的最小运行实例身份。 */
export type RuntimeHandle = {
	agentId: string;
	runtimeGeneration: number;
};

/** 只有 Agent 与 runtime 代数都一致时，UI 快照才属于当前会话运行实例。 */
export function isCoherentComposerRuntimeUi(
	runtime: RuntimeHandle | undefined,
	runtimeUi: RuntimeHandle | undefined,
): boolean {
	return Boolean(
		runtime &&
		runtimeUi &&
		runtimeUi.agentId === runtime.agentId &&
		runtimeUi.runtimeGeneration === runtime.runtimeGeneration,
	);
}
